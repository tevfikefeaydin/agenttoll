// Sends the test agent wallet's full USDC balance back to the Base Account.
// Run it yourself:  node refund.mjs
import "dotenv/config";
import { createWalletClient, createPublicClient, http, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TO = "0xe55359021a6a22d8385b827405991c56075f56f8"; // your Base Account

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY);
const pub = createPublicClient({ chain: base, transport: http() });
const wallet = createWalletClient({ account, chain: base, transport: http() });

const balance = await pub.readContract({
  address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
});
console.log(`Test cuzdani: ${account.address}`);
console.log(`USDC bakiyesi: ${Number(balance) / 1e6}`);
if (balance === 0n) { console.log("Gonderilecek USDC yok."); process.exit(0); }

const hash = await wallet.writeContract({
  address: USDC, abi: erc20Abi, functionName: "transfer", args: [TO, balance],
});
console.log(`Gonderildi: ${Number(balance) / 1e6} USDC -> ${TO}`);
console.log(`BaseScan: https://basescan.org/tx/${hash}`);
