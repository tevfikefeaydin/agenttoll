import {
  createPublicClient,
  fallback,
  http,
  keccak256,
  namehash,
  encodePacked,
  stringToBytes,
  type Address,
} from "viem";
import { base } from "viem/chains";
import { cached } from "./cache.js";
import { badRequest } from "./errors.js";

const RPC_TIMEOUT_MS = 1_500;
const LOOKUP_TIMEOUT_MS = 6_000;

// One deadline covers every stage of a lookup, including response bodies and
// parallel text records. Each provider gets one attempt; fallback itself must
// not repeat the entire provider list after those attempts fail.
function resolverClient(signal: AbortSignal) {
  return createPublicClient({
    chain: base,
    transport: fallback(
      ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.meowrpc.com"].map((url) =>
        http(url, {
          timeout: RPC_TIMEOUT_MS,
          retryCount: 0,
          fetchFn: (input, init) => {
            const combined = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
            combined.throwIfAborted();
            return fetch(input, { ...init, signal: combined });
          },
        }),
      ),
      { retryCount: 0 },
    ),
  });
}

type ResolverClient = ReturnType<typeof resolverClient>;

async function withResolverDeadline<T>(load: (client: ResolverClient) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Basename resolution timed out");
      controller.abort(error);
      reject(error);
    }, LOOKUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([load(resolverClient(controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const REGISTRY = "0xB94704422c2a1E396835A571837Aa5AE53285a95" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";

// ENSIP-11: reverse records live under the chain's coinType, not "addr.reverse".
// Base is chain 8453, so coinType = 0x80000000 | 8453 = 0x80002105.
const BASE_REVERSE_NODE = namehash("80002105.reverse");

const registryAbi = [
  {
    name: "resolver",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
  {
    name: "owner",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
] as const;

const resolverAbi = [
  {
    name: "addr",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
  {
    name: "name",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ type: "string" }],
  },
  {
    name: "text",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "key", type: "string" },
    ],
    outputs: [{ type: "string" }],
  },
] as const;

const TEXT_KEYS = ["url", "description", "com.twitter", "com.github", "avatar"] as const;

// One shape for both directions, so callers can branch on `name`/`address`
// rather than on which way they happened to ask.
export interface BasenameResult {
  query: string;
  name: string | null;
  address: string | null;
  owner?: string | null;
  /** Set on name lookups: does the name have a resolver at all. */
  registered?: boolean;
  /** Set on address lookups: does the address have a primary name. */
  hasPrimaryName?: boolean;
  /** Reverse claims are shown only after a matching forward read on Base. */
  verification?: "verified" | "mismatch" | "unavailable" | "invalid-name" | "no-name";
  records?: Record<string, string>;
  resolver?: string;
  at: string;
}

/** Names may be given bare ("agenttoll") or fully qualified. */
function normalize(name: string): string {
  const trimmed = name.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed) badRequest("Empty name");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(trimmed)) {
    badRequest("Invalid name — letters, digits, hyphens and dots only");
  }
  return trimmed.endsWith(".base.eth") ? trimmed : `${trimmed}.base.eth`;
}

async function resolverFor(client: ResolverClient, node: `0x${string}`) {
  const resolver = await client.readContract({
    address: REGISTRY,
    abi: registryAbi,
    functionName: "resolver",
    args: [node],
  });
  return resolver === ZERO ? null : resolver;
}

async function forward(input: string, client: ResolverClient): Promise<BasenameResult> {
  const name = normalize(input);
  const node = namehash(name);
  const resolver = await resolverFor(client, node);
  if (!resolver) {
    return { query: input, name, address: null, registered: false, at: new Date().toISOString() };
  }

  const [address, owner, ...texts] = await Promise.all([
    client
      .readContract({ address: resolver, abi: resolverAbi, functionName: "addr", args: [node] })
      .catch(() => null),
    client
      .readContract({ address: REGISTRY, abi: registryAbi, functionName: "owner", args: [node] })
      .catch(() => null),
    ...TEXT_KEYS.map((key) =>
      client
        .readContract({ address: resolver, abi: resolverAbi, functionName: "text", args: [node, key] })
        .catch(() => ""),
    ),
  ]);

  const records: Record<string, string> = {};
  TEXT_KEYS.forEach((key, i) => {
    const value = texts[i];
    if (value) records[key] = value;
  });

  return {
    query: input,
    name,
    address: address && address !== ZERO ? address : null,
    owner,
    registered: true,
    records,
    resolver,
    at: new Date().toISOString(),
  };
}

async function reverse(address: string, client: ResolverClient): Promise<BasenameResult> {
  const addr = address.toLowerCase();
  const label = keccak256(stringToBytes(addr.slice(2)));
  const node = keccak256(encodePacked(["bytes32", "bytes32"], [BASE_REVERSE_NODE, label]));
  const result = (name: string | null, verification: NonNullable<BasenameResult["verification"]>): BasenameResult => ({
    query: address, address: addr, name, hasPrimaryName: name !== null, verification, at: new Date().toISOString(),
  });
  const resolver = await resolverFor(client, node);
  if (!resolver) {
    return result(null, "no-name");
  }
  const name = await client
    .readContract({ address: resolver, abi: resolverAbi, functionName: "name", args: [node] })
    .catch(() => null);
  if (name === null) return result(null, "unavailable");
  if (!name) return result(null, "no-name");
  // Do not append a suffix to a reverse claim: that would verify a different
  // name from the one returned by the reverse resolver.
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.base\.eth$/.test(name) || name.length > 255) {
    return result(null, "invalid-name");
  }
  try {
    const forwardNode = namehash(name);
    const forwardResolver = await resolverFor(client, forwardNode);
    if (!forwardResolver) return result(null, "mismatch");
    const resolved = await client.readContract({
      address: forwardResolver, abi: resolverAbi, functionName: "addr", args: [forwardNode],
    });
    return resolved !== ZERO && resolved.toLowerCase() === addr
      ? result(name, "verified")
      : result(null, "mismatch");
  } catch {
    return result(null, "unavailable");
  }
}

/**
 * Resolves either direction from one path: an 0x address returns its primary
 * basename, anything else is treated as a name and returns its address.
 */
export async function resolveBasename(query: string): Promise<BasenameResult> {
  if (!query?.trim()) badRequest("Pass a basename or an address");
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(query.trim());
  const normalized = isAddress ? query.trim().toLowerCase() : normalize(query);
  // Classification and identity are both part of the key: a name resembling
  // an address must never populate the cache used for verified reverse reads.
  return cached<BasenameResult>(`basename:${isAddress ? "reverse" : "forward"}:${normalized}`, 60_000, () =>
    withResolverDeadline((client) => isAddress ? reverse(query.trim(), client) : forward(query, client)),
  );
}

/** Primary basename for an address, or null. Used to enrich other endpoints. */
export async function primaryName(address: string): Promise<string | null> {
  try {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
    const result = await resolveBasename(address);
    return result.hasPrimaryName === true && result.verification === "verified" &&
      result.address?.toLowerCase() === address.toLowerCase() ? result.name ?? null : null;
  } catch {
    return null;
  }
}
