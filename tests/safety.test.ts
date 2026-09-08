import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { getTokenSafety } from "../src/services/safety.js";

const CREATOR = "0x1111111111111111111111111111111111111111";
let nextToken = 1;

function cleanGoPlus(): Record<string, unknown> {
  return {
    token_name: "Measured Token", token_symbol: "TEST",
    is_honeypot: "0", cannot_buy: "0", cannot_sell_all: "0",
    buy_tax: "0", sell_tax: "0", is_open_source: "1",
    is_mintable: "0", transfer_pausable: "0", is_blacklisted: "0",
    slippage_modifiable: "0", personal_slippage_modifiable: "0",
    can_take_back_ownership: "0", hidden_owner: "0", selfdestruct: "0",
    trading_cooldown: "0", anti_whale_modifiable: "0", owner_change_balance: "0",
    creator_address: CREATOR, creator_percent: "0", holder_count: "100",
    holders: Array.from({ length: 10 }, () => ({ percent: "0.01", is_locked: 0, is_contract: 0 })),
    lp_holder_count: "1", lp_holders: [{ percent: "1", is_locked: 1 }],
  };
}

function cleanHoneypot(): Record<string, unknown> {
  return {
    token: { name: "Measured Token", symbol: "TEST", totalHolders: 100 },
    simulationSuccess: true,
    honeypotResult: { isHoneypot: false },
    simulationResult: { buyTax: 0, sellTax: 0 },
    contractCode: { openSource: true },
  };
}

async function safety(t: TestContext, fixture: {
  gp?: unknown; hp?: unknown; gpEnvelope?: unknown;
  code?: unknown; scam?: unknown; creator?: unknown;
} = {}) {
  const address = `0x${(nextToken++).toString(16).padStart(40, "0")}`;
  const gp = fixture.gp === undefined ? cleanGoPlus() : fixture.gp;
  const hp = fixture.hp === undefined ? cleanHoneypot() : fixture.hp;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.gopluslabs.io/")) {
      return gp === false ? new Response("Unavailable", { status: 503 }) :
        Response.json(fixture.gpEnvelope ?? { code: 1, result: { [address]: gp } });
    }
    if (url.startsWith("https://api.honeypot.is/")) {
      return hp === false ? new Response("Unavailable", { status: 503 }) : Response.json(hp);
    }
    if (url.startsWith("https://base.blockscout.com/api/v2/addresses/")) {
      return Response.json({ creator_address_hash: "creator" in fixture ? fixture.creator : CREATOR, is_scam: fixture.scam ?? false });
    }
    if (["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.meowrpc.com"].includes(url)) {
      const body = JSON.parse(String(init?.body));
      const result = body.method === "eth_getCode" ? (fixture.code ?? "0x6000") :
        body.method === "eth_getTransactionCount" ? "0x1e" : "0xde0b6b3a7640000";
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    }
    throw new Error(`Unexpected external request: ${url}`);
  });
  return getTokenSafety(address);
}

const check = (result: Awaited<ReturnType<typeof getTokenSafety>>, id: string) => {
  const found = result.checks.find((item) => item.id === id);
  assert.ok(found, `Missing check ${id}`);
  return found;
};

test("partial provider data cannot produce a clear verdict", async (t) => {
  const result = await safety(t, {
    gp: {
      token_name: "Partial Token", is_open_source: "1", buy_tax: "0",
      holder_count: "1", holders: [{ percent: null, is_locked: 0, is_contract: 0 }],
      creator_percent: null, lp_holder_count: "1", lp_holders: [{ percent: "1", is_locked: 1 }],
    },
    hp: { ...cleanHoneypot(), simulationResult: { buyTax: 0 } },
  });
  assert.equal(result.verdict, "insufficient-data");
  for (const id of ["owner-powers", "taxes", "concentration", "creator-stake"]) {
    assert.ok(result.unchecked.includes(id), `${id} must remain unchecked`);
    assert.equal(check(result, id).status, "unknown");
  }
});

test("fully measured clean data still passes with source and check coverage", async (t) => {
  const result = await safety(t);
  assert.equal(result.verdict, "clear");
  assert.deepEqual(result.unchecked, []);
  assert.deepEqual(result.coverage, { complete: true, completedChecks: 8, totalChecks: 8 });
  assert.ok(result.checks.every((item) => item.complete && item.sources.length > 0 && item.missing.length === 0));
  assert.ok(Number.isFinite(Date.parse(result.sourceStatus.goplus.fetchedAt)));
  assert.ok(result.sourceStatus.goplus.durationMs >= 0);
});

