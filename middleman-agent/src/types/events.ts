import { Ticket } from "./ticket";
import { Message } from "./message";
import { MiddlemanIntent } from "../../core/commandParser";
import { DealPhase } from "../../core/dealPhaseManager";
import { MiddlemanAction } from "../../core/middlemanBrain";
import { AgentMessage } from "../protocol/agentProtocol";
import { MemoIntentPayload } from "../services/intentBroadcaster";
import type {
  DealPipelineStage,
  ExecutionPolicy,
  PipelineRoute,
  PipelineStageStatus,
  SettlementPolicy,
  NegotiationSource,
  AttestedEscrowIntent,
} from "./dealPipeline";
import type {
  ReleaseApprovalAction,
  ReleaseApprovalRequestEnvelope,
  ReleaseApprovalRole,
} from "../protocol/releaseApprovalProtocol";
import type {
  ConfidentialFundingPartyRole,
  ConfidentialFundingRequestEnvelope,
} from "../protocol/confidentialFundingProtocol";
import type { PerPrivateHandoffBundle } from "../protocol/privateHandoffProtocol";

export type OfferType = "buy" | "sell";

export interface OfferDetectedEvent {
  offer_id: string;
  type: OfferType;
  creator: string;
  content: string;
  timestamp: string;
}

export interface AgreementDetectedEvent {
  ticketId: string;
  price: number;
  collateral_buyer: number;
  collateral_seller: number;
  asset_type?: string;
  confidence: number;
  buyer?: string;   // Agent ID or wallet pubkey string
  seller?: string;  // Agent ID or wallet pubkey string
}

export interface NegotiationReadyEvent {
  ticketId: string;
  buyer: string;
  seller: string;
  rollupMode: "ER" | "PER";
  asset_type?: string;
}

export interface RollupConsensusReachedEvent {
  ticketId: string;
  agentId: string;
  commitSignature?: string;
}

export interface PrivateEscrowIntentReadyEvent {
  ticketId: string;
  intentId: string;
  rollupMode: "PER";
  negotiationSource: "PER";
  sessionPda: string;
  termsHash: string;
  assetMint: string;
  status: AttestedEscrowIntent["status"];
}

export interface PrivateHandoffBundleReadyEvent {
  ticketId: string;
  agentId: string;
  bundle: PerPrivateHandoffBundle;
}

export interface CommandReceivedEvent {
  ticket_id: string;
  intent: MiddlemanIntent;
  action: MiddlemanAction;
  sender: string;
  sender_agent_id?: string;
  raw_message: string;
  confidence: number;
  reasoning: string;
  trigger: "auto_agreement" | "mention" | "none" | "generative_agent";
  timestamp: string;
}

export interface PhaseChangedEvent {
  ticket_id: string;
  from_phase: DealPhase | string;
  to_phase: DealPhase;
  triggered_by: string;
  action: MiddlemanAction;
}

export interface MiddlemanResponseEvent {
  ticket_id: string;
  content: string;
  phase: string;
  timestamp: string;
}

export interface DepositReceivedEvent {
  ticket_id: string;
  deal_pda: string;
  deposit_type: "buyer_collateral" | "seller_collateral" | "buyer_payment";
  amount_lamports: number;
  signature?: string;
  dune_sim_verified?: boolean;
}

export interface IntentDiscoveredEvent {
  signature: string;
  intent: MemoIntentPayload;
  discoveredAt: number;
}

export interface ConfidentialDealCreatedEvent {
  ticket_id: string;
  deal_pda: string;
  buyer_ct: string;        // encrypted buyer collateral ciphertext pubkey
  seller_ct: string;       // encrypted seller collateral ciphertext pubkey
  settlement_ct: string;   // settlement result ciphertext pubkey (Encrypt)
  dwallet_pda: string;     // dWallet controlling cross-chain signing (Ika)
}

export interface CrossChainSignedEvent {
  ticket_id: string;
  deal_pda: string;
  message_hash: string;          // keccak256 of settlement proof
  signature: string;             // 64-byte hex signature from Ika MPC
  signature_scheme: string;      // "EddsaSha512" | "EcdsaKeccak256" etc.
  dwallet_public_key: string;    // dWallet public key hex
  message_approval_pda: string;  // on-chain proof location
}

export interface DealPipelineStageChangedEvent {
  ticketId: string;
  stage: DealPipelineStage;
  status: PipelineStageStatus;
  route: PipelineRoute;
  executionPolicy: ExecutionPolicy;
  settlementPolicy: SettlementPolicy;
  negotiationSource: NegotiationSource;
}

export interface ReleaseApprovalRequestedEvent {
  ticketId: string;
  dealPda: string;
  role: ReleaseApprovalRole;
  request: ReleaseApprovalRequestEnvelope;
}

export interface ReleaseApprovalReceivedEvent {
  ticketId: string;
  requestId: string;
  role: ReleaseApprovalRole;
  agentId: string;
  action: ReleaseApprovalAction;
}

