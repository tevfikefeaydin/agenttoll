# MCP-RELEASE implementation evidence

Owner: `/root/mcp_remediation`; submitted for root and independent final review. No commit, tag, npm publication, registry publication or production mutation performed by this worker.

## Findings addressed

- MCP-01/02: package, lock, server metadata and generated handshake version are now 0.14.0. The package README explicitly identifies 0.14.0 as the minimum corrected version, explains the old archive mismatch and pins the startup example. A read-only npm registry lookup returned HTTP 404 for 0.14.0 before release.
- MCP-03: the old smoke only extracted under `mcp/node_modules/.cache`, inheriting repository dependencies. It now installs the actual tarball into a new OS temporary project after verifying no ancestor `node_modules` exists. The consumer SDK and wallet helpers also resolve from that fresh installation. Runtime dependencies resolved to MCP SDK 1.30.0, x402 core/evm/fetch 2.25.0 and viem 2.56.5, independently of the repository lock.
- MCP-05: all five contract/address tool schemas enforce `^0x[0-9a-fA-F]{40}$`; alert reference prices are positive and percentage thresholds nonnegative. Invalid input is rejected before HTTP.
- MCP-04 remains a separate release/discovery operation: the README now states that a local `server.json` does not establish an official public Registry listing. No registry publication is claimed here.
- All quote and paid calls identify this client using `X-AgentToll-Client: agenttoll-mcp/0.14.0`; the existing payment policy copies it to the signed retry. It contains no wallet identity or credential.

## Reproduction and verification

The source-level schema test failed before the change because the address pattern was undefined. The new independently installed tarball harness also failed on that same missing schema before the source fix. Both passed afterward.

`npm run smoke:mcp -- --registry-version 0.13.0` downloaded the old public package and failed the release gate with `Missing dist/payment-policy.js`. See `mcp-legacy-rejection.log`. The original read-only audit retains the stronger old stdio proofs (keyless startup failure, 21 tools, handshake 0.7.0, and rejected-policy signed retries).

Fresh commands, with the required project environment initialized in each PowerShell session:

```powershell
node --import tsx --test tests/mcp-package.test.ts tests/mcp-package-release.test.ts tests/payment.test.ts
npm run typecheck --prefix mcp
npm run build --prefix mcp
npm run smoke:mcp -- --artifact-dir docs/remediation/2026-09-14/mcp-artifact
npm run smoke:mcp -- --verify-artifact docs/remediation/2026-09-14/mcp-artifact
git diff --check
```

- 26 targeted tests passed, zero failures; MCP typecheck and build passed.
- Release-guard tests accept the original bytes and reject a changed tarball or mismatched tag.
- All seven actual stdio consumer cases passed. Keyless mode exposed 23 tools and handshake 0.14.0, returned a validated 0.001 USDC quote, and retained 1 USDC budget without a key. It also rejected malformed schema inputs without making HTTP requests.
- Zero budget, wrong recipient, 100x endpoint overcharge, 100 ms timeout and caller cancellation produced zero signed retries and no spent/reserved budget. Timeout returned in 121 ms; cancellation in 28 ms. Both aborted HTTP and rejected a fixture quote delivered afterward.
- A normal synthetic call used an ephemeral unfunded key, produced exactly one intercepted signed retry, and accounted for 0.001 USDC spent in memory. This is fixture accounting, not an onchain payment or real settlement.
- All subprocess fetches were fully replaced; outbound socket connects were prohibited. Events retain only type, client version and abort state, never a private key, signature or authorization payload.

Machine-readable proof: `mcp-artifact/verification.json`. Tested tarball SHA-512 integrity:

```text
sha512-Z2iq14geGkMjMMbwr+0SIQyW+4Xzw2sS5t9PohjkAXVJdO6rrFUSbgENZM1bbTNLGWlQernx2wULdvgmH0VhjA==
```

The tarball is retained locally for independent review. The workflow produces and uploads its own tested release archive; generated archives should be retained as artifacts rather than committed source.

## Release behavior and remaining limits

The tag workflow verifies an unused matching version, runs checks/build, packs once, fresh-installs and tests that archive, and records its integrity. It checks the hash immediately before `npm publish <tarball> --ignore-scripts --access public --provenance`, retaining existing NPM token authentication. After publication it downloads the explicit public version, requires byte-identical SHA-512 integrity, fresh-installs it and repeats all consumer scenarios. Both pre- and postpublication evidence are uploaded as workflow artifacts.

Publication and the postpublication registry-byte comparison cannot be exercised against 0.14.0 until the authorized root release occurs. No claim is made that npm or the official MCP Registry already serves the correction. These offline fixtures do not verify a real facilitator or upstream data response; root owns live unsigned checks and final release verification.
