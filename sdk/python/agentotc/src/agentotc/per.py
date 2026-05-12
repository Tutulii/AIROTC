import asyncio
import base64
import hashlib
import json
import time
from typing import Any, Dict, List, Optional, Union

from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.system_program import TransferParams, transfer
from solders.transaction import Transaction
from solana.rpc.async_api import AsyncClient

from .errors import AgentOTCError, PhaseViolationError, TimeoutError
from .types import (
    ConfidentialFundingRequest,
    ConfidentialFundingRole,
    EncryptedTerms,
    PerPrivateHandoffBundle,
    PrivateAgreementTerms,
    ReleaseApprovalCanonicalPayload,
    ReleaseApprovalRequest,
    RollupTerms,
    UmbraLifecyclePhase,
    UmbraLifecycleRequest,
)

LAMPORTS_PER_SOL = 1_000_000_000
DEFAULT_CONFIDENTIAL_ESCROW_PROGRAM_ID = "BuTf7gVrjD2wzKe4Tu1Ny2m7gC9SY65fRCY7gHnBgLqj"

_ACTION_CODES = {
    "APPROVE_SETTLEMENT": 0,
    "REVOKE_SETTLEMENT": 1,
    "CONFIRM_RELEASE": 2,
    "OPEN_DISPUTE": 3,
}
_ROLE_CODES = {"buyer": 0, "seller": 1}
_ROUTE_CODES = {"CONFIDENTIAL_ESCROW": 0}
_SETTLEMENT_POLICY_CODES = {"DIRECT": 0, "STEALTH": 1}


def _sha256_hex(value: Union[str, bytes]) -> str:
    data = value.encode("utf8") if isinstance(value, str) else value
    return hashlib.sha256(data).hexdigest()


def _normalize_hex32(value: str, field: str) -> str:
    normalized = value.lower().removeprefix("0x")
    if len(normalized) != 64 or any(ch not in "0123456789abcdef" for ch in normalized):
        raise ValueError(f"invalid_{field}")
    return normalized


def _u64_le(value: int) -> bytes:
    if value < 0:
        raise ValueError("u64 value cannot be negative")
    return int(value).to_bytes(8, "little", signed=False)


def _i64_le(value: int) -> bytes:
    return int(value).to_bytes(8, "little", signed=True)


def anchor_global_discriminator(name: str) -> bytes:
    return hashlib.sha256(f"global:{name}".encode("utf8")).digest()[:8]


def hash_identifier32(value: str) -> str:
    return _sha256_hex(value)


def compute_private_terms_hash(input: Dict[str, Any]) -> str:
    nonce = input.get("termsNonceHex")
    nonce_part = _normalize_hex32(nonce, "termsNonceHex") if nonce else "legacy-no-terms-nonce"
    normalized = ":".join(
        [
            str(input["sessionPda"]),
            str(input["assetMint"]),
            str(int(input["priceLamports"])),
            str(int(input["buyerCollateralLamports"])),
            str(int(input["sellerCollateralLamports"])),
            str(input.get("status") or "confidentialHandoff"),
            nonce_part,
        ]
    )
    return _sha256_hex(normalized)


def compute_funding_commitment_hash(input: Dict[str, Any]) -> str:
    normalized = json.dumps(
        {
            "amountLamports": str(int(input["amountLamports"])),
            "role": input["role"],
            "sessionPda": input["sessionPda"],
            "termsHash": _normalize_hex32(input["termsHash"], "termsHash"),
            "version": 1,
        },
        separators=(",", ":"),
    )
    return _sha256_hex(normalized)


def compute_settlement_plan_hash(input: Dict[str, Any]) -> str:
    normalized = json.dumps(
        {
            "buyerSettlementTarget": input["buyerSettlementTarget"],
            "policy": input["policy"],
            "sellerSettlementTarget": input["sellerSettlementTarget"],
        },
        separators=(",", ":"),
    )
    return _sha256_hex(normalized)


