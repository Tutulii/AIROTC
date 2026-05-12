import asyncio
import logging
import os
from agentotc.src.agentotc import AgentOTC, AgentOTCConfig

logging.basicConfig(level=logging.INFO)

async def run_test():
    try:
        print("=== Testing AgentOTC Python SDK ===")
        wallet_private_key = os.environ.get("AGENTOTC_TEST_WALLET_PRIVATE_KEY")
        if not wallet_private_key:
            raise RuntimeError("Set AGENTOTC_TEST_WALLET_PRIVATE_KEY to run this live SDK smoke test.")
        
        config = AgentOTCConfig(
            api_key=os.environ.get("AGENTOTC_TEST_API_KEY", "mk_test_123"),
            wallet_private_key=wallet_private_key,
            environment='localnet'
        )
        
        client = AgentOTC(config)

        def on_error(err):
            print(f"[SDK Event] Captured background error: {err}")
        
        client.on('system_error', on_error)

        print("Connecting...")
        await client.connect()
        print("✅ WebSocket Connected & Authenticated")

        print("Fetching offers...")
        offers = await client.offers.list(mode='sell', status='active')
        print(f"✅ Retrieved {len(offers)} active global offers.")
        
        await client.disconnect()
        print("✅ SDK Smoke Test Successful.")

    except Exception as e:
        print("❌ SDK Test Failed:")
        print(e)
        import sys
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(run_test())
