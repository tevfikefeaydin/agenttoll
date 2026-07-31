# Security Policy

## Reporting a vulnerability

Please open a private report via GitHub Security Advisories on this repository
(preferred), or open an issue titled "security" without technical details and
we will follow up privately. We aim to respond within 72 hours.

## Scope and design notes

- **No custody:** the server never holds funds or private keys. Payments settle
  wallet-to-wallet on Base via the x402 facilitator; the server only verifies
  settlement receipts.
- **No accounts, no secrets:** there are no API keys, sessions, or user
  databases to steal. The only server configuration is a public receiving
  address and public endpoint URLs.
- **Payment is the rate limit** for paid endpoints; free endpoints
  (`/api/health`, `/api/catalog`, `/api/demo`) are additionally rate limited
  per IP, and Vercel's platform DDoS protection sits in front of everything.
- **Upstream hardening:** all upstream data sources are called with hard
  timeouts and short-TTL caches; upstream failures return a 502 without
  leaking internals.
- **Input validation:** address-shaped inputs are strictly validated
  (`^0x[0-9a-fA-F]{40}$`); other inputs are URL-encoded before use.
- **Headers:** strict CSP, HSTS, nosniff, frame-deny on all responses.

## Known accepted risks

- `npm audit` reports advisories in transitive wallet-UI dependencies
  (Reown/WalletConnect) pinned inside the x402 SDK's dependency tree. These
  libraries are part of x402's optional browser paywall tooling and are not
  executed in this service's API request path. Tracked upstream; will be
  cleared when x402 updates its pins.

## Testnet phase

The service currently runs on Base Sepolia (testnet). No real funds are at
risk during this phase; mainnet migration will follow a further review.
