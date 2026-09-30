import assert from "node:assert/strict";
import { test } from "node:test";
import { getBaseTokenPrice } from "../src/services/basetoken.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

for (const [i, invalid] of ["0", "-1", "garbage", "Infinity", " ", null, true].entries()) {
  test(`invalid GeckoTerminal price ${i + 1} falls back to a finite positive quote`, async (t) => {
    const token = address(i + 1);
    const urls: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const url = String(input); urls.push(url);
      return Response.json(url.includes("geckoterminal")
        ? { data: { attributes: { token_prices: { [token]: invalid } } } }
        : { pairs: [{ chainId: "base", baseToken: { address: token }, priceUsd: "2", liquidity: { usd: 1000 } }] });
    });
    const result = await getBaseTokenPrice(token);
    assert.equal(result.usd, 2);
    assert.equal(result.source, "dexscreener");
    assert.equal(urls.length, 2);
    assert.ok(urls[1].includes("dexscreener"));
  });
}

test("a deepest nonfinite DexScreener quote cannot displace a valid price for the requested Base token", async (t) => {
  const token = address(20);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => Response.json(String(input).includes("geckoterminal") ? {}
    : { pairs: [
      { chainId: "base", baseToken: { address: token }, priceUsd: "Infinity", liquidity: { usd: 100000 } },
      { chainId: "base", baseToken: { address: token }, priceUsd: "0", liquidity: { usd: 10000 } },
      { chainId: "ethereum", baseToken: { address: token }, priceUsd: "900", liquidity: { usd: 100000 } },
      { chainId: "base", baseToken: { address: address(21) }, priceUsd: "800", liquidity: { usd: 100000 } },
      { chainId: "base", baseToken: { address: token }, priceUsd: "3", liquidity: { usd: 100 } },
      { chainId: "base", baseToken: { address: token }, priceUsd: "4", liquidity: { usd: 1000 } },
    ] }));
  assert.equal((await getBaseTokenPrice(token)).usd, 4);
});

test("unavailable prices reject without caching a successful response, then a valid retry succeeds", async (t) => {
  const token = address(30);
  let valid = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => Response.json(String(input).includes("geckoterminal")
    ? { data: { attributes: { token_prices: { [token]: valid ? "5" : "0" } } } }
    : { pairs: [{ chainId: "base", baseToken: { address: token }, priceUsd: "Infinity" }] }));
  await assert.rejects(getBaseTokenPrice(token), /Upstream data is unavailable/);
  valid = true;
  const result = await getBaseTokenPrice(token);
  assert.equal(result.usd, 5);
  assert.equal(result.source, "geckoterminal");
});