def serialize_release_approval_payload(payload: ReleaseApprovalCanonicalPayload) -> bytes:
    ticket_hash = bytes.fromhex(_normalize_hex32(payload.ticketIdHash, "ticketIdHash"))
    intent_hash = bytes.fromhex(_normalize_hex32(payload.intentIdHash, "intentIdHash"))
    terms_hash = bytes.fromhex(_normalize_hex32(payload.termsHash, "termsHash"))
    plan_hash = bytes.fromhex(_normalize_hex32(payload.planHash, "planHash"))
    deal = bytes(Pubkey.from_string(payload.dealPda))
    session = bytes(Pubkey.from_string(payload.sessionPda))
    return b"".join(
        [
            bytes([payload.version]),
            bytes([_ACTION_CODES[payload.action]]),
            ticket_hash,
            deal,
            session,
            intent_hash,
            bytes([_ROLE_CODES[payload.role]]),
            bytes([_ROUTE_CODES[payload.route]]),
            bytes([_SETTLEMENT_POLICY_CODES[payload.settlementPolicy]]),
            terms_hash,
            plan_hash,
            _u64_le(int(payload.nonce)),
            _i64_le(int(payload.expiresAt)),
            _i64_le(int(payload.timestamp)),
        ]
    )


def encode_release_approval_message_base64(payload: ReleaseApprovalCanonicalPayload) -> str:
    return base64.b64encode(serialize_release_approval_payload(payload)).decode("ascii")


def normalize_rollup_terms(terms: Union[PrivateAgreementTerms, RollupTerms, Dict[str, Any]]) -> RollupTerms:
    if isinstance(terms, RollupTerms):
        return terms
    if isinstance(terms, PrivateAgreementTerms):
        return RollupTerms(
            assetMint=terms.assetMint,
            assetSymbol=terms.assetSymbol,
            priceLamports=round(terms.priceSol * LAMPORTS_PER_SOL),
            quantity=terms.quantity,
            collateralBuyer=terms.buyerCollateralSol,
            collateralSeller=terms.sellerCollateralSol
            if terms.sellerCollateralSol is not None
            else terms.buyerCollateralSol,
        )
    data = dict(terms)
    if "priceSol" in data:
        return normalize_rollup_terms(PrivateAgreementTerms(**data))
    return RollupTerms(**data)


def derive_credit_vault_pda(program_id: Union[str, Pubkey]) -> Pubkey:
    program = Pubkey.from_string(program_id) if isinstance(program_id, str) else program_id
    return Pubkey.find_program_address([b"credit_vault"], program)[0]


def derive_credit_balance_pda(program_id: Union[str, Pubkey], vault: Pubkey, owner: Pubkey) -> Pubkey:
    program = Pubkey.from_string(program_id) if isinstance(program_id, str) else program_id
    return Pubkey.find_program_address([b"credit_balance", bytes(vault), bytes(owner)], program)[0]


def _funding_role_code(role: ConfidentialFundingRole) -> int:
    return {"buyer_payment": 0, "buyer_collateral": 1, "seller_collateral": 2}[role]


def derive_credit_lock_pda(
    program_id: Union[str, Pubkey],
    deal_pda: Pubkey,
    owner: Pubkey,
    role: ConfidentialFundingRole,
) -> Pubkey:
    program = Pubkey.from_string(program_id) if isinstance(program_id, str) else program_id
    return Pubkey.find_program_address(
        [b"credit_lock", bytes(deal_pda), bytes(owner), bytes([_funding_role_code(role)])],
        program,
    )[0]


