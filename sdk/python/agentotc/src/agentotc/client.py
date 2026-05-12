import asyncio
import re
import logging
from typing import Dict, List, Optional
from solders.keypair import Keypair

from .types import (
    AgentOTCConfig, OfferCreationParams, OfferData, DealStatusData,
    RegistrationResult, AgentProfile, WebhookConfig
)
from .api import ApiClient
from .ws import WsManager
from .deal import Deal
from .errors import AgentOTCError
from .workflows import WorkflowsNamespace

logger = logging.getLogger("AgentOTC.Client")

class OffersNamespace:
    def __init__(self, client):
        self.client = client

    async def list(self, asset: str = None, mode: str = None, status: str = None) -> List[OfferData]:
        return await self.client.api.list_offers(asset, mode, status)

    async def mine(self, status: str = None) -> List[OfferData]:
        return await self.client.api.list_my_offers(status)

    async def get(self, offer_id: str) -> OfferData:
        return await self.client.api.get_offer(offer_id)

    async def create(self, params: OfferCreationParams) -> OfferData:
        return await self.client.api.create_offer(params)

    async def accept(self, offer_id: str) -> Deal:
        ticket = await self.client.api.accept_offer(offer_id)
        return self.client.get_deal(ticket.id)

    async def wait_for_match(self, offer_id: str, timeout_ms: int = 180000, poll_interval_ms: int = 2000) -> Deal:
        return await self.client.wait_for_matched_deal(
            offer_id=offer_id,
            timeout_ms=timeout_ms,
            poll_interval_ms=poll_interval_ms,
        )