export interface ReleaseApprovalRecordedEvent {
  ticketId: string;
  requestId: string;
  role: ReleaseApprovalRole;
  approvalPda: string;
  txSignature: string;
}

export interface ReleaseApprovalRevokedEvent {
  ticketId: string;
  requestId: string;
  role: ReleaseApprovalRole;
  txSignature: string;
}

export interface ReleaseDisputeOpenedEvent {
  ticketId: string;
  requestId: string;
  role: ReleaseApprovalRole;
  txSignature: string;
  disputeReason?: string;
}

export interface ReleaseAuthorizedEvent {
  ticketId: string;
  dealPda: string;
}

export interface ConfidentialFundingSubmittedEvent {
  ticketId: string;
  agentId: string;
  requestId: string;
  transactionSignatures: string[];
}

export interface ConfidentialFundingRequestedEvent {
  ticketId: string;
  dealPda: string;
  role: ConfidentialFundingPartyRole;
  request: ConfidentialFundingRequestEnvelope;
}

export interface ConfidentialFundingRecordedEvent {
  ticketId: string;
  requestId: string;
  role: ConfidentialFundingPartyRole;
  transactionSignatures: string[];
}

export interface ConfidentialFundingCompletedEvent {
  ticketId: string;
  dealPda: string;
}

export interface UmbraSettlementSubmissionProcessedEvent {
  ticketId: string;
  agentId: string;
  settlementId: string;
  role: "buyer" | "seller";
  phase: "SHIELD" | "CREATE_UTXO" | "CLAIM" | "UNSHIELD";
  settlementPhase: string;
  participantPhase: string;
}

export type AgentEventType =
  | "offer_detected"
  | "agent_started"
  | "agent_alive"
  | "ticket_created"
  | "message_received"
  | "deal_executed"
  | "deal_expiring"
  | "negotiation_ready"
  | "agreement_detected"
  | "rollup_consensus_reached"
  | "private_escrow_intent_ready"
  | "private_handoff_bundle_ready"
  | "command_received"
  | "phase_changed"
  | "middleman_response"
  | "deposit_received"
  | "agent_message_received"
  | "treasury_checked"
  | "force_recovery"
  | "deposit_detected_polling"
  | "intent_discovered"
  | "trigger_curiosity_now"
  | "confidential_deal_created"
  | "cross_chain_signed"
  | "deal_pipeline_stage_changed"
  | "release_approval_requested"
  | "release_approval_received"
  | "release_approval_recorded"
  | "release_approval_revoked"
  | "release_dispute_opened"
  | "release_authorized"
  | "confidential_funding_submitted"
  | "confidential_funding_requested"
  | "confidential_funding_recorded"
  | "confidential_funding_completed"
  | "umbra_settlement_submission_processed";

export type AgentEventPayloads = {
  offer_detected: OfferDetectedEvent;
  agent_started: { network: string; wallet: string };
  agent_alive: { tick: number; uptime_seconds: number };
  ticket_created: Ticket;
  message_received: Message;
  deal_executed: { ticket_id: string; status: string };
  deal_expiring: {
    ticket_id: string;
    phase: string;
    expires_at: string;
    ms_remaining: number;
    warning_threshold_ms: number;
  };
  negotiation_ready: NegotiationReadyEvent;
  agreement_detected: AgreementDetectedEvent;
  rollup_consensus_reached: RollupConsensusReachedEvent;
  private_escrow_intent_ready: PrivateEscrowIntentReadyEvent;
  private_handoff_bundle_ready: PrivateHandoffBundleReadyEvent;
  command_received: CommandReceivedEvent;
  phase_changed: PhaseChangedEvent;
  middleman_response: MiddlemanResponseEvent;
  deposit_received: DepositReceivedEvent;
  agent_message_received: AgentMessage;
  treasury_checked: { balance_sol: number; tier: string; can_accept_deals: boolean };
  force_recovery: { ticketId: string };
  deposit_detected_polling: { ticketId: string };
  intent_discovered: IntentDiscoveredEvent;
  trigger_curiosity_now: { reason: string; timestamp: string };
  confidential_deal_created: ConfidentialDealCreatedEvent;
  cross_chain_signed: CrossChainSignedEvent;
  deal_pipeline_stage_changed: DealPipelineStageChangedEvent;
  release_approval_requested: ReleaseApprovalRequestedEvent;
  release_approval_received: ReleaseApprovalReceivedEvent;
  release_approval_recorded: ReleaseApprovalRecordedEvent;
  release_approval_revoked: ReleaseApprovalRevokedEvent;
  release_dispute_opened: ReleaseDisputeOpenedEvent;
  release_authorized: ReleaseAuthorizedEvent;
  confidential_funding_submitted: ConfidentialFundingSubmittedEvent;
  confidential_funding_requested: ConfidentialFundingRequestedEvent;
  confidential_funding_recorded: ConfidentialFundingRecordedEvent;
  confidential_funding_completed: ConfidentialFundingCompletedEvent;
  umbra_settlement_submission_processed: UmbraSettlementSubmissionProcessedEvent;
};
