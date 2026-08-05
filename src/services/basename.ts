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

// Basenames is ENS-shaped, deployed on Base. Resolution is read-only, so a
// plain public client over the same RPC set the rest of the service uses.
const client = createPublicClient({
  chain: base,
  transport: fallback([
    http("https://mainnet.base.org"),
    http("https://base-rpc.publicnode.com"),
    http("https://base.llamarpc.com"),
  ]),
});

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

async function resolverFor(node: `0x${string}`) {
  const resolver = await client.readContract({
    address: REGISTRY,
    abi: registryAbi,
    functionName: "resolver",
    args: [node],
  });
  return resolver === ZERO ? null : resolver;
}

async function forward(input: string): Promise<BasenameResult> {
  const name = normalize(input);
  const node = namehash(name);
  const resolver = await resolverFor(node);
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

async function reverse(address: string): Promise<BasenameResult> {
  const addr = address.toLowerCase();
  const label = keccak256(stringToBytes(addr.slice(2)));
  const node = keccak256(encodePacked(["bytes32", "bytes32"], [BASE_REVERSE_NODE, label]));
  const resolver = await resolverFor(node);
  if (!resolver) {
    return { query: address, address: addr, name: null, hasPrimaryName: false, at: new Date().toISOString() };
  }
  const name = await client
    .readContract({ address: resolver, abi: resolverAbi, functionName: "name", args: [node] })
    .catch(() => null);
  return {
    query: address,
    address: addr,
    name: name || null,
    hasPrimaryName: Boolean(name),
    at: new Date().toISOString(),
  };
}

/**
 * Resolves either direction from one path: an 0x address returns its primary
 * basename, anything else is treated as a name and returns its address.
 */
export async function resolveBasename(query: string): Promise<BasenameResult> {
  if (!query?.trim()) badRequest("Pass a basename or an address");
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(query.trim());
  return cached<BasenameResult>(`basename:${query.trim().toLowerCase()}`, 60_000, () =>
    isAddress ? reverse(query.trim()) : forward(query),
  );
}

/** Primary basename for an address, or null. Used to enrich other endpoints. */
export async function primaryName(address: string): Promise<string | null> {
  try {
    const result = await reverse(address);
    return result.name ?? null;
  } catch {
    return null;
  }
}
