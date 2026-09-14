# MCP Registry discovery remediation

Follow-up to MCP-04, owned by `/root/mcp_remediation`, awaiting independent review and root's authorized workflow run. No npm or Registry publication, OIDC token request, commit, tag or production mutation was performed locally.

## Implementation

The npm release workflow now has a dependent Registry job. It cannot run until npm publication, byte-integrity comparison and the installed public consumer tests succeed. The new reusable `publish-mcp-registry.yml` also exposes a `workflow_dispatch` input for an existing `mcp-v<version>` tag. That path contains no npm publication or npm secret; it checks out the tagged commit and independently tests the already published npm package.

The narrow built-in Node API client validates the tag/version, canonical repository, namespace, package mcpName, package transport and public consumer evidence/hash. It compares the public npm metadata identity/repository/integrity before obtaining any OIDC credential. Its only writes are the official GitHub OIDC token exchange and one Registry publish request.

GitHub supplies a short-lived identity with audience `https://registry.modelcontextprotocol.io`. The official `/v0.1/auth/github-oidc` endpoint exchanges it for the short-lived Registry JWT; `/v0.1/publish` receives the tagged server metadata. Tokens stay in memory. Redirects are rejected, requests have 15-second deadlines, and error bodies or exception payloads from network calls are never logged.

Before publishing, the client checks the exact encoded namespace/version URL. If an identical active record already exists, it verifies it without authentication or a write. A conflicting record fails without overwrite. A write failure is never automatically retried; rerunning the Registry-only workflow starts with the exact-record check. After a successful write, a bounded read-only poll checks the publicly visible full server record and active state. Comparison normalizes only the official Go model's omission of false `isRequired`/`isSecret` environment-variable flags. Changed secrets, versions, descriptions, parameters, transport or other configuration fail.

The workflow uploads both fresh npm-consumer evidence and the verified public server record. Operator instructions are in `.github/workflows/README-mcp-registry.md`. Existing package source, package README and tested npm tarball bytes were preserved during this follow-up.

## Verification evidence

- Red: the new OIDC/public-record test failed against the unimplemented publishing entry point.
- Green: 22 synthetic API-flow tests pass, covering release guards, wrong public npm metadata, credential ordering and audience, full-record verification, omitted false flags, idempotent retry, conflicting records, error-body secrecy, one-write semantics, delayed visibility and unexpected credential endpoints.
- `npm run typecheck:tests` passed.
- `node --check scripts/mcp-registry-publish.mjs` passed.
- Both workflow YAML files parsed with PyYAML. Structural checks confirmed `registry.needs: publish`, reusable/manual triggers, contents-read/id-token-write permissions and no Registry-workflow secret references.
- The read-only exact public version lookup returned HTTP 404 at 2026-09-14T16:37:10.274Z. See `mcp-registry-before.json`.

No claim of actual Registry publication is made yet. Real GitHub OIDC exchange, official package ownership acceptance and postpublication public verification must run through the reviewed release workflow. Root should run the main tag workflow for the first release; if npm succeeds and Registry fails, dispatch **Publish verified MCP to official Registry** with that existing tag.

## Primary sources consulted

- [Official GitHub Actions publication guide](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/github-actions.mdx)
- [Official authentication and namespace guide](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/authentication.mdx)
- [Live official OpenAPI schema](https://registry.modelcontextprotocol.io/openapi.json)
- [Official publisher OIDC implementation](https://github.com/modelcontextprotocol/registry/blob/main/cmd/publisher/auth/github-oidc.go)
- [Official Registry JSON model](https://github.com/modelcontextprotocol/registry/blob/main/pkg/model/types.go)
