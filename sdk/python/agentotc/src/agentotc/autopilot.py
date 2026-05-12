import asyncio
import logging
from typing import Callable, Optional, Set, Coroutine

from .client import AgentOTC
from .deal import Deal

logger = logging.getLogger("AgentOTC.AutoBuyer")

class AutoBuyer:
    def __init__(self, client: AgentOTC):
        self.client = client
        self.running = False
        self.active_deal_ids: Set[str] = set()
        
        self.target_asset: str = ""
        self.max_price: float = 0.0
        self.max_collateral: float = 0.0
        self.poll_interval_ms: int = 60000
        
        self.on_match: Optional[Callable[[Deal], Coroutine]] = None
        self.on_success: Optional[Callable[[Deal], Coroutine]] = None
        self.on_error: Optional[Callable[[Exception], Coroutine]] = None

    async def start(self, 
                    target_asset: str, 
                    max_price: float, 
                    max_collateral: float, 
                    poll_interval_ms: int = 60000,
                    on_match: Callable[[Deal], Coroutine] = None,
                    on_success: Callable[[Deal], Coroutine] = None,
                    on_error: Callable[[Exception], Coroutine] = None):
        self.target_asset = target_asset
        self.max_price = max_price
        self.max_collateral = max_collateral
        self.poll_interval_ms = poll_interval_ms
        self.on_match = on_match
        self.on_success = on_success
        self.on_error = on_error
        
        self.running = True

        if not self.client.ws.is_connected:
            await self.client.connect()

        asyncio.create_task(self._poll_loop())

    def stop(self):
        self.running = False

    async def _poll_loop(self):
        while self.running:
            try:
                offers = await self.client.offers.list(asset=self.target_asset, mode='sell', status='active')
                
                for offer in offers:
                    if offer.price <= self.max_price and offer.collateral <= self.max_collateral:
                        # Non-blocking attempt
                        asyncio.create_task(self._attempt_purchase(offer.id))
                        
            except Exception as e:
                if self.on_error:
                    await self.on_error(e)
                else:
                    logger.error(f"[AutoBuyer] Loop error: {e}")
            
            await asyncio.sleep(self.poll_interval_ms / 1000.0)

    async def _attempt_purchase(self, offer_id: str):
        try:
            deal = await self.client.offers.accept(offer_id)
            
            if deal.id in self.active_deal_ids:
                return
            self.active_deal_ids.add(deal.id)

            if self.on_match:
                await self.on_match(deal)

            # 1. Agree
            await deal.send_message(f"@middleman I agree to purchase {self.target_asset} at {self.max_price} SOL.")
            
            # 2. Escrow
            await deal.wait_for_phase('wait_escrow')
            await deal.deposit_to_escrow(self.max_collateral, 'buyer')
            
            # 3. Delivery
            await deal.wait_for_phase('wait_delivery')
            await deal.deposit_to_escrow(self.max_price, 'buyer')

            # 4. Confirm
            await deal.confirm_delivery()
            await deal.wait_for_phase('completed')

            if self.on_success:
                await self.on_success(deal)

        except Exception as e:
            if self.on_error:
                await self.on_error(e)
            else:
                logger.error(f"[AutoBuyer] Deal {offer_id} failed: {e}")