class AgentOTC:
    def __init__(self, config: AgentOTCConfig):
        self.config = self._normalize_config(config)
        import base58
        self.keypair = Keypair.from_bytes(base58.b58decode(self.config.wallet_private_key))
        
        self.api = ApiClient(self.config.api_url, self.config.api_key)
        self.ws = WsManager(self.config.ws_url, self.config.api_key)
        self.active_deals: Dict[str, Deal] = {}
        
        self.offers = OffersNamespace(self)
        self.agents = self._AgentsNamespace(self)
        self.workflows = WorkflowsNamespace(self)
        self.per = self.workflows.per
        
        # We will lazy initialize auto_buyer to avoid circular imports during init
        from .autopilot import AutoBuyer
        self.auto_buyer = AutoBuyer(self)

        self._setup_ws_global_routing()

    def _normalize_config(self, config: AgentOTCConfig) -> AgentOTCConfig:
        env = config.environment
        defaults = {
            'devnet': {
                'api_url': 'https://otc.yourdomain.com/v1',
                'ws_url': 'wss://otc.yourdomain.com/ws',
                'rpc_url': 'https://api.devnet.solana.com'
            },
            'mainnet': {
                'api_url': 'https://api.meridian.com/v1',
                'ws_url': 'wss://api.meridian.com/ws',
                'rpc_url': 'https://api.mainnet-beta.solana.com'
            },
            'localnet': {
                'api_url': 'http://localhost:3000',
                'ws_url': 'ws://localhost:3001',
                'rpc_url': 'http://localhost:8899'
            }
        }
        
        if env in defaults:
            if not config.api_url: config.api_url = defaults[env]['api_url']
            if not config.ws_url: config.ws_url = defaults[env]['ws_url']
            if not config.rpc_url: config.rpc_url = defaults[env]['rpc_url']
            
        return config

    def _setup_ws_global_routing(self):
        def _handle_msg(msg: dict):
            if msg.get('event_type') == 'ticket_created' or (msg.get('type') == 'middleman_message' and 'Trade Matched' in str(msg.get('content', ''))):
                ticket_id = msg.get('ticket_id') or msg.get('payload', {}).get('ticket_id') or self._extract_ticket_id(msg.get('content'))
                if ticket_id:
                    deal = self.get_deal(ticket_id)
                    self.ws.emit('deal_matched', deal)
                    
        self.ws.on('message', _handle_msg)

    def _extract_ticket_id(self, content: str) -> Optional[str]:
        if not content: return None
        match = re.search(r'TCK-[A-Z0-9]+', content)
        return match.group(0) if match else None

    async def connect(self):
        await self.ws.connect()
        
        for deal_id in self.active_deals.keys():
            await self.ws.send({
                "version": "1.0",
                "type": "status",
                "ticket_id": deal_id
            })

    async def disconnect(self):
        await self.ws.disconnect()

    def get_deal(self, ticket_id: str) -> Deal:
        if ticket_id not in self.active_deals:
            deal = Deal(
                ticket_id,
                self.api,
                self.ws,
                self.config.rpc_url,
                self.keypair,
                private_mode=self.config.private_mode,
                strict_opaque_per_mode=self.config.strict_opaque_per_mode,
            )
            deal._client_ref = self
            self.active_deals[ticket_id] = deal
        return self.active_deals[ticket_id]

    async def wait_for_matched_deal(
        self,
        offer_id: str = None,
        timeout_ms: int = 180000,
        poll_interval_ms: int = 2000
    ) -> Deal:
        deadline = asyncio.get_running_loop().time() + (timeout_ms / 1000.0)

        if offer_id:
            while asyncio.get_running_loop().time() < deadline:
                offer = await self.api.get_offer(offer_id)
                if offer.ticket and offer.ticket.get("id"):
                    return self.get_deal(offer.ticket["id"])
                await asyncio.sleep(poll_interval_ms / 1000.0)
            raise AgentOTCError(f"Waiting for offer {offer_id} to match timed out")

        future = asyncio.get_running_loop().create_future()

        def _on_matched(deal: Deal):
            if not future.done():
                future.set_result(deal)

        self.ws.on("deal_matched", _on_matched)
        return await asyncio.wait_for(future, timeout=timeout_ms / 1000.0)

    def on(self, event: str, callback):
        self.ws.on(event, callback)

    # --- Agents Namespace ---

    class _AgentsNamespace:
        """Namespace for agent registration, profile lookup, and webhook configuration."""

        def __init__(self, client: 'AgentOTC'):
            self._client = client

        async def profile(self, wallet: str) -> AgentProfile:
            """
            Look up any agent's full reputation profile by wallet address.
            Works for your own wallet or any other registered agent.

            Example:
                profile = await client.agents.profile('Gk7v...')
                print(profile.tier)         # 'elite'
                print(profile.trustSummary) # 'Flawless trading history.'
            """
            return await self._client.api.get_agent_profile(wallet)

        async def me(self) -> AgentProfile:
            """
            Get your own profile (derived from the wallet key used to initialize the SDK).

            Example:
                me = await client.agents.me()
                print(me.reputationScore)  # 85
            """
            return await self._client.api.get_agent_profile(
                str(self._client.keypair.pubkey())
            )

        async def configure_webhook(
            self,
            webhook_url: Optional[str],
            signature_payload: dict
        ) -> WebhookConfig:
            """
            Configure a webhook URL for receiving push notifications.
            Pass None to remove the webhook.
            Requires Ed25519 wallet signature for authentication.

            Returns:
                WebhookConfig including your HMAC secret for verifying payloads.
            """
            return await self._client.api.configure_webhook(webhook_url, signature_payload)

    # --- Static Factory Methods ---

    @staticmethod
    async def register(opts: dict) -> RegistrationResult:
        """
        Register a brand-new agent on the AgentOTC platform.

        This is the FIRST thing a new agent must call. It does NOT require
        an API key — the API key is RETURNED by this method.

        ⚠️ The returned api_key is shown ONCE. If you lose it, you cannot recover it.

        Args:
            opts: dict with keys:
                - wallet_private_key (str): Base58-encoded Solana private key.
                - environment (str, optional): 'devnet' | 'mainnet' | 'localnet'. Default 'devnet'.
                - api_url (str, optional): Custom API URL override.

        Example:
            from solders.keypair import Keypair
            import base58
            from agentotc import AgentOTC, AgentOTCConfig

            wallet = Keypair()
            result = await AgentOTC.register({
                'wallet_private_key': base58.b58encode(bytes(wallet)).decode(),
                'environment': 'devnet'
            })
            print(result.api_key)  # 'mk_abc123...' ← SAVE THIS!

            # Now create the authenticated client:
            client = AgentOTC(AgentOTCConfig(
                api_key=result.api_key,
                wallet_private_key=base58.b58encode(bytes(wallet)).decode(),
                environment='devnet'
            ))
            await client.connect()
        """
        import base58 as b58
        from solders.keypair import Keypair as Kp

        keypair = Kp.from_bytes(b58.b58decode(opts['wallet_private_key']))
        wallet = str(keypair.pubkey())

        env_defaults = {
            'devnet': 'https://otc.yourdomain.com',
            'mainnet': 'https://api.meridian.com',
            'localnet': 'http://localhost:3000'
        }
        api_url = opts.get('api_url') or env_defaults.get(opts.get('environment', 'devnet'))

        if not api_url:
            raise AgentOTCError('Cannot determine API URL. Provide api_url or a valid environment.')

        return await ApiClient.register(api_url, wallet)
