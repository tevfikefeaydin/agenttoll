import { createPublicClient, http, namehash, keccak256, encodePacked, stringToBytes, toHex, getAddress } from 'viem';
import { base } from 'viem/chains';

const client = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') });

const REGISTRY = '0xB94704422c2a1E396835A571837Aa5AE53285a95';
const L2_RESOLVER = '0xC6d566A56A1aFf6508b41f6c90ff131615583BCD';
const REVERSE_REGISTRAR = '0x79EA96012eEa67A83431F1701B3dFf7e37F9E282';
const UPGRADEABLE_L2_RESOLVER_PROXY = '0x426fA03fB86E510d0Dd9F70335Cf102a98b10875';

const registryAbi = [
  { name: 'resolver', type: 'function', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { name: 'owner', type: 'function', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
];
const resolverAbi = [
  { name: 'addr', type: 'function', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'string' }] },
  { name: 'text', type: 'function', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }], outputs: [{ type: 'string' }] },
];
const reverseRegistrarAbi = [
  { name: 'node', type: 'function', stateMutability: 'view', inputs: [{ name: 'addr', type: 'address' }], outputs: [{ type: 'bytes32' }] },
  { name: 'reverseNode', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { name: 'defaultResolver', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];

const log = (...a) => console.log(...a);
const safe = async (label, fn) => { try { const r = await fn(); log(label, '=>', r); return r; } catch (e) { log(label, '=> ERROR:', String(e.message).split('\n')[0]); return null; } };

log('=== 1. coinType / reverse node derivation ===');
const coinTypeNum = (0x80000000 | base.id) >>> 0;
const coinTypeHex = coinTypeNum.toString(16);
log('chainId', base.id, 'coinType decimal', coinTypeNum, 'hex', coinTypeHex, 'upper', coinTypeHex.toUpperCase());
const baseReverseNodeLower = namehash(`${coinTypeHex}.reverse`);
const baseReverseNodeUpper = namehash(`${coinTypeHex.toUpperCase()}.reverse`);
log('namehash("80002105.reverse")      =', baseReverseNodeLower);
log('namehash("80002105.reverse") UPPER=', baseReverseNodeUpper);
log('lower === upper ?', baseReverseNodeLower === baseReverseNodeUpper);
log('namehash("addr.reverse")          =', namehash('addr.reverse'));

const onchainReverseNode = await safe('ReverseRegistrar.reverseNode()', () =>
  client.readContract({ address: REVERSE_REGISTRAR, abi: reverseRegistrarAbi, functionName: 'reverseNode' }));
log('MATCHES derived?', onchainReverseNode === baseReverseNodeLower);

log('\n=== 2. Forward resolution: agenttoll.base.eth ===');
const NAME = 'agenttoll.base.eth';
const node = namehash(NAME);
log('namehash =', node);
const resolverAddr = await safe('Registry.resolver(node)', () =>
  client.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'resolver', args: [node] }));
await safe('Registry.owner(node)', () =>
  client.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'owner', args: [node] }));
if (resolverAddr && resolverAddr !== '0x0000000000000000000000000000000000000000') {
  await safe('resolver.addr(node)', () =>
    client.readContract({ address: resolverAddr, abi: resolverAbi, functionName: 'addr', args: [node] }));
}
log('resolver === README L2Resolver?', resolverAddr === L2_RESOLVER, ' === Upgradeable proxy?', resolverAddr === UPGRADEABLE_L2_RESOLVER_PROXY);

log('\n=== 2b. control names ===');
for (const n of ['base.eth', 'jesse.base.eth', 'thisnamedefinitelydoesnotexist999.base.eth']) {
  const nn = namehash(n);
  const r = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'resolver', args: [nn] }).catch(() => 'ERR');
  let a = null;
  if (r && r !== '0x0000000000000000000000000000000000000000' && r !== 'ERR') {
    a = await client.readContract({ address: r, abi: resolverAbi, functionName: 'addr', args: [nn] }).catch(e => 'ERR:' + String(e.message).split('\n')[0]);
  }
  log(`${n} -> resolver=${r} addr=${a}`);
}

log('\n=== 3. Reverse resolution ===');
const TEST_ADDRS = [];
const jesseNode = namehash('jesse.base.eth');
const jr = await client.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'resolver', args: [jesseNode] }).catch(() => null);
if (jr && jr !== '0x0000000000000000000000000000000000000000') {
  const ja = await client.readContract({ address: jr, abi: resolverAbi, functionName: 'addr', args: [jesseNode] }).catch(() => null);
  if (ja) TEST_ADDRS.push(ja);
}
TEST_ADDRS.push('0x0000000000000000000000000000000000000001');

for (const addr of TEST_ADDRS) {
  log(`\n--- address ${addr} ---`);
  // derivation A: stringToBytes of lowercase hex without 0x
  const labelA = keccak256(stringToBytes(addr.toLowerCase().substring(2)));
  const nodeA = keccak256(encodePacked(['bytes32', 'bytes32'], [baseReverseNodeLower, labelA]));
  // derivation B: Base docs style keccak256(addressFormatted.substring(2)) -- non 0x-prefixed string
  let nodeB = null;
  try {
    const labelB = keccak256(addr.toLowerCase().substring(2));
    nodeB = keccak256(encodePacked(['bytes32', 'bytes32'], [baseReverseNodeLower, labelB]));
  } catch (e) { nodeB = 'ERR: ' + String(e.message).split('\n')[0]; }
  log('derived nodeA (stringToBytes) =', nodeA);
  log('derived nodeB (docs style)    =', nodeB);
  const onchainNode = await safe('ReverseRegistrar.node(addr)', () =>
    client.readContract({ address: REVERSE_REGISTRAR, abi: reverseRegistrarAbi, functionName: 'node', args: [addr] }));
  log('A matches onchain?', nodeA === onchainNode, '| B matches onchain?', nodeB === onchainNode);

  const revResolver = await safe('Registry.resolver(reverseNode)', () =>
    client.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'resolver', args: [nodeA] }));
  if (revResolver && revResolver !== '0x0000000000000000000000000000000000000000') {
    await safe('resolver.name(reverseNode)', () =>
      client.readContract({ address: revResolver, abi: resolverAbi, functionName: 'name', args: [nodeA] }));
  }
  // also try reading name() directly off the canonical L2Resolver
  await safe('L2Resolver.name(reverseNode) [direct]', () =>
    client.readContract({ address: L2_RESOLVER, abi: resolverAbi, functionName: 'name', args: [nodeA] }));
}

log('\n=== 4. ReverseRegistrar.defaultResolver ===');
await safe('defaultResolver()', () =>
  client.readContract({ address: REVERSE_REGISTRAR, abi: reverseRegistrarAbi, functionName: 'defaultResolver' }));

log('\n=== 5. viem built-ins with universalResolverAddress ===');
await safe('getEnsAddress(base.eth UR?)', async () => {
  return await client.getEnsAddress({ name: 'jesse.base.eth', universalResolverAddress: L2_RESOLVER });
});
await safe('base chain contracts (viem chain def)', async () => JSON.stringify(base.contracts));

log('\n=== 6. checksum sanity ===');
log('getAddress(REGISTRY)          =', getAddress(REGISTRY.toLowerCase()));
log('getAddress(L2_RESOLVER)       =', getAddress(L2_RESOLVER.toLowerCase()));
log('getAddress(REVERSE_REGISTRAR) =', getAddress(REVERSE_REGISTRAR.toLowerCase()));
