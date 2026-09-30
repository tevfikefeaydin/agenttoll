"""
Example: wrapping an AgentToll endpoint as a CrewAI tool.

Usage:
    1. pip install -r examples/requirements-crewai.txt (Python 3.10-3.13).
    2. Put a funded wallet key in .env as EVM_PRIVATE_KEY.
       Testnet USDC: https://faucet.circle.com (select Base Sepolia).
    3. python examples/crewai_tool.py

CheckTokenSafety wraps /api/base/safety/:address -- honeypot simulation,
taxes, owner privileges, holder concentration, and deployer history for a
Base token. Drop it into any CrewAI agent's tool list; the $0.003 USDC
payment uses a bounded x402 v2 client with a shared $1 session budget.
No API key, no separate billing step.

Hosted API: https://agenttoll.app
"""

from typing import Type

from crewai.tools import BaseTool
from dotenv import load_dotenv
from pydantic import BaseModel, Field
import threading

if __package__:
    from .bounded_payment import BoundedSafetyClient, PaymentError
else:
    from bounded_payment import BoundedSafetyClient, PaymentError

load_dotenv()

_client: BoundedSafetyClient | None = None
_client_lock = threading.Lock()


def _payment_client() -> BoundedSafetyClient:
    global _client
    with _client_lock:
        if _client is None:
            _client = BoundedSafetyClient.from_env()
        return _client


class CheckTokenSafetyInput(BaseModel):
    """Input schema for CheckTokenSafety."""

    address: str = Field(..., pattern=r"^0x[0-9a-fA-F]{40}$", description="Base token contract address (0x plus 40 hex digits)")


class CheckTokenSafety(BaseTool):
    name: str = "check_token_safety"
    description: str = (
        "Check whether a Base token is a honeypot or rug: simulated buy and sell, "
        "taxes, owner privileges, holder concentration, and deployer history. "
        "Costs at most $0.003 USDC on the configured network via x402, within a shared session budget (default $1)."
    )
    args_schema: Type[BaseModel] = CheckTokenSafetyInput

    def _run(self, address: str) -> str:
        client = _payment_client()
        res = client.fetch_with_payment(address)
        if not res.ok:
            raise PaymentError(f"AgentToll returned HTTP {res.status}; inspect the payment budget and wallet before retrying.")
        return res.text


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="CheckTokenSafety example with a bounded x402 payment client.")
    parser.add_argument("--quote-only", action="store_true", help="Inspect an unsigned quote without a private key or payment.")
    parser.add_argument("--budget", action="store_true", help="Inspect the shared session budget without making a request.")
    parser.add_argument("--address", default="0x940181a94a35a4569e4529a3cdfb74e38fd98631")
    args = parser.parse_args()
    import json
    client = _payment_client()
    if args.budget:
        print(json.dumps(client.get_payment_budget()))
    elif args.quote_only:
        print(json.dumps(client.get_payment_quote(args.address)))
    else:
        print(CheckTokenSafety()._run(args.address))
