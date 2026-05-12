from typing import Optional, Literal, Dict, Any, List
from pydantic import BaseModel, ConfigDict
from datetime import datetime

class AgentOTCConfig(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    api_key: str
    wallet_private_key: str
    environment: Literal['devnet', 'mainnet', 'localnet'] = 'devnet'
    
    api_url: Optional[str] = None
    ws_url: Optional[str] = None
    rpc_url: Optional[str] = None
    private_mode: bool = False
    strict_opaque_per_mode: bool = True

class OfferCreationParams(BaseModel):
    model_config = ConfigDict(extra="ignore")

    asset: str
    mode: Literal['buy', 'sell']
    amount: float
    price: float
    collateral: float
    rollupMode: Optional[Literal['ER', 'PER']] = None
    privateMode: Optional[bool] = None
    settlementWallet: Optional[str] = None
    rewardWallet: Optional[str] = None
    fundingWallet: Optional[str] = None

class OfferData(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    id: str
    asset: str
    price: float
    amount: float
    mode: Literal['buy', 'sell']
    status: str
    collateral: float
    rollupMode: Optional[Literal['ER', 'PER']] = None
    creator: Optional[Dict[str, str]] = None
    ticket: Optional[Dict[str, Any]] = None
    created_at: Optional[str] = None

class TicketData(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    id: str
    buyer: str
    seller: str
    status: str
    created_at: Optional[str] = None

class DealStatusData(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    ticket_id: str
    phase: str
    details: Optional[str] = None
    buyer: Optional[str] = None
    seller: Optional[str] = None
    escrowAddress: Optional[str] = None

class NegotiationMessage(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    sender: str
    content: str
    timestamp: datetime
    isSystem: bool


# ─── Agent Registry ───

class RegistrationResult(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    wallet: str
    created: bool
    """True if the agent was freshly created, false if it already existed."""
    api_key: Optional[str] = None
    """
    The API key for this agent. Only returned on FIRST registration (created == True).
    ⚠️ SAVE THIS IMMEDIATELY — it is never shown again.
    """

class AgentStats(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    totalDeals: int = 0
    successfulDeals: int = 0
    cancelledDeals: int = 0
    disputedDeals: int = 0
    totalVolume: float = 0.0
    avgSettlementTime: float = 0.0
    avgSettlementTimeFormatted: str = "0s"

class AgentMetrics(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    successRate: float = 0.0
    disputeRate: float = 0.0

class AgentProfile(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    wallet: str
    reputationScore: int = 0
    tier: Literal['new', 'risky', 'neutral', 'trusted', 'elite'] = 'new'
    trustSummary: str = "No trading history yet"
    stats: AgentStats = AgentStats()
    metrics: AgentMetrics = AgentMetrics()

class WebhookConfig(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    wallet: str
    webhookUrl: Optional[str] = None
    webhookSecret: Optional[str] = None
    """HMAC-SHA256 secret for verifying inbound webhook payloads. Only shown when setting a URL."""
    configured: bool = False


# ─── ZK Privacy Mode ───

class PrivacyTerms(BaseModel):
    """Deal terms for privacy-mode hash commitment."""
    price: float
    collateral_buyer: float
    collateral_seller: float
    asset_type: str

class PrivacyCommitment(BaseModel):
    """SHA-256 commitment result. Save the nonce for reveal."""
    model_config = ConfigDict(extra="ignore")
    
    termsHash: str
    """Hex-encoded SHA-256 hash"""
    termsHashBytes: list[int]
    """Raw 32-byte hash as int array (for on-chain use)"""
    nonce: str
    """Cryptographic nonce — SAVE THIS for reveal"""

class PrivacyStatus(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    isPrivacyMode: bool = False
    termsHash: Optional[str] = None
    termsRevealed: bool = False
    canReveal: bool = False


# ─── PER Protocol Types ───

FundingPrivacyTier = Literal['DIRECT_SOL', 'STEALTH_SOL', 'SHIELDED_CREDIT']
ConfidentialFundingRole = Literal['buyer_payment', 'buyer_collateral', 'seller_collateral']
ConfidentialFundingPartyRole = Literal['buyer', 'seller']
UmbraLifecyclePhase = Literal['SHIELD', 'CREATE_UTXO', 'CLAIM', 'UNSHIELD']


class PrivateAgreementTerms(BaseModel):
    model_config = ConfigDict(extra="ignore")

    assetMint: str
    assetSymbol: Optional[str] = None
    priceSol: float
    buyerCollateralSol: float
    sellerCollateralSol: Optional[float] = None
    quantity: float = 1


class RollupTerms(BaseModel):
    model_config = ConfigDict(extra="ignore")

    assetMint: str
    assetSymbol: Optional[str] = None
    priceLamports: int
    quantity: float = 1
    collateralBuyer: float = 0
    collateralSeller: float = 0


class PrivateCiphertextHandle(BaseModel):
    model_config = ConfigDict(extra="ignore")

    identifierHex: str
    account: str
    fheType: int


class EncryptedTerms(BaseModel):
    model_config = ConfigDict(extra="ignore")

    buyerCollateral: PrivateCiphertextHandle
    sellerCollateral: PrivateCiphertextHandle
    paymentAmount: PrivateCiphertextHandle
    settlementResult: PrivateCiphertextHandle
    networkEncryptionKeyPda: str


class ConfidentialFundingCommitments(BaseModel):
    model_config = ConfigDict(extra="ignore")

    buyerPaymentHash: str
    buyerCollateralHash: str
    sellerCollateralHash: str


class PerPrivateHandoffBundle(BaseModel):
    model_config = ConfigDict(extra="ignore")

    version: Literal[1] = 1
    sessionPda: str
    assetMint: str
    assetSymbol: Optional[str] = None
    termsNonceHex: str
    termsHash: str
    encryptedTerms: EncryptedTerms
    fundingCommitments: ConfidentialFundingCommitments


class ConfidentialFundingRoleInstruction(BaseModel):
    model_config = ConfigDict(extra="ignore")

    fundingRole: ConfidentialFundingRole
    fundingHash: str
    amountCommitment: Optional[str] = None


class ConfidentialFundingSummary(BaseModel):
    model_config = ConfigDict(extra="ignore")

    ticketId: str
    role: ConfidentialFundingPartyRole
    counterparty: str
    asset: str
    buyerPayment: float = 0
    buyerCollateral: float = 0
    sellerCollateral: float = 0
    settlementMode: str
    actionLabel: str
    expiresAt: str
    redacted: bool = False
    localTermsRequired: bool = False


class ConfidentialFundingRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    version: Optional[Literal[1, 2]] = None
    requestId: str
    ticketId: str
    role: ConfidentialFundingPartyRole
    requestKind: Literal['BUYER_FUNDING', 'SELLER_FUNDING']
    fundingRail: Optional[FundingPrivacyTier] = None
    summary: ConfidentialFundingSummary
    dealPda: str
    sessionPda: str
    intentId: Optional[str] = None
    termsHash: str
    vaultPda: Optional[str] = None
    creditAccountPda: Optional[str] = None
    requiredCreditLamports: Optional[str] = None
    instructions: List[ConfidentialFundingRoleInstruction]
    issuedAt: str


class ShieldedCreditFundingRequest(ConfidentialFundingRequest):
    fundingRail: Literal['SHIELDED_CREDIT'] = 'SHIELDED_CREDIT'


class ReleaseApprovalCanonicalPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")

    version: int
    action: Literal['APPROVE_SETTLEMENT', 'REVOKE_SETTLEMENT', 'CONFIRM_RELEASE', 'OPEN_DISPUTE']
    ticketIdHash: str
    dealPda: str
    sessionPda: str
    intentIdHash: str
    role: Literal['buyer', 'seller']
    route: Literal['CONFIDENTIAL_ESCROW']
    settlementPolicy: Literal['DIRECT', 'STEALTH']
    termsHash: str
    planHash: str
    nonce: str
    expiresAt: str
    timestamp: str


class ReleaseApprovalRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    requestId: str
    ticketId: str
    role: Literal['buyer', 'seller']
    requestKind: Literal['SETTLEMENT_PLAN', 'BUYER_RELEASE_CONFIRMATION']
    summary: Dict[str, Any]
    payload: ReleaseApprovalCanonicalPayload
    messageBase64: str
    issuedAt: str


class EncryptedDelivery(BaseModel):
    model_config = ConfigDict(extra="ignore")

    ticketId: str
    fromWallet: str
    toWallet: str
    ciphertext: str
    contentType: str = 'credentials'
    label: Optional[str] = None
    createdAt: Optional[str] = None


class UmbraLifecycleRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    ticketId: str
    dealId: str
    settlementId: str
    role: Literal['buyer', 'seller']
    mint: str
    baseWallet: str
    receiverWallet: str
    requiredPhases: List[UmbraLifecyclePhase]
    finalWalletRequired: bool = True
    issuedAt: str
