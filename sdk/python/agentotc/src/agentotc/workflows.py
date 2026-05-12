import asyncio
from dataclasses import dataclass
from typing import Optional, Any, Dict, Union

from .deal import Deal
from .per import LivePerClient
from .types import OfferCreationParams, PrivateAgreementTerms, RollupTerms


@dataclass
class QuickBuyErOptions:
    offer_id: str
    max_price: float
    collateral: float
    timeout_ms: int = 180000


@dataclass
class QuickSellErOptions:
    offer: OfferCreationParams
    delivery_message: str
    timeout_ms: int = 180000


@dataclass
class QuickBuyPerOptions:
    offer_id: str
    terms: Union[PrivateAgreementTerms, RollupTerms, Dict[str, Any]]
    handoff_bundle: Optional[Dict[str, Any]] = None
    encrypted_terms: Optional[Dict[str, Any]] = None
    timeout_ms: int = 180000
    funding_timeout_ms: int = 180000
    delivery_timeout_ms: int = 180000
    settlement_timeout_ms: int = 240000


@dataclass
class QuickSellPerOptions:
    offer: OfferCreationParams
    terms: Union[PrivateAgreementTerms, RollupTerms, Dict[str, Any]]
    delivery_message: str
    handoff_bundle: Optional[Dict[str, Any]] = None
    encrypted_terms: Optional[Dict[str, Any]] = None
    timeout_ms: int = 180000
    funding_timeout_ms: int = 180000
    settlement_timeout_ms: int = 240000


@dataclass
class WorkflowResult:
    success: bool
    deal: Optional[Deal] = None
    offer_id: Optional[str] = None
    collateral_tx: Optional[str] = None
    payment_tx: Optional[str] = None
    error: Optional[str] = None


class WorkflowsNamespace:
    def __init__(self, client: "AgentOTC"):
        self.client = client
        self.per = LivePerClient(client)

    async def quick_buy_er(self, options: QuickBuyErOptions) -> WorkflowResult:
        try:
            await self.client.connect()
            deal = await self.client.offers.accept(options.offer_id)
            await deal.send_message(
                f"@middleman I agree to purchase at {options.max_price} SOL. "
                f"Collateral: {options.collateral} SOL each side."
            )
            await deal.wait_for_phase(["escrow_created", "awaiting_deposits"], timeout_ms=options.timeout_ms)
            collateral_tx = await deal.deposit_to_escrow(options.collateral, "buyer")
            await deal.wait_for_phase("delivery", timeout_ms=options.timeout_ms)
            payment_tx = await deal.deposit_to_escrow(options.max_price, "buyer")
            await deal.confirm_delivery()
            await deal.wait_for_phase(["completed", "settled"], timeout_ms=options.timeout_ms)
            return WorkflowResult(
                success=True,
                deal=deal,
                collateral_tx=collateral_tx,
                payment_tx=payment_tx,
            )
        except Exception as exc:
            return WorkflowResult(success=False, error=str(exc))

    async def quick_sell_er(self, options: QuickSellErOptions) -> WorkflowResult:
        try:
            await self.client.connect()
            offer = await self.client.offers.create(options.offer)
            deal = await self.client.wait_for_matched_deal(offer.id, timeout_ms=options.timeout_ms)
            await deal.wait_for_phase(["escrow_created", "awaiting_deposits"], timeout_ms=options.timeout_ms)
            collateral_tx = await deal.deposit_to_escrow(options.offer.collateral, "seller")
            await deal.wait_for_phase("delivery", timeout_ms=options.timeout_ms)
            await deal.send_message(options.delivery_message)
            await deal.wait_for_phase(["completed", "settled"], timeout_ms=options.timeout_ms)
            return WorkflowResult(
                success=True,
                deal=deal,
                offer_id=offer.id,
                collateral_tx=collateral_tx,
            )
        except Exception as exc:
            return WorkflowResult(success=False, error=str(exc))

    async def quick_buy_per(self, options: QuickBuyPerOptions = None, **kwargs) -> WorkflowResult:
        opts = options or QuickBuyPerOptions(**kwargs)
        try:
            await self.client.connect()
            deal = await self.client.offers.accept(opts.offer_id)
            await self.per.complete_private_agreement(
                deal.id,
                opts.terms,
                handoff_bundle=opts.handoff_bundle,
                encrypted_terms=opts.encrypted_terms,
                timeout_ms=opts.timeout_ms,
            )
            await self.per.fund_confidential_deal(deal.id, timeout_ms=opts.funding_timeout_ms)
            await self.per.approve_release(deal.id, timeout_ms=opts.delivery_timeout_ms)
            await deal.wait_for_phase(["completed", "settled"], timeout_ms=opts.settlement_timeout_ms)
            return WorkflowResult(success=True, deal=deal)
        except Exception as exc:
            return WorkflowResult(success=False, error=str(exc))

    async def quick_sell_per(self, options: QuickSellPerOptions = None, **kwargs) -> WorkflowResult:
        opts = options or QuickSellPerOptions(**kwargs)
        try:
            await self.client.connect()
            offer_params = opts.offer if isinstance(opts.offer, OfferCreationParams) else OfferCreationParams(**opts.offer)
            offer = await self.client.offers.create(
                OfferCreationParams(**{
                    **offer_params.model_dump(),
                    "rollupMode": "PER",
                    "privateMode": True,
                })
            )
            deal = await self.client.wait_for_matched_deal(offer.id, timeout_ms=opts.timeout_ms)
            await self.per.complete_private_agreement(
                deal.id,
                opts.terms,
                handoff_bundle=opts.handoff_bundle,
                encrypted_terms=opts.encrypted_terms,
                timeout_ms=opts.timeout_ms,
            )
            await self.per.fund_confidential_deal(deal.id, timeout_ms=opts.funding_timeout_ms)
            await deal.send_message(opts.delivery_message)
            await deal.wait_for_phase(["completed", "settled"], timeout_ms=opts.settlement_timeout_ms)
            return WorkflowResult(success=True, deal=deal, offer_id=offer.id)
        except Exception as exc:
            return WorkflowResult(success=False, error=str(exc))

    async def run_buyer_flow(self, *, mode: str, **kwargs) -> WorkflowResult:
        if mode.upper() == "ER":
            return await self.quick_buy_er(
                QuickBuyErOptions(
                    offer_id=kwargs["offer_id"],
                    max_price=kwargs["max_price"],
                    collateral=kwargs["collateral"],
                    timeout_ms=kwargs.get("timeout_ms", 180000),
                )
            )
        return await self.quick_buy_per(**kwargs)

    async def run_seller_flow(self, *, mode: str, **kwargs) -> WorkflowResult:
        if mode.upper() == "ER":
            return await self.quick_sell_er(
                QuickSellErOptions(
                    offer=kwargs["offer"],
                    delivery_message=kwargs["delivery_message"],
                    timeout_ms=kwargs.get("timeout_ms", 180000),
                )
            )
        return await self.quick_sell_per(**kwargs)
