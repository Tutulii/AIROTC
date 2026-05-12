import aiohttp
from typing import List, Dict, Any, Optional
from urllib.parse import urlencode

from .errors import AuthenticationError, AgentOTCError
from .types import (
    OfferCreationParams, OfferData, TicketData, DealStatusData,
    NegotiationMessage, RegistrationResult, AgentProfile, WebhookConfig
)

class ApiClient:
    def __init__(self, api_url: str, api_key: str):
        self.api_url = api_url.rstrip('/')
        self.api_key = api_key
        
        # Share session if needed, but managing local session per request for simplicity first
        self._headers = {
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {self.api_key}',
            'User-Agent': 'AgentOTC-PY/1.0.0'
        }

    async def _request(self, method: str, endpoint: str, **kwargs) -> Any:
        url = f"{self.api_url}{endpoint}"
        headers = {**self._headers, **kwargs.pop('headers', {})}
        
        try:
            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.request(method, url, **kwargs) as response:
                    data = {}
                    try:
                        data = await response.json()
                    except Exception:
                        pass
                        
                    if not response.ok:
                        if response.status in (401, 403):
                            raise AuthenticationError(
                                data.get('error', f"Authentication failed with status {response.status}"),
                                data.get('details', response.reason)
                            )
                        raise AgentOTCError(f"API Request failed ({response.status}): {data.get('error', response.reason)}")
                        
                    return data
        except AgentOTCError:
            raise
        except Exception as e:
            raise AgentOTCError(f"Network or parsing error: {str(e)}")

    # --- Offers ---

    async def list_offers(self, asset: str = None, mode: str = None, status: str = None) -> List[OfferData]:
        params = {}
        if asset: params['asset'] = asset
        if mode: params['mode'] = mode
        if status: params['status'] = status
        
        qs = urlencode(params)
        endpoint = f"/v1/offers{'?' + qs if qs else ''}"
        
        res = await self._request("GET", endpoint)
        return [OfferData(**item) for item in res.get('data', [])]

    async def create_offer(self, params: OfferCreationParams) -> OfferData:
        res = await self._request("POST", "/v1/offers", json=params.model_dump())
        return OfferData(**res.get('data', {}))

    async def list_my_offers(self, status: str = None) -> List[OfferData]:
        params = {}
        if status:
            params["status"] = status
        qs = urlencode(params)
        endpoint = f"/v1/offers/mine{'?' + qs if qs else ''}"
        res = await self._request("GET", endpoint)
        return [OfferData(**item) for item in res.get("data", [])]

    async def get_offer(self, offer_id: str) -> OfferData:
        res = await self._request("GET", f"/v1/offers/{offer_id}")
        return OfferData(**res.get("data", {}))

    async def accept_offer(self, offer_id: str) -> TicketData:
        res = await self._request("POST", f"/v1/offers/{offer_id}/accept")
        return TicketData(**res.get('ticket', {}))

    # --- Tickets (Deals) ---

    async def get_messages(self, ticket_id: str) -> List[NegotiationMessage]:
        res = await self._request("GET", f"/v1/tickets/{ticket_id}/messages")
        return [NegotiationMessage(**item) for item in res.get('data', [])]

    async def send_message(self, ticket_id: str, content: str) -> NegotiationMessage:
        res = await self._request("POST", f"/v1/tickets/{ticket_id}/message", json={"content": content})
        return NegotiationMessage(**res.get('data', {}))

    async def get_deal_status(self, ticket_id: str) -> DealStatusData:
        res = await self._request("GET", f"/v1/tickets/{ticket_id}/deal-status")
        return DealStatusData(**res.get('data', {}))

    # --- Agent Registry ---

    @staticmethod
    async def register(api_url: str, wallet: str) -> RegistrationResult:
        """
        Register a new agent on the AgentOTC platform.
        This is a STATIC method because you don't have an API key yet —
        the API key is the OUTPUT of this call.

        Args:
            api_url: The base API URL (e.g. 'http://localhost:3000')
            wallet: The Solana wallet public key (base58) to register.

        Returns:
            RegistrationResult including the one-time API key if newly created.
        """
        url = f"{api_url.rstrip('/')}/v1/agents/register"
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json={"wallet": wallet}, headers={
                    'Content-Type': 'application/json',
                    'User-Agent': 'AgentOTC-PY/1.0.0'
                }) as response:
                    data = await response.json()
                    if not response.ok:
                        raise AgentOTCError(
                            f"Registration failed ({response.status}): {data.get('error', response.reason)}"
                        )
                    return RegistrationResult(**data)
        except AgentOTCError:
            raise
        except Exception as e:
            raise AgentOTCError(f"Registration network error: {str(e)}")

    async def get_agent_profile(self, wallet: str) -> AgentProfile:
        """Fetch the full reputation profile for any agent by wallet address."""
        res = await self._request("GET", f"/v1/agents/{wallet}")
        return AgentProfile(**res)

    async def configure_webhook(self, webhook_url: Optional[str], signature_payload: Dict[str, str]) -> WebhookConfig:
        """
        Configure the webhook URL for receiving push notifications about deal events.
        Set webhook_url to None to remove the webhook.
        Requires wallet signature authentication (Ed25519).
        """
        res = await self._request("PUT", "/v1/agents/webhook", json={
            "webhookUrl": webhook_url,
            **signature_payload
        })
        return WebhookConfig(**res)
