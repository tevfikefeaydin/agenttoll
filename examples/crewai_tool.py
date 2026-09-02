"""
Example: wrapping an AgentToll endpoint as a CrewAI tool.

Usage:
    1. pip install "x402[requests,evm]" crewai python-dotenv
    2. Put a funded wallet key in .env as EVM_PRIVATE_KEY.
       Testnet USDC: https://faucet.circle.com (select Base Sepolia).
    3. python examples/crewai_tool.py

CheckTokenSafety wraps /api/base/safety/:address -- honeypot simulation,
taxes, owner privileges, holder concentration, and deployer history for a
Base token. Drop it into any CrewAI agent's tool list; the $0.003 USDC
payment happens inline inside the request, via x402's requests integration.
No API key, no separate billing step.

Hosted API: https://agenttoll.app
"""

import os
from typing import Type

from crewai.tools import BaseTool
from dotenv import load_dotenv
from eth_account import Account
from pydantic import BaseModel, Field
from x402 import x402ClientSync
from x402.http.clients import x402_requests
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact.register import register_exact_evm_client

load_dotenv()

BASE_URL = os.getenv("AGENTTOLL_URL", "https://agenttoll.app")


def _paid_session():
    key = os.getenv("EVM_PRIVATE_KEY")
    if not key:
        raise RuntimeError("Set EVM_PRIVATE_KEY in .env to call AgentToll.")
    client = x402ClientSync().set_spend_controls({"max_amount_per_payment": "$0.05"})
    register_exact_evm_client(client, EthAccountSigner(Account.from_key(key)))
    return x402_requests(client)


class CheckTokenSafetyInput(BaseModel):
    """Input schema for CheckTokenSafety."""

    address: str = Field(..., description="Base token contract address, e.g. 0x1234...")


class CheckTokenSafety(BaseTool):
    name: str = "check_token_safety"
    description: str = (
        "Check whether a Base token is a honeypot or rug: simulated buy and sell, "
        "taxes, owner privileges, holder concentration, and deployer history. "
        "Costs $0.003, paid automatically in USDC on Base via x402 -- no API key."
    )
    args_schema: Type[BaseModel] = CheckTokenSafetyInput

    def _run(self, address: str) -> str:
        with _paid_session() as session:
            res = session.get(f"{BASE_URL}/api/base/safety/{address}")
            res.raise_for_status()
            return res.text


if __name__ == "__main__":
    # Standalone smoke test -- call it directly the way an agent would.
    tool = CheckTokenSafety()
    print(tool._run(address="0x940181a94a35a4569e4529a3cdfb74e38fd98631"))
