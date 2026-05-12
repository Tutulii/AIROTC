import asyncio
import logging
import re
from typing import Callable, List, Union, Dict

import os
import json
from pathlib import Path

from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.instruction import Instruction, AccountMeta

from solders.system_program import TransferParams, transfer
from solders.transaction import Transaction
from solana.rpc.async_api import AsyncClient

from solders.transaction import Transaction
from solana.rpc.async_api import AsyncClient

from .api import ApiClient
from .ws import WsManager
from .errors import TimeoutError, PhaseViolationError, OnChainExecutionError
from .types import DealStatusData

logger = logging.getLogger("AgentOTC.Deal")

_IDL_PATH = Path(__file__).parent / "idl" / "escrow.json"
try:
    with open(_IDL_PATH, "r") as f:
        _IDL_RAW = json.loads(f.read())
        _prog_id_str = _IDL_RAW.get("address") or _IDL_RAW.get("metadata", {}).get("address") or "Hp6RbB21KrKQEaKvqAZPLHYYVDFKNJaiRtzE1494dpmx"
except Exception:
    _prog_id_str = "Hp6RbB21KrKQEaKvqAZPLHYYVDFKNJaiRtzE1494dpmx"
    
ESCROW_PROGRAM_ID = Pubkey.from_string(_prog_id_str)



