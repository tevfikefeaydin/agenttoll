# Documentation

## Current guides

- [Setup, API usage and examples](../README.md)
- [Monitoring, diagnostics, release checks and rollback](../OPERATIONS.md)
- [Security and payment boundaries](../SECURITY.md)
- [Hetzner deployment and monitoring](../deploy/hetzner/README.md)
- [Automatic deployment and recovery](../deploy/hetzner/AUTODEPLOY.md)
- [MCP installation and usage](../mcp/README.md)

## Historical records

Completed audit reports, implementation plans, screenshots and diagnostic logs
are available in [the documentation archive before cleanup](https://github.com/tevfikefeaydin/agenttoll/tree/5c7dd18e13144e35027d3d308e5433f7cf4df006/docs).
The September 8 [review](https://github.com/tevfikefeaydin/agenttoll/blob/5c7dd18e13144e35027d3d308e5433f7cf4df006/PROJECT_REVIEW_2026-09-08.md)
and [fix report](https://github.com/tevfikefeaydin/agenttoll/blob/5c7dd18e13144e35027d3d308e5433f7cf4df006/PROJECT_FIXES_2026-09-08.md)
are also retained in Git history.

The [published MCP 0.14.0 verification record](remediation/2026-09-14/ci-mcp-artifact/verification.json)
remains at its original path because the legacy MCP warning workflow reads its
version and package integrity. Deployment validation records remain with the
[deployment runbooks](../deploy/hetzner/README.md).
