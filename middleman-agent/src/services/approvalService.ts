/**
 * ApprovalService — Human-in-the-Loop Safety Checkpoints
 * 
 * High-risk actions require approval before execution.
 * Inspired by CrewAI's human approval workflows.
 * 
 * Modes:
 *   auto      — approve everything (testing/devnet)
 *   manual    — require manual approval for all write/admin ops
 *   threshold — auto-approve below USD threshold, require approval above
 */

import { logger } from '../utils/logger';
import { autonomy } from './autonomyConfig';
import { randomUUID } from 'crypto';

// ─── Types ──────────────────────────────────────────────────

export type ApprovalMode = 'auto' | 'manual' | 'threshold';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ApprovalRequest {
    id: string;
    action: string;
    description: string;
    risk: RiskLevel;
    estimatedValueUSD?: number;
    details: Record<string, any>;
    status: 'pending' | 'approved' | 'rejected' | 'expired';
    requestedBy: string;       // 'curiosity-engine', 'rest-api', 'sdk'
    createdAt: Date;
    expiresAt: Date;
    decidedAt?: Date;
    decidedBy?: string;
}

// ─── State ──────────────────────────────────────────────────

const pendingApprovals = new Map<string, ApprovalRequest>();
const approvalHistory: ApprovalRequest[] = [];
const MAX_HISTORY = 200;

// ─── Config ─────────────────────────────────────────────────

function getMode(): ApprovalMode {
    return (process.env.APPROVAL_MODE as ApprovalMode) || 'auto';
}

function getThresholdUSD(): number {
    return parseFloat(process.env.APPROVAL_THRESHOLD_USD || '100');
}

function getTimeoutMinutes(): number {
    return parseInt(process.env.APPROVAL_TIMEOUT_MINUTES || '30', 10);
}

// ─── Risk Classification ────────────────────────────────────

const ACTION_RISK_MAP: Record<string, RiskLevel> = {
    // READ — no approval needed
    'sol_price': 'low',
    'sol_balance': 'low',
    'sol_token_data': 'low',
    'sol_rug_check': 'low',
    'sol_trending': 'low',
    'sol_coingecko': 'low',
    
    // WRITE — medium risk
    'sol_swap': 'medium',
    'sol_transfer': 'high',
    'sol_stake': 'medium',
    'sol_lend': 'medium',
    'sol_burn': 'high',
    'sol_limit_order': 'medium',
    
    // ADMIN — high/critical risk
    'sol_deploy_token': 'high',
    'sol_mint_nft': 'high',
    'sol_bridge': 'critical',
    'sol_compressed_airdrop': 'critical',
    'sol_debridge': 'critical',
    'sol_deploy_collection': 'high',
    'drift_perp': 'critical',
    'adrena_perp': 'critical',
    'create_pool': 'critical',
    
    // Settlement
    'release_funds': 'critical',
    'refund_escrow': 'critical',
};

export function classifyRisk(action: string): RiskLevel {
    // Agent's own risk overrides take priority
    const overrides = autonomy.get('riskOverrides');
    if (overrides[action]) return overrides[action] as RiskLevel;
    return ACTION_RISK_MAP[action] || 'medium';
}

// ─── Core Logic ─────────────────────────────────────────────

/**
 * Request approval for an action.
 * Returns true if approved, false if rejected/expired.
 * In 'auto' mode, always returns true immediately.
 */
export async function requestApproval(
    action: string,
    description: string,
    details: Record<string, any> = {},
    requestedBy: string = 'system',
    estimatedValueUSD?: number,
): Promise<boolean> {
    const mode = getMode();
    const risk = classifyRisk(action);
    
    // Auto mode: approve everything
    if (mode === 'auto') {
        logger.debug('approval_auto', { action, risk });
        return true;
    }

    // Low risk: always auto-approve
    if (risk === 'low') return true;

    // Threshold mode: auto-approve below threshold
    if (mode === 'threshold' && estimatedValueUSD !== undefined) {
        const threshold = autonomy.get('autoApproveMaxUSD');
        if (estimatedValueUSD <= threshold) {
            logger.debug('approval_threshold_auto', { action, value: estimatedValueUSD });
            return true;
        }
    }

    // Create approval request
    const request: ApprovalRequest = {
        id: randomUUID(),
        action,
        description,
        risk,
        estimatedValueUSD,
        details,
        status: 'pending',
        requestedBy,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + getTimeoutMinutes() * 60 * 1000),
    };

    pendingApprovals.set(request.id, request);

    // Emit event for UI/notifications
    logger.info('approval_requested', {
        id: request.id,
        action,
        risk,
        description,
        estimatedValueUSD,
    });

    logger.info('approval_requested', {
        id: request.id,
        action,
        risk,
        estimatedValueUSD,
    });

    // Wait for decision or timeout
    return new Promise<boolean>((resolve) => {
        const checkInterval = setInterval(() => {
            const req = pendingApprovals.get(request.id);
            if (!req) {
                clearInterval(checkInterval);
                resolve(false);
                return;
            }

            if (req.status === 'approved') {
                clearInterval(checkInterval);
                finalize(req);
                resolve(true);
                return;
            }

            if (req.status === 'rejected') {
                clearInterval(checkInterval);
                finalize(req);
                resolve(false);
                return;
            }

            // Check expiration
            if (new Date() > req.expiresAt) {
                req.status = 'expired';
                clearInterval(checkInterval);
                finalize(req);
                logger.warn('approval_expired', { id: req.id, action: req.action });
                resolve(false);
                return;
            }
        }, 2000); // Check every 2 seconds
    });
}

function finalize(req: ApprovalRequest): void {
    pendingApprovals.delete(req.id);
    approvalHistory.push(req);
    if (approvalHistory.length > MAX_HISTORY) {
        approvalHistory.shift();
    }
}

// ─── Management API ─────────────────────────────────────────

export function approve(id: string, decidedBy: string = 'human'): boolean {
    const req = pendingApprovals.get(id);
    if (!req || req.status !== 'pending') return false;
    
    req.status = 'approved';
    req.decidedAt = new Date();
    req.decidedBy = decidedBy;
    
    logger.info('approval_decided', { id, status: 'approved', decidedBy });
    logger.info('approval_approved', { id, action: req.action, decidedBy });
    return true;
}

export function reject(id: string, decidedBy: string = 'human'): boolean {
    const req = pendingApprovals.get(id);
    if (!req || req.status !== 'pending') return false;
    
    req.status = 'rejected';
    req.decidedAt = new Date();
    req.decidedBy = decidedBy;
    
    logger.info('approval_decided', { id, status: 'rejected', decidedBy });
    logger.info('approval_rejected', { id, action: req.action, decidedBy });
    return true;
}

export function listPending(): ApprovalRequest[] {
    // Clean expired
    for (const [id, req] of pendingApprovals) {
        if (new Date() > req.expiresAt) {
            req.status = 'expired';
            finalize(req);
        }
    }
    return Array.from(pendingApprovals.values());
}

export function getHistory(limit: number = 50): ApprovalRequest[] {
    return approvalHistory.slice(-limit);
}

export function getApproval(id: string): ApprovalRequest | undefined {
    return pendingApprovals.get(id) || approvalHistory.find(a => a.id === id);
}