test("one measured high tax is reported as risk even when the other side is unknown", async (t) => {
  const result = await safety(t, {
    gp: { ...cleanGoPlus(), buy_tax: "0.2", sell_tax: null },
    hp: { ...cleanHoneypot(), simulationResult: { buyTax: 20 } },
  });
  assert.equal(result.verdict, "high-risk");
  assert.equal(check(result, "taxes").status, "fail");
  assert.equal(check(result, "taxes").complete, false);
  assert.ok(result.unchecked.includes("taxes"));
});

test("a known owner power stays visible alongside missing owner flags", async (t) => {
  const gp = cleanGoPlus();
  delete gp.hidden_owner;
  gp.is_mintable = "1";
  const result = await safety(t, { gp });
  assert.equal(check(result, "owner-powers").status, "warn");
  assert.match(check(result, "owner-powers").detail, /mint/);
  assert.ok(result.unchecked.includes("owner-powers"));
});

test("null, empty, nonnumeric and out-of-range percentages remain unknown", async (t) => {
  for (const value of [null, "", " ", true, [], {}, "Infinity", "-0.1", "1.1"]) {
    await t.test(JSON.stringify(value), async (sub) => {
      const result = await safety(sub, { gp: {
        ...cleanGoPlus(), creator_percent: value,
        holders: [{ percent: value, is_locked: 0, is_contract: 0 }], holder_count: "1",
        lp_holders: [{ percent: "0.8", is_locked: 1 }, { percent: value, is_locked: 0 }], lp_holder_count: "2",
      } });
      for (const id of ["creator-stake", "concentration", "liquidity"]) {
        assert.equal(check(result, id).status, "unknown", `${id} must reject ${JSON.stringify(value)}`);
        assert.ok(result.unchecked.includes(id));
      }
    });
  }
});

test("malformed collections cannot crash checks or count as a pass", async (t) => {
  const result = await safety(t, { gp: { ...cleanGoPlus(), holders: "bad", lp_holders: {} } });
  assert.equal(check(result, "concentration").status, "unknown");
  assert.equal(check(result, "liquidity").status, "unknown");
  assert.ok(result.sourceStatus.goplus.issues.includes("holders"));
  assert.ok(result.sourceStatus.goplus.issues.includes("lp_holders"));
});

test("malformed provider bodies are unavailable evidence rather than clean data", async (t) => {
  const result = await safety(t, { gp: [] });
  assert.notEqual(result.verdict, "clear");
  assert.ok(result.unchecked.includes("owner-powers"));
  assert.equal(result.sourceStatus.goplus.status, "invalid");
});

test("an unsuccessful GoPlus envelope cannot supply a clean token record", async (t) => {
  const result = await safety(t, { gpEnvelope: { code: 500, message: "failed", result: {} } });
  assert.equal(result.sourceStatus.goplus.status, "invalid");
  assert.ok(result.unchecked.includes("owner-powers"));
});

test("contradictory provider taxes preserve the higher measured risk", async (t) => {
  const result = await safety(t, { gp: { ...cleanGoPlus(), buy_tax: "0.2" } });
  assert.equal(check(result, "taxes").status, "fail");
  assert.equal(result.verdict, "high-risk");
  assert.ok(check(result, "taxes").conflicts.includes("buy-tax"));
});

test("an explicit unverified-source report cannot be masked by the other provider", async (t) => {
  const result = await safety(t, { hp: { ...cleanHoneypot(), contractCode: { openSource: false } } });
  assert.equal(check(result, "verified").status, "fail");
  assert.ok(check(result, "verified").conflicts.includes("open-source"));
});

test("a successful simulation without an explicit honeypot result is incomplete", async (t) => {
  const result = await safety(t, { hp: { ...cleanHoneypot(), honeypotResult: {} } });
  assert.notEqual(check(result, "honeypot").status, "pass");
  assert.ok(result.unchecked.includes("honeypot"));
});

test("taxes from a failed simulation do not turn missing static taxes into a pass", async (t) => {
  const result = await safety(t, {
    gp: { ...cleanGoPlus(), buy_tax: null, sell_tax: null },
    hp: { ...cleanHoneypot(), simulationSuccess: false },
  });
  assert.equal(check(result, "taxes").status, "unknown");
});

test("string zero holder flags still expose a movable majority", async (t) => {
  const result = await safety(t, { gp: { ...cleanGoPlus(), holder_count: "1",
    holders: [{ percent: "0.6", is_locked: "0", is_contract: "0" }],
  } });
  assert.equal(check(result, "concentration").status, "fail");
});

