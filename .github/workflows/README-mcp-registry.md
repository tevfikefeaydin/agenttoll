# Official MCP Registry release

`publish-mcp.yml` calls `publish-mcp-registry.yml` only after npm publication and public tarball integrity/consumer verification have succeeded. The Registry workflow uses GitHub Actions OIDC (`id-token: write`); it has no npm publish command, no npm token and no new long-lived secret.

If npm succeeds but Registry publication or final verification fails, run **Publish verified MCP to official Registry** manually from GitHub Actions. Set `release_tag` to the existing tag, for example `mcp-v0.14.0`. This checks out the tagged source, freshly installs/tests the explicit public npm version, checks its namespace, repository and integrity, and publishes only the Registry record. It never republishes npm or changes package bytes.

An identical active record is verified without obtaining credentials or writing. A conflicting existing record fails for review. Failed writes are not automatically retried; the next registry-only run first checks whether the exact version is already visible. Public verification checks the full server configuration and active status, allowing only the official API's omission of false `isRequired`/`isSecret` fields.

Evidence is uploaded as `mcp-registry-<release_tag>` and includes the freshly installed consumer report and exact version URL/result. The helper keeps both OIDC and Registry tokens in memory, rejects redirects, bounds HTTP requests, and reports errors by stage/status without response bodies. No token is written to an artifact or console.

Official references consulted for this implementation:

- [GitHub Actions publishing and OIDC](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/github-actions.mdx)
- [Authentication and GitHub namespace ownership](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/authentication.mdx)
- [Deployed official API schema](https://registry.modelcontextprotocol.io/openapi.json)
- [Official publisher's OIDC audience and exchange](https://github.com/modelcontextprotocol/registry/blob/main/cmd/publisher/auth/github-oidc.go)
- [Official JSON model and omitted false-valued inputs](https://github.com/modelcontextprotocol/registry/blob/main/pkg/model/types.go)
