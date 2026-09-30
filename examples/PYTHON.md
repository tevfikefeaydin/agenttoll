The CrewAI example uses a Python x402 v2 client restricted to the registered token
safety endpoint. Its price ceiling is 0.003 USDC and its shared in-memory session
budget defaults to 1 USDC. All tool instances imported from `crewai_tool` share
one client and budget. Concurrent requests reserve budget atomically. Restarting
the process resets the budget; this is not a wallet-wide spending control.

Use Python 3.10–3.13 and install the pinned dependencies:

```sh
python -m venv .venv
.venv/bin/pip install -r examples/requirements-crewai.txt
.venv/bin/python examples/crewai_tool.py --budget
.venv/bin/python examples/crewai_tool.py --quote-only
```

Quote and budget inspection need no private key. Set `EVM_PRIVATE_KEY` (or
`AGENT_PRIVATE_KEY`) to enable payments. The hosted API requires Base mainnet
USDC. For a local server, set `AGENTTOLL_URL=http://localhost:4021`, the receiving
`AGENTTOLL_RECIPIENT` (or the local server's public `ADDRESS`), and
`AGENTTOLL_NETWORK=base-sepolia`. A remote custom origin always requires an explicit
trusted `AGENTTOLL_RECIPIENT`; quotes cannot establish that trust.
Remote payment origins require HTTPS; HTTP is accepted only for localhost,
127.0.0.1 or ::1.

`AGENTTOLL_BUDGET_USDC` changes the session budget;
`AGENTTOLL_MAX_PER_CALL_USDC` can lower the registered 0.003 USDC ceiling;
`AGENTTOLL_TIMEOUT_MS` sets the total deadline (default 30000, range 1–300000).
Redirects are rejected. Quotes must match the exact requested resource, configured
network, receiver, network-specific USDC contract and signing domain. Only bounded
EIP-3009 authorizations are signed; server extensions cannot request other signatures.

HTTP deadlines cover quote, signing, retry and response body. A caller can pass a
`threading.Event` as the helper's `cancellation` argument. Pending signatures and
signed failures remain reserved: inspect `get_payment_budget()`, the wallet and
receipt before retrying. Do not recreate a client to bypass an ambiguous reservation.
Python cannot forcibly interrupt every DNS or signing library operation; daemon
workers let callers return at the deadline, and late work cannot submit a payment
after cancellation/timeout. Responses are buffered with a 4 MiB limit.

Offline regression tests install only the small client requirements and stub the
CrewAI host class while exercising real EVM signatures and the actual tool callback:

```sh
.venv/bin/pip install -r examples/requirements-payment.txt
.venv/bin/python -m unittest discover -s tests/python -p 'test_*.py' -v
```
