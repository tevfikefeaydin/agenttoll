# Token safety evidence

Eight checks describe a token's evidence coverage, not the availability of the service or a guarantee of safety. A check is complete only when its required fields are known and consistent. Known risks remain visible even in incomplete checks.

## Free supplemental sources

When an explorer's contract-risk assessment is unavailable, [GoPlus Address Security](https://docs.gopluslabs.io/reference/addresscontractusingget_1) screens both the token and its reported creator on Base. Every supported flag and the malicious-contract count must be explicit before the fallback assessment is complete. Empty or malformed data stays unknown. Positive provider findings remain visible even when other fields are missing. Mixer, sanctions, reinitialization and suspicion flags prompt review; they are not presented as proof of fraud.

The legacy `deployer.flaggedScam` field retains the explorer's assessment. The independent assessments are in `supplementalEvidence.tokenAddressRisk` and `creatorAddressRisk`. Their subjects and provider names also appear in the check details and source status. These checks cannot establish that an address has never been involved in abuse. A honeypot-related address association prompts review; it does not mean that this token failed a buy/sell simulation.

For incomplete owner-permission data, [Sourcify API v2](https://docs.sourcify.dev/docs/api/) supplies verified ABI context, including at most one resolved proxy implementation. The response must identify the requested Base contract and a verified runtime match. Recognized method names are reported as interface evidence only. A method named `mint` does not establish who can call it, what it does, or whether other privileges exist. Neither presence nor absence of a method completes permission coverage.

For incomplete liquidity ownership, [DEX Screener](https://docs.dexscreener.com/api/reference) provides matching Base pools and their reported liquidity. Duplicate pools are removed; conflicting values are excluded. This is a provider-listed sample, not every pool on the chain. Market value cannot establish who owns liquidity positions, whether they are locked, or whether concentrated-liquidity positions can be withdrawn. The ownership check remains incomplete until that evidence exists.

## Operational limits

These sources require no new API key or paid subscription. Supplemental HTTP requests have three-second deadlines; the entire proxy/implementation lookup has a five-second shared deadline. They run alongside the existing creator lookup, inherit request cancellation and use the safety result's existing five-minute cache. Unavailable supplemental sources do not discard otherwise useful evidence.

Public output contains selected fields, fixed diagnostic categories and retrieval times. Provider response bodies, arbitrary metadata and error messages are not copied into the report. Retrieval time is not the provider's original observation time. All eight checks cannot be guaranteed for every token, particularly upgradeable contracts and liquidity positions without public ownership/lock coverage.