test("locked liquidity cannot conceal a different provider's withdrawable majority", async (t) => {
  const result = await safety(t, { gp: { ...cleanGoPlus(), lp_holder_count: "2",
    lp_holders: [{ percent: "0.5", is_locked: 1 }, { percent: "0.5", is_locked: 0 }],
  } });
  assert.equal(check(result, "liquidity").status, "fail");
});

test("truncated holder lists and impossible share totals are incomplete", async (t) => {
  const result = await safety(t, { gp: { ...cleanGoPlus(),
    holders: [{ percent: "0.01", is_locked: 0, is_contract: 0 }],
    lp_holder_count: "2", lp_holders: [{ percent: "0.8", is_locked: 1 }, { percent: "0.8", is_locked: 1 }],
  } });
  assert.equal(check(result, "concentration").status, "unknown");
  assert.equal(check(result, "liquidity").status, "unknown");
});

test("exhaustive holder and LP lists must account for the supply before passing", async (t) => {
  for (const fixture of [
    { id: "concentration", missing: "holder-share-total", fields: { holder_count: "1", holders: [{ percent: "0.01", is_locked: 0, is_contract: 0 }] } },
    { id: "liquidity", missing: "liquidity-share-total", fields: { lp_holder_count: "1", lp_holders: [{ percent: "0.01", is_locked: 1 }] } },
  ]) {
    await t.test(fixture.id, async (sub) => {
      const result = await safety(sub, { gp: { ...cleanGoPlus(), ...fixture.fields } });
      assert.equal(result.verdict, "insufficient-data");
      assert.equal(check(result, fixture.id).status, "unknown");
      assert.equal(check(result, fixture.id).complete, false);
      assert.ok(check(result, fixture.id).missing.includes(fixture.missing));
      assert.ok(result.unchecked.includes(fixture.id));
    });
  }
});

test("a complete small holder list and a top-ten LP sample can still pass", async (t) => {
  const result = await safety(t, { gp: { ...cleanGoPlus(),
    holder_count: "2", holders: [{ percent: "0.9", is_locked: 1, is_contract: 1 }, { percent: "0.1", is_locked: 0, is_contract: 0 }],
    lp_holder_count: "100", lp_holders: Array.from({ length: 10 }, () => ({ percent: "0.01", is_locked: 0 })),
  } });
  assert.equal(result.verdict, "clear");
  assert.equal(check(result, "concentration").complete, true);
  assert.equal(check(result, "liquidity").complete, true);
});

test("rounding individual shares cannot make an exhaustive distribution appear incomplete", async (t) => {
  // Nine 10.0049% shares plus one 9.9559% share total exactly 100%.
  const percentages = [...Array<string>(9).fill("0.100049"), "0.099559"];
  const result = await safety(t, { gp: { ...cleanGoPlus(),
    holder_count: "10", holders: percentages.map((percent) => ({ percent, is_locked: 1, is_contract: 1 })),
    lp_holder_count: "10", lp_holders: percentages.map((percent) => ({ percent, is_locked: 1 })),
  } });
  assert.equal(result.verdict, "clear");
  assert.deepEqual(result.unchecked, []);
});

test("malformed deployment code cannot produce a passed deployer check", async (t) => {
  const result = await safety(t, { code: "not-hex" });
  assert.notEqual(check(result, "deployer").status, "pass");
  assert.ok(result.unchecked.includes("deployer"));
});

test("a genuine honeypot signal survives missing fields and contradictory clean simulation", async (t) => {
  const result = await safety(t, { gp: { is_honeypot: "1" } });
  assert.equal(result.verdict, "high-risk");
  assert.ok(result.failed.includes("honeypot"));
  assert.ok(result.unchecked.includes("owner-powers"));
});

test("small valid fractions are preserved through numeric normalization", async (t) => {
  const result = await safety(t, { gp: { ...cleanGoPlus(), creator_percent: "0.0000000001" } });
  assert.equal(result.verdict, "clear");
  assert.equal(check(result, "creator-stake").status, "pass");
});

test("a scam flag survives a missing creator and the fallback creator lookup", async (t) => {
  const result = await safety(t, { creator: null, scam: true });
  assert.equal(result.verdict, "high-risk");
  assert.equal(check(result, "deployer").status, "fail");
});

test("a known explorer scam is still reported when the other safety providers are unavailable", async (t) => {
  const result = await safety(t, { gp: false, hp: false, scam: true });
  assert.equal(result.verdict, "high-risk");
  assert.ok(result.failed.includes("deployer"));
  assert.ok(result.unchecked.includes("owner-powers"));
});