def build_per_private_handoff_bundle(
    *,
    session_pda: str,
    asset_mint: str,
    price_lamports: int,
    buyer_collateral_lamports: int,
    seller_collateral_lamports: int,
    encrypted_terms: EncryptedTerms,
    asset_symbol: Optional[str] = None,
    status: str = "confidentialHandoff",
    terms_nonce_hex: Optional[str] = None,
) -> PerPrivateHandoffBundle:
    nonce = terms_nonce_hex or _sha256_hex(
        ":".join([session_pda, asset_mint, status, "per-handoff-bundle-v1"])
    )
    terms_hash = compute_private_terms_hash(
        {
            "sessionPda": session_pda,
            "assetMint": asset_mint,
            "priceLamports": price_lamports,
            "buyerCollateralLamports": buyer_collateral_lamports,
            "sellerCollateralLamports": seller_collateral_lamports,
            "status": status,
            "termsNonceHex": nonce,
        }
    )
    return PerPrivateHandoffBundle(
        version=1,
        sessionPda=session_pda,
        assetMint=asset_mint,
        assetSymbol=asset_symbol,
        termsNonceHex=nonce,
        termsHash=terms_hash,
        encryptedTerms=encrypted_terms,
        fundingCommitments={
            "buyerPaymentHash": compute_funding_commitment_hash(
                {
                    "sessionPda": session_pda,
                    "role": "buyer_payment",
                    "termsHash": terms_hash,
                    "amountLamports": price_lamports,
                }
            ),
            "buyerCollateralHash": compute_funding_commitment_hash(
                {
                    "sessionPda": session_pda,
                    "role": "buyer_collateral",
                    "termsHash": terms_hash,
                    "amountLamports": buyer_collateral_lamports,
                }
            ),
            "sellerCollateralHash": compute_funding_commitment_hash(
                {
                    "sessionPda": session_pda,
                    "role": "seller_collateral",
                    "termsHash": terms_hash,
                    "amountLamports": seller_collateral_lamports,
                }
            ),
        },
    )


