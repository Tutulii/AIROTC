/**
 * DelegationService — Agent-to-Agent Task Delegation
 * 
 * Inspired by CrewAI's agent delegation.
 * Lets the middleman delegate sub-tasks to connected agents.
 * 
 * Flow:
 *   1. Middleman decides to delegate (e.g., "ask buyer to verify delivery")
 *   2. Sends delegation request via WebSocket
 *   3. Target agent processes, returns result
 *   4. Middleman continues with result
 */

import { logger } from '../utils/logger';

import { randomUUID } from 'crypto';

// ─── Types ──────────────────────────────────────────────────

export interface DelegationRequest {
    id: string;
    fromAgent: string;
    toAgent: string;
    task: string;
    description: string;
    payload: Record<string, any>;
    status: 'pending' | 'accepted' | 'completed' | 'rejected' | 'timeout';
    result?: any;
    createdAt: Date;
    timeout: number;           // ms
    completedAt?: Date;
}

// ─── State ──────────────────────────────────────────────────

const activeDelegations = new Map<string, DelegationRequest>();
const delegationHistory: DelegationRequest[] = [];
const resolvers = new Map<string, (result: any) => void>();
const MAX_HISTORY = 100;

// ─── Core ───────────────────────────────────────────────────

/**
 * Delegate a task to another connected agent.
 * Returns a promise that resolves when the agent responds or times out.
 */
export async function delegateTask(
    toAgent: string,
    task: string,
    description: string,
    payload: Record<string, any> = {},
    timeoutMs: number = 60000,
): Promise<{ success: boolean; result?: any; error?: string }> {
    const delegation: DelegationRequest = {
        id: randomUUID(),
        fromAgent: 'middleman',
        toAgent,
        task,
        description,
        payload,
        status: 'pending',
        createdAt: new Date(),
        timeout: timeoutMs,
    };

    activeDelegations.set(delegation.id, delegation);

    // Emit via eventBus → wsServer picks up and sends to agent
    logger.info('delegation_request', {
        delegationId: delegation.id,
        toAgent,
        type: 'delegation_request',
        task,
        description,
        payload,
    });

    logger.info('delegation_sent', { id: delegation.id, to: toAgent, task });

    // Wait for response or timeout
    return new Promise<{ success: boolean; result?: any; error?: string }>((resolve) => {
        const timer = setTimeout(() => {
            delegation.status = 'timeout';
            delegation.completedAt = new Date();
            activeDelegations.delete(delegation.id);
            delegationHistory.push(delegation);
            resolvers.delete(delegation.id);
            logger.warn('delegation_timeout', { id: delegation.id, to: toAgent, task });
            resolve({ success: false, error: 'Delegation timed out' });
        }, timeoutMs);

        resolvers.set(delegation.id, (result: any) => {
            clearTimeout(timer);
            delegation.status = 'completed';
            delegation.result = result;
            delegation.completedAt = new Date();
            activeDelegations.delete(delegation.id);
            delegationHistory.push(delegation);
            resolvers.delete(delegation.id);
            
            if (delegationHistory.length > MAX_HISTORY) delegationHistory.shift();
            
            logger.info('delegation_completed', { id: delegation.id, to: toAgent, task });
            resolve({ success: true, result });
        });
    });
}

/**
 * Handle a delegation response from a connected agent.
 * Called by wsServer when it receives a delegation_response message.
 */
export function handleDelegationResponse(delegationId: string, result: any): boolean {
    const resolver = resolvers.get(delegationId);
    if (!resolver) {
        logger.warn('delegation_response_orphan', { id: delegationId });
        return false;
    }
    resolver(result);
    return true;
}

/**
 * Handle a delegation rejection from a connected agent.
 */
export function handleDelegationRejection(delegationId: string, reason: string): boolean {
    const delegation = activeDelegations.get(delegationId);
    if (!delegation) return false;

    delegation.status = 'rejected';
    delegation.result = { rejected: true, reason };
    delegation.completedAt = new Date();

    const resolver = resolvers.get(delegationId);
    if (resolver) {
        resolver({ rejected: true, reason });
    }

    activeDelegations.delete(delegationId);
    delegationHistory.push(delegation);
    resolvers.delete(delegationId);

    logger.info('delegation_rejected', { id: delegationId, reason });
    return true;
}

// ─── Query ──────────────────────────────────────────────────

export function getActiveDelegations(): DelegationRequest[] {
    return Array.from(activeDelegations.values());
}

export function getDelegationHistory(limit: number = 20): DelegationRequest[] {
    return delegationHistory.slice(-limit);
}

export function getDelegation(id: string): DelegationRequest | undefined {
    return activeDelegations.get(id) || delegationHistory.find(d => d.id === id);
}
