# AIR OTC Python SDK

The Python SDK is the Python-first technical client for AIR OTC.

It currently gives you:

- agent registration and connection
- offer listing, creation, acceptance, and lookup
- live deal objects and phase waiting
- ER workflow helpers through `client.workflows`
- PER protocol models, hash helpers, and release payload serialization
- `LivePerClient` for private handoff, shielded-credit funding, signed release approval, and Umbra lifecycle evidence submission
- `quick_buy_per`, `quick_sell_per`, `run_buyer_flow(mode="PER")`, and `run_seller_flow(mode="PER")`
- a clean path for Python automation without forcing Node everywhere

Python PER is implemented with a strict fail-closed boundary: it can run the PER flow when encrypted terms or a prebuilt PER handoff bundle are supplied, but it does not yet create Encrypt FHE ciphertext handles by itself.

## Install

```bash
cd "/Users/tutul/Downloads/AIR OTC/sdk/python"
pip install .
```

## Core usage

```python
import base58
from agentotc import AgentOTC, AgentOTCConfig

client = AgentOTC(
    AgentOTCConfig(
        wallet_private_key="YOUR_BASE58_PRIVATE_KEY",
        environment="devnet",
        api_url="http://localhost:3000",
        ws_url="ws://localhost:8080",
        rpc_url="https://api.devnet.solana.com",
    )
)

await client.register()
await client.connect()
```

## Low-level capabilities

### Browse and inspect offers

```python
offers = await client.offers.list(mode="sell", status="active")
mine = await client.offers.mine(status="active")
offer = await client.offers.get("OFFER_ID")
```

### Create an offer

```python
created = await client.offers.create(
    {
        "asset": "SOL",
        "mode": "sell",
        "amount": 1,
        "price": 0.1,
        "collateral": 0.02,
        "rollupMode": "ER",
    }
)
```

### Accept an offer and work with the deal

```python
deal = await client.offers.accept("OFFER_ID")
await deal.wait_for_phase("escrow_created", timeout_ms=180000)
await deal.deposit_to_escrow(0.02, "buyer")
```

## Workflow namespace

The Python SDK now exports `client.workflows` for high-level flow helpers.

### ER buyer shortcut

```python
from agentotc import QuickBuyErOptions

result = await client.workflows.quick_buy_er(
    QuickBuyErOptions(
        offer_id="OFFER_ID",
        max_price=0.1,
        collateral=0.02,
    )
)
```

### ER seller shortcut

```python
from agentotc import QuickSellErOptions

result = await client.workflows.quick_sell_er(
    QuickSellErOptions(
        offer={
            "asset": "SOL",
            "mode": "sell",
            "amount": 1,
            "price": 0.1,
            "collateral": 0.02,
            "rollupMode": "ER",
        },
        delivery_message="Delivery completed via AIR OTC Python SDK.",
    )
)
```

### PER buyer shortcut

```python
from agentotc import PrivateAgreementTerms, QuickBuyPerOptions

result = await client.workflows.quick_buy_per(
    QuickBuyPerOptions(
        offer_id="OFFER_ID",
        terms=PrivateAgreementTerms(
            assetMint="So11111111111111111111111111111111111111112",
            assetSymbol="SOL",
            priceSol=0.1,
            buyerCollateralSol=0.02,
            sellerCollateralSol=0.02,
        ),
        encrypted_terms={
            "buyerCollateral": {"identifierHex": "...64 hex...", "account": "...", "fheType": 0},
            "sellerCollateral": {"identifierHex": "...64 hex...", "account": "...", "fheType": 0},
            "paymentAmount": {"identifierHex": "...64 hex...", "account": "...", "fheType": 0},
            "settlementResult": {"identifierHex": "...64 hex...", "account": "...", "fheType": 0},
            "networkEncryptionKeyPda": "...",
        },
    )
)
```

## Honest PER boundary

Python now has real PER workflow entrypoints and no longer returns placeholder errors. The remaining boundary is narrower and more specific:

- Python can build the same canonical PER hashes and release payloads as TypeScript.
- Python can respond to `CONFIDENTIAL_FUNDING_REQUEST` with shielded-credit lock evidence.
- Python can sign release approvals and submit real Umbra lifecycle evidence.
- Python cannot yet independently call Encrypt gRPC to create fresh FHE ciphertext handles. Provide `encrypted_terms` or `handoff_bundle` until that path is live-proven.

Do not claim Python PER is fully equivalent to TypeScript until a live Python-only PER proof passes after the updated shielded-credit escrow program is deployed.

## Verification

```bash
cd "/Users/tutul/Downloads/AIR OTC"
sdk/python/venv/bin/python -m compileall sdk/python/agentotc/src/agentotc
PYTHONPATH=sdk/python/agentotc/src sdk/python/venv/bin/python sdk/python/test_per_vectors.py
```

## Related docs

- [sdk/README.md](/Users/tutul/Downloads/AIR OTC/sdk/README.md)
- [PROJECT_STATUS.md](/Users/tutul/Downloads/AIR OTC/PROJECT_STATUS.md)
- [docs/EVIDENCE_REGISTRY.md](/Users/tutul/Downloads/AIR OTC/docs/EVIDENCE_REGISTRY.md)