class LivePerClient:
    def __init__(
        self,
        client: Any,
        *,
        confidential_escrow_program_id: Optional[str] = None,
    ):
        self.client = client
        self.program_id = Pubkey.from_string(
            confidential_escrow_program_id or DEFAULT_CONFIDENTIAL_ESCROW_PROGRAM_ID
        )
        self.funding_requests: Dict[str, ConfidentialFundingRequest] = {}
        self.release_requests: Dict[str, ReleaseApprovalRequest] = {}
        self.umbra_requests: Dict[str, UmbraLifecycleRequest] = {}
        self.private_terms: Dict[str, RollupTerms] = {}
        self.session_pdas: Dict[str, str] = {}
        self._waiters: Dict[str, List[asyncio.Future]] = {}
        self.client.ws.on("message", self._handle_message)

    def _emit_waiters(self, event: str, payload: Any) -> None:
        for future in self._waiters.pop(event, []):
            if not future.done():
                future.set_result(payload)

    def _handle_message(self, msg: Dict[str, Any]) -> None:
        payload = msg.get("payload") or {}
        ticket_id = msg.get("ticket_id") or payload.get("ticketId")
        if msg.get("type") in ("ROLLUP_SESSION_READY", "PER_SESSION_READY") and ticket_id:
            session_pda = payload.get("sessionPda") or msg.get("sessionPda")
            if session_pda:
                self.session_pdas[ticket_id] = session_pda
            self._emit_waiters(f"rollup:{ticket_id}", msg)
        if msg.get("type") == "CONFIDENTIAL_FUNDING_REQUEST" and payload.get("ticketId"):
            request = ConfidentialFundingRequest(**payload)
            self.funding_requests[request.ticketId] = request
            self._emit_waiters(f"funding:{request.ticketId}", request)
        if msg.get("type") == "RELEASE_APPROVAL_REQUEST" and payload.get("ticketId"):
            request = ReleaseApprovalRequest(**payload)
            self.release_requests[request.ticketId] = request
            self._emit_waiters(f"release:{request.ticketId}", request)
        if msg.get("type") == "UMBRA_LIFECYCLE_REQUEST" and payload.get("ticketId"):
            request = UmbraLifecycleRequest(**payload)
            self.umbra_requests[request.ticketId] = request
            self._emit_waiters(f"umbra:{request.ticketId}", request)

    async def _wait_for(self, event: str, timeout_ms: int) -> Any:
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._waiters.setdefault(event, []).append(future)
        try:
            return await asyncio.wait_for(future, timeout=timeout_ms / 1000)
        except asyncio.TimeoutError as exc:
            raise TimeoutError(f"Timed out waiting for {event}", timeout_ms, event) from exc

    async def wait_for_rollup_session_ready(self, ticket_id: str, timeout_ms: int = 120000) -> Dict[str, Any]:
        if ticket_id in self.session_pdas:
            return {"ticketId": ticket_id, "sessionPda": self.session_pdas[ticket_id]}
        await self.client.ws.send(
            {
                "version": "1.0",
                "type": "status",
                "ticket_id": ticket_id,
                "agent_id": str(self.client.keypair.pubkey()),
                "timestamp": int(time.time() * 1000),
            }
        )
        return await self._wait_for(f"rollup:{ticket_id}", timeout_ms)

    async def complete_private_agreement(
        self,
        ticket_id: str,
        terms: Union[PrivateAgreementTerms, RollupTerms, Dict[str, Any]],
        *,
        handoff_bundle: Optional[Union[PerPrivateHandoffBundle, Dict[str, Any]]] = None,
        encrypted_terms: Optional[Union[EncryptedTerms, Dict[str, Any]]] = None,
        timeout_ms: int = 120000,
    ) -> PerPrivateHandoffBundle:
        normalized = normalize_rollup_terms(terms)
        self.private_terms[ticket_id] = normalized
        await self.wait_for_rollup_session_ready(ticket_id, timeout_ms)
        session_pda = self.session_pdas.get(ticket_id)
        if not session_pda:
            raise PhaseViolationError("PER session did not provide sessionPda", "rollup", "sessionPda")

        if handoff_bundle is None:
            if encrypted_terms is None:
                raise AgentOTCError(
                    "Python PER needs encrypted_terms or a prebuilt handoff_bundle. "
                    "This prevents plaintext or fake FHE handoff data from entering strict PER."
                )
            encrypted = encrypted_terms if isinstance(encrypted_terms, EncryptedTerms) else EncryptedTerms(**encrypted_terms)
            handoff_bundle = build_per_private_handoff_bundle(
                session_pda=session_pda,
                asset_mint=normalized.assetMint,
                asset_symbol=normalized.assetSymbol,
                price_lamports=int(normalized.priceLamports),
                buyer_collateral_lamports=round(normalized.collateralBuyer * LAMPORTS_PER_SOL),
                seller_collateral_lamports=round(normalized.collateralSeller * LAMPORTS_PER_SOL),
                encrypted_terms=encrypted,
            )
        bundle = (
            handoff_bundle
            if isinstance(handoff_bundle, PerPrivateHandoffBundle)
            else PerPrivateHandoffBundle(**handoff_bundle)
        )
        await self.client.ws.send(
            {
                "version": "1.0",
                "type": "PER_PRIVATE_HANDOFF_READY",
                "ticket_id": ticket_id,
                "agent_id": str(self.client.keypair.pubkey()),
                "timestamp": int(time.time() * 1000),
                "bundle": bundle.model_dump(exclude_none=True),
            }
        )
        await self.client.ws.send(
            {
                "version": "1.0",
                "type": "ROLLUP_CONSENSUS_REACHED",
                "ticket_id": ticket_id,
                "agent_id": str(self.client.keypair.pubkey()),
                "timestamp": int(time.time() * 1000),
            }
        )
        return bundle

    async def wait_for_funding_request(self, ticket_id: str, timeout_ms: int = 120000) -> ConfidentialFundingRequest:
        if ticket_id in self.funding_requests:
            return self.funding_requests[ticket_id]
        return await self._wait_for(f"funding:{ticket_id}", timeout_ms)

    def _amount_for_role(self, ticket_id: str, role: ConfidentialFundingRole) -> int:
        terms = self.private_terms.get(ticket_id)
        if terms is None:
            raise AgentOTCError(f"Local private terms are required to fund {ticket_id}")
        if role == "buyer_payment":
            return int(terms.priceLamports)
        if role == "buyer_collateral":
            return round(terms.collateralBuyer * LAMPORTS_PER_SOL)
        if role == "seller_collateral":
            return round(terms.collateralSeller * LAMPORTS_PER_SOL)
        raise AgentOTCError(f"Unsupported funding role: {role}")

    async def _send_ix(self, rpc: AsyncClient, ix: Instruction, signers: List[Keypair]) -> str:
        blockhash_resp = await rpc.get_latest_blockhash()
        blockhash: Hash = blockhash_resp.value.blockhash
        tx = Transaction.new_signed_with_payer([ix], self.client.keypair.pubkey(), signers, blockhash)
        result = await rpc.send_transaction(tx)
        await rpc.confirm_transaction(result.value, commitment="confirmed")
        return str(result.value)

    async def _ensure_credit_vault_initialized(self, rpc: AsyncClient) -> Pubkey:
        vault = derive_credit_vault_pda(self.program_id)
        vault_info = await rpc.get_account_info(vault)
        if vault_info.value is not None:
            return vault

        init_ix = Instruction(
            self.program_id,
            anchor_global_discriminator("initialize_credit_vault"),
            [
                AccountMeta(vault, False, True),
                AccountMeta(self.client.keypair.pubkey(), True, True),
                AccountMeta(Pubkey.default(), False, False),
            ],
        )

        try:
            await self._send_ix(rpc, init_ix, [self.client.keypair])
            return vault
        except Exception as exc:
            detail = str(exc)
            maybe_concurrent_create = (
                "already in use" in detail
                or "custom program error: 0x0" in detail
                or '"Custom":0' in detail
            )
            if not maybe_concurrent_create:
                raise

            for _ in range(5):
                refreshed = await rpc.get_account_info(vault)
                if refreshed.value is not None:
                    return vault
                await asyncio.sleep(0.5)
            raise

    async def fund_confidential_deal(self, ticket_id: str, timeout_ms: int = 120000) -> List[str]:
        request = await self.wait_for_funding_request(ticket_id, timeout_ms)
        rail = request.fundingRail or "DIRECT_SOL"
        if rail == "DIRECT_SOL" and self.client.config.strict_opaque_per_mode:
            raise PhaseViolationError(
                "Strict PER rejected DIRECT_SOL funding. Use SHIELDED_CREDIT.",
                "funding",
                "SHIELDED_CREDIT",
            )

        signatures: List[str] = []
        async with AsyncClient(self.client.config.rpc_url) as rpc:
            if rail == "SHIELDED_CREDIT":
                vault = await self._ensure_credit_vault_initialized(rpc)

                total = sum(self._amount_for_role(ticket_id, item.fundingRole) for item in request.instructions)
                credit_balance = derive_credit_balance_pda(self.program_id, vault, self.client.keypair.pubkey())
                deposit_ix = Instruction(
                    self.program_id,
                    anchor_global_discriminator("deposit_sol_for_credit") + _u64_le(total),
                    [
                        AccountMeta(vault, False, True),
                        AccountMeta(credit_balance, False, True),
                        AccountMeta(self.client.keypair.pubkey(), True, True),
                        AccountMeta(Pubkey.default(), False, False),
                    ],
                )
                await self._send_ix(rpc, deposit_ix, [self.client.keypair])

                for item in request.instructions:
                    amount = self._amount_for_role(ticket_id, item.fundingRole)
                    deal_pda = Pubkey.from_string(request.dealPda)
                    credit_lock = derive_credit_lock_pda(
                        self.program_id,
                        deal_pda,
                        self.client.keypair.pubkey(),
                        item.fundingRole,
                    )
                    lock_ix = Instruction(
                        self.program_id,
                        anchor_global_discriminator("lock_credit_for_deal")
                        + bytes([_funding_role_code(item.fundingRole)])
                        + _u64_le(amount),
                        [
                            AccountMeta(vault, False, True),
                            AccountMeta(credit_balance, False, True),
                            AccountMeta(credit_lock, False, True),
                            AccountMeta(deal_pda, False, True),
                            AccountMeta(self.client.keypair.pubkey(), True, True),
                            AccountMeta(Pubkey.default(), False, False),
                        ],
                    )
                    signatures.append(await self._send_ix(rpc, lock_ix, [self.client.keypair]))
            else:
                for item in request.instructions:
                    amount = self._amount_for_role(ticket_id, item.fundingRole)
                    ix = Instruction(
                        self.program_id,
                        anchor_global_discriminator("deposit_encrypted")
                        + bytes([_funding_role_code(item.fundingRole)])
                        + _u64_le(amount),
                        [
                            AccountMeta(Pubkey.from_string(request.dealPda), False, True),
                            AccountMeta(self.client.keypair.pubkey(), True, True),
                            AccountMeta(Pubkey.default(), False, False),
                        ],
                    )
                    signatures.append(await self._send_ix(rpc, ix, [self.client.keypair]))

        await self.submit_confidential_funding_evidence(ticket_id, request.requestId, signatures)
        return signatures

    async def submit_confidential_funding_evidence(
        self,
        ticket_id: str,
        request_id: str,
        transaction_signatures: List[str],
    ) -> None:
        await self.client.ws.send(
            {
                "version": "1.0",
                "type": "CONFIDENTIAL_FUNDING_SUBMITTED",
                "ticket_id": ticket_id,
                "agent_id": str(self.client.keypair.pubkey()),
                "timestamp": int(time.time() * 1000),
                "requestId": request_id,
                "transactionSignatures": transaction_signatures,
            }
        )

    async def wait_for_release_request(self, ticket_id: str, timeout_ms: int = 120000) -> ReleaseApprovalRequest:
        if ticket_id in self.release_requests:
            return self.release_requests[ticket_id]
        return await self._wait_for(f"release:{ticket_id}", timeout_ms)

    async def approve_release(self, ticket_id: str, timeout_ms: int = 120000) -> None:
        request = await self.wait_for_release_request(ticket_id, timeout_ms)
        message = base64.b64decode(request.messageBase64)
        signature = self.client.keypair.sign_message(message)
        await self.client.ws.send(
            {
                "version": "1.0",
                "type": "RELEASE_APPROVAL_RESPONSE",
                "ticket_id": ticket_id,
                "agent_id": str(self.client.keypair.pubkey()),
                "timestamp": int(time.time() * 1000),
                "requestId": request.requestId,
                "signatureBase64": base64.b64encode(bytes(signature)).decode("ascii"),
            }
        )

    async def wait_for_umbra_lifecycle_request(self, ticket_id: str, timeout_ms: int = 120000) -> UmbraLifecycleRequest:
        if ticket_id in self.umbra_requests:
            return self.umbra_requests[ticket_id]
        return await self._wait_for(f"umbra:{ticket_id}", timeout_ms)

    async def submit_umbra_lifecycle_evidence(
        self,
        ticket_id: str,
        *,
        phase: UmbraLifecyclePhase,
        tx_signature: str,
        settlement_id: Optional[str] = None,
        role: Optional[str] = None,
        amount_lamports: Optional[Union[str, int]] = None,
        final_wallet: Optional[str] = None,
    ) -> None:
        if tx_signature == "sdk_fallback_tx":
            raise AgentOTCError("Umbra lifecycle evidence cannot use sdk_fallback_tx")
        request = self.umbra_requests.get(ticket_id)
        settlement = settlement_id or (request.settlementId if request else None)
        participant_role = role or (request.role if request else None)
        if not settlement or not participant_role:
            raise AgentOTCError(f"Umbra lifecycle request missing for {ticket_id}")
        await self.client.ws.send(
            {
                "version": "1.0",
                "type": "UMBRA_SETTLEMENT_SUBMITTED",
                "ticket_id": ticket_id,
                "agent_id": str(self.client.keypair.pubkey()),
                "timestamp": int(time.time() * 1000),
                "settlementId": settlement,
                "role": participant_role,
                "phase": phase,
                "txSignature": tx_signature,
                "amountLamports": str(amount_lamports) if amount_lamports is not None else None,
                "finalWallet": final_wallet,
            }
        )
