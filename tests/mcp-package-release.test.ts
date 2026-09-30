import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("release verification rejects a changed tarball and a mismatched release tag", () => {
  const parent = realpathSync(tmpdir());
  const directory = mkdtempSync(path.join(parent, "mcp-artifact-guard-"));
  const tarball = path.join(directory, "agenttoll-mcp.tgz");
  const script = fileURLToPath(new URL("../scripts/mcp-package-smoke.mjs", import.meta.url));
  const verify = (tag: string) => spawnSync(process.execPath, [script, "--verify-artifact", directory], {
    encoding: "utf8", env: { ...process.env, RELEASE_TAG: tag }, timeout: 10_000,
  });
  try {
    writeFileSync(tarball, "synthetic archive bytes");
    writeFileSync(path.join(directory, "verification.json"), JSON.stringify({
      package: "agenttoll-mcp", version: "0.14.0", filename: "agenttoll-mcp.tgz",
      integrity: "sha512-" + createHash("sha512").update(readFileSync(tarball)).digest("base64"),
      consumer: { version: "0.14.0", cases: Array.from({ length: 7 }, (_, i) => ({ case: i })) },
    }));
    assert.equal(verify("mcp-v0.14.0").status, 0);
    const wrongTag = verify("mcp-v0.13.0");
    assert.notEqual(wrongTag.status, 0);
    assert.match(wrongTag.stderr, /mcp-v0\.13\.0/);
    writeFileSync(tarball, "changed archive bytes");
    const changed = verify("mcp-v0.14.0");
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /Verified tarball changed/);
  } finally {
    const resolved = realpathSync(directory);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith("mcp-artifact-guard-"));
    rmSync(resolved, { recursive: true, force: true });
  }
});