class Deal:
    def __init__(
        self,
        ticket_id: str,
        api: ApiClient,
        ws: WsManager,
        rpc_url: str,
        keypair: Keypair,
        private_mode: bool = False,
        strict_opaque_per_mode: bool = True,
    ):
        self.id = ticket_id
        self.api = api
        self.ws = ws
        self.rpc_url = rpc_url
        self.keypair = keypair
        self.private_mode = private_mode
        self.strict_opaque_per_mode = strict_opaque_per_mode
        
        self.current_phase = 'created'
        self.escrow_address = None
        
        self._listeners: Dict[str, List[Callable]] = {}
        self._setup_ws_listeners()

    def _is_strict_opaque_per_mode(self) -> bool:
        return self.private_mode and self.strict_opaque_per_mode is not False

    def on(self, event: str, callback: Callable):
        if event not in self._listeners:
            self._listeners[event] = []
        self._listeners[event].append(callback)

    def emit(self, event: str, *args, **kwargs):
        for callback in self._listeners.get(event, []):
            try:
                if asyncio.iscoroutinefunction(callback):
                    asyncio.create_task(callback(*args, **kwargs))
                else:
                    callback(*args, **kwargs)
            except Exception as e:
                logger.error(f"Error in Deal event listener for {event}: {e}")

    def _setup_ws_listeners(self):
        def _handle_ws(msg: dict):
            # Filter
            payload = msg.get('payload', {})
            msg_ticket = msg.get('ticket_id') or payload.get('ticket_id')
            if msg_ticket != self.id:
                return

            phase = msg.get('phase') or payload.get('phase') or payload.get('to_phase')
            content = msg.get('content') or payload.get('content') or ''

            # Message
            if msg.get('type') in ('middleman_message', 'message') or msg.get('event_type') == 'middleman_message':
                self.emit('message_received', {"sender": msg.get('role', 'system'), "content": content, "phase": phase})

            # Phase
            if msg.get('event_type') == 'phase_changed' or phase:
                if phase and phase != self.current_phase:
                    self.current_phase = phase
                    self.emit('phase_changed', phase)

            # Escrow
            addr = msg.get('escrowAddress') or msg.get('dealId') or payload.get('dealId') or self._extract_address(content)
            if addr and addr != self.escrow_address:
                self.escrow_address = addr
                self.emit('escrow_ready', addr)

        self.ws.on('message', _handle_ws)

    def _extract_address(self, text: str) -> str:
        if not text: return None
        matches = re.search(r'`([1-9A-HJ-NP-Za-km-z]{32,44})`|\*\*([1-9A-HJ-NP-Za-km-z]{32,44})\*\*|([1-9A-HJ-NP-Za-km-z]{32,44})', text)
        if matches:
            return next((m for m in matches.groups() if m), None)
        return None

    # --- API ---

    async def refresh_status(self) -> DealStatusData:
        status = await self.api.get_deal_status(self.id)
        self.current_phase = status.phase
        if status.escrowAddress:
            self.escrow_address = status.escrowAddress
        return status

    async def wait_for_phase(self, target_phase: Union[str, List[str]], timeout_ms: int = None):
        targets = [target_phase] if isinstance(target_phase, str) else target_phase
        
        if self.current_phase in targets:
            return

        future = asyncio.get_running_loop().create_future()

        def _phase_listener(phase: str):
            if phase in targets and not future.done():
                future.set_result(True)

        self.on('phase_changed', _phase_listener)

        try:
            if timeout_ms:
                await asyncio.wait_for(future, timeout=timeout_ms / 1000.0)
            else:
                await future
        except asyncio.TimeoutError:
            raise TimeoutError(f"Waiting for phase {targets} timed out.", timeout_ms, str(targets))
        finally:
            if _phase_listener in self._listeners.get('phase_changed', []):
                self._listeners['phase_changed'].remove(_phase_listener)

    async def send_message(self, content: str):
        await self.api.send_message(self.id, content)

    async def deposit_to_escrow(self, amount_sol: float, role: str) -> str:
        if not self.escrow_address:
            await self.refresh_status()
            if not self.escrow_address:
                raise PhaseViolationError("Escrow address not assigned yet.", self.current_phase, "wait_escrow")

        async with AsyncClient(self.rpc_url) as client:
            target_pubkey = Pubkey.from_string(self.escrow_address)
            
            # Idempotency check
            recent_sigs = await client.get_signatures_for_address(target_pubkey, limit=10)
            if recent_sigs.value:
                for sig_info in recent_sigs.value:
                    if not sig_info.err:
                        tx_data = await client.get_transaction(sig_info.signature, max_supported_transaction_version=0)
                        if tx_data.value:
                            keys = tx_data.value.transaction.transaction.message.account_keys
                            for msg_key in keys:
                                if str(msg_key) == str(self.keypair.pubkey()) and msg_key.is_signer: # simplification: check if wallet signed the transaction matching escrow logic
                                    logger.info(f"[AgentOTC] Idempotency cache hit: Anchor execution already occurred on tx {sig_info.signature}")
                                    return str(sig_info.signature)

            # Exec Anchor Program natively
            try:
                config_pda, _ = Pubkey.find_program_address([b"config"], ESCROW_PROGRAM_ID)
                system_program = Pubkey.from_string("11111111111111111111111111111111")
                
                ix = None

                if self.current_phase == "wait_escrow":
                    ix = Instruction(
                        program_id=ESCROW_PROGRAM_ID,
                        data=bytes([161, 216, 135, 122, 12, 104, 211, 101]),
                        accounts=[
                            AccountMeta(pubkey=target_pubkey, is_signer=False, is_writable=True),
                            AccountMeta(pubkey=self.keypair.pubkey(), is_signer=True, is_writable=True),
                            AccountMeta(pubkey=config_pda, is_signer=False, is_writable=False),
                            AccountMeta(pubkey=system_program, is_signer=False, is_writable=False),
                        ]
                    )
                elif self.current_phase == "wait_delivery":
                    if role != "buyer":
                        raise PhaseViolationError("Only the buyer can lock payment", self.current_phase, "buyer execution")
                    ix = Instruction(
                        program_id=ESCROW_PROGRAM_ID,
                        data=bytes([170, 21, 188, 226, 187, 242, 186, 104]),
                        accounts=[
                            AccountMeta(pubkey=target_pubkey, is_signer=False, is_writable=True),
                            AccountMeta(pubkey=self.keypair.pubkey(), is_signer=True, is_writable=True),
                            AccountMeta(pubkey=config_pda, is_signer=False, is_writable=False),
                            AccountMeta(pubkey=system_program, is_signer=False, is_writable=False),
                        ]
                    )
                else:
                    raise PhaseViolationError("Cannot deposit in current phase", self.current_phase, "wait_escrow or wait_delivery")
                
                tx = Transaction().add(ix)
                result = await client.send_transaction(tx, self.keypair)
                sig = str(result.value)

                # Notify Middleman natively
                await self.ws.send({
                    "version": "1.0",
                    "type": "deposit_confirmed",
                    "ticket_id": self.id,
                    "role": role
                })
                
                return sig
            except Exception as e:
                raise OnChainExecutionError(f"Failed processing Anchor Smart Contract instruction: {str(e)}")

    async def confirm_delivery(self):
        if self._is_strict_opaque_per_mode():
            raise PhaseViolationError(
                "Strict opaque PER mode requires the signed release-approval protocol; confirm_delivery chat fallback is disabled.",
                self.current_phase,
                "signed_release_approval",
            )
        await self.send_message("@middleman I received the credentials. You can release the funds now.")

    async def complete_private_agreement(self, terms: dict, **kwargs):
        from .per import LivePerClient

        per = LivePerClient(self._client_ref) if hasattr(self, "_client_ref") else None
        if per is None:
            raise PhaseViolationError(
                "Deal.complete_private_agreement requires using client.workflows.per or LivePerClient directly.",
                self.current_phase,
                "LivePerClient",
            )
        return await per.complete_private_agreement(self.id, terms, **kwargs)

    # ─── ZK Privacy Mode ──────────────────────────────────

    async def commit_terms(self, terms: dict) -> dict:
        """
        Commit deal terms as a SHA-256 hash for privacy mode.
        
        Args:
            terms: dict with keys: price, collateral_buyer, collateral_seller, asset_type
            
        Returns:
            dict with termsHash (hex), termsHashBytes (list[int]), nonce (hex).
            SAVE THE NONCE — needed for reveal.
        """
        if self._is_strict_opaque_per_mode():
            raise PhaseViolationError(
                "Strict opaque PER mode does not allow plaintext commit/reveal endpoints. Use the private rollup handoff flow instead.",
                self.current_phase,
                "private_rollup_handoff",
            )
        res = await self.api._request("POST", f"/v1/deals/{self.id}/commit-terms", json=terms)
        return {
            "termsHash": res.get("termsHash"),
            "termsHashBytes": res.get("termsHashBytes", []),
            "nonce": res.get("nonce"),
        }

    async def reveal_terms(self, terms: dict, nonce: str) -> bool:
        """
        Reveal and verify terms post-settlement.
        
        Args:
            terms: dict with keys: price, collateral_buyer, collateral_seller, asset_type
            nonce: The nonce returned from commit_terms()
            
        Returns:
            True if the hash matches the on-chain commitment.
        """
        if self._is_strict_opaque_per_mode():
            raise PhaseViolationError(
                "Strict opaque PER mode does not allow plaintext commit/reveal endpoints. Use the private rollup handoff flow instead.",
                self.current_phase,
                "private_rollup_handoff",
            )
        payload = {**terms, "nonce": nonce}
        try:
            res = await self.api._request("POST", f"/v1/deals/{self.id}/reveal-terms", json=payload)
            return res.get("verified", False)
        except Exception as e:
            logger.warning(f"Reveal failed: {e}")
            return False

    async def get_privacy_status(self) -> dict:
        """Check the privacy status of this deal."""
        if self._is_strict_opaque_per_mode():
            raise PhaseViolationError(
                "Strict opaque PER mode does not expose legacy privacy-status endpoints.",
                self.current_phase,
                "private_rollup_handoff",
            )
        res = await self.api._request("GET", f"/v1/deals/{self.id}/privacy-status")
        return res
