/**
 * Multi-Agent Deal Aggregator (Day 25)
 *
 * Enables grouped deals where multiple buyers or sellers aggregate
 * into a single escrow position. This is critical for large OTC blocks
 * where no single agent has enough liquidity.
 *
 * Architecture:
 *   1. A "deal group" is created with a target asset, quantity, and side
 *   2. Agents join the group by pledging a portion of the quantity
 *   3. When the group fills to ≥ minFillPercent, it becomes executable
 *   4. The matchingEngine treats the aggregated group as a single intent
 *   5. Settlement splits pro-rata based on each participant's share
 *
 * Safety:
 *   - Each participant's wallet must be unique (no duplicate entries)
 *   - Groups expire after maxDurationMs (default: 30 min)
 *   - Minimum 2 participants to execute
 *   - Maximum 10 participants per group (escrow account size limit)
 *
 * @module multiAgentDeals
 */

import { logger } from '../utils/logger';
import { eventBus } from './eventBus';

// ==========================================
// TYPES
// ==========================================

export interface GroupParticipant {
    agentId: string;
    wallet: string;
    pledgedQuantity: number;
    pledgedAt: number;
}

export interface DealGroup {
    id: string;
    asset: string;
    side: 'buy' | 'sell';
    targetQuantity: number;
    minPriceSol: number;
    maxPriceSol: number;
    minFillPercent: number;     // 0-100, default 80
    maxParticipants: number;    // default 10
    maxDurationMs: number;      // default 30 min
    createdAt: number;
    createdBy: string;
    participants: GroupParticipant[];
    status: 'open' | 'filled' | 'executed' | 'expired' | 'cancelled';
    executedTicketId?: string;
}

export interface GroupCreateParams {
    asset: string;
    side: 'buy' | 'sell';
    targetQuantity: number;
    minPriceSol: number;
    maxPriceSol: number;
    minFillPercent?: number;
    maxParticipants?: number;
    maxDurationMs?: number;
    creatorAgentId: string;
    creatorWallet: string;
    creatorPledge: number;
}

export interface GroupJoinParams {
    groupId: string;
    agentId: string;
    wallet: string;
    pledgedQuantity: number;
}

// ==========================================
// STATE
// ==========================================

const _groups: Map<string, DealGroup> = new Map();
let _totalCreated = 0;
let _totalExecuted = 0;

// ==========================================
// GROUP MANAGEMENT
// ==========================================

/**
 * Create a new deal group.
 * The creator automatically becomes the first participant.
 */
export function createGroup(params: GroupCreateParams): DealGroup {
    const id = `GRP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    if (params.targetQuantity <= 0) throw new Error('targetQuantity must be positive');
    if (params.minPriceSol <= 0 || params.maxPriceSol <= 0) throw new Error('price must be positive');
    if (params.minPriceSol > params.maxPriceSol) throw new Error('minPrice must be ≤ maxPrice');
    if (params.creatorPledge <= 0) throw new Error('creatorPledge must be positive');
    if (params.creatorPledge > params.targetQuantity) throw new Error('pledge cannot exceed targetQuantity');

    const group: DealGroup = {
        id,
        asset: params.asset,
        side: params.side,
        targetQuantity: params.targetQuantity,
        minPriceSol: params.minPriceSol,
        maxPriceSol: params.maxPriceSol,
        minFillPercent: params.minFillPercent ?? 80,
        maxParticipants: params.maxParticipants ?? 10,
        maxDurationMs: params.maxDurationMs ?? 30 * 60 * 1000, // 30 min
        createdAt: Date.now(),
        createdBy: params.creatorAgentId,
        participants: [{
            agentId: params.creatorAgentId,
            wallet: params.creatorWallet,
            pledgedQuantity: params.creatorPledge,
            pledgedAt: Date.now(),
        }],
        status: 'open',
    };

    _groups.set(id, group);
    _totalCreated++;

    logger.info('multi_agent_group_created', {
        group_id: id,
        asset: group.asset,
        side: group.side,
        target: group.targetQuantity,
        creator: params.creatorAgentId,
        pledge: params.creatorPledge,
    });

    eventBus.publish('group_created' as any, { groupId: id, ...group } as any);

    return group;
}

/**
 * Join an existing deal group.
 * Returns the updated group state.
 */
export function joinGroup(params: GroupJoinParams): DealGroup {
    const group = _groups.get(params.groupId);
    if (!group) throw new Error(`Group ${params.groupId} not found`);
    if (group.status !== 'open') throw new Error(`Group is ${group.status}, cannot join`);

    // Check expiry
    if (Date.now() - group.createdAt > group.maxDurationMs) {
        group.status = 'expired';
        throw new Error('Group has expired');
    }

    // Check participant limit
    if (group.participants.length >= group.maxParticipants) {
        throw new Error(`Group is full (${group.maxParticipants} max)`);
    }

    // Check for duplicate wallet
    if (group.participants.some(p => p.wallet === params.wallet)) {
        throw new Error('Wallet already in this group');
    }

    // Check pledge doesn't exceed remaining
    const currentFill = group.participants.reduce((s, p) => s + p.pledgedQuantity, 0);
    const remaining = group.targetQuantity - currentFill;
    if (params.pledgedQuantity > remaining) {
        throw new Error(`Pledge exceeds remaining capacity (${remaining} left)`);
    }

    group.participants.push({
        agentId: params.agentId,
        wallet: params.wallet,
        pledgedQuantity: params.pledgedQuantity,
        pledgedAt: Date.now(),
    });

    // Check if group is now filled
    const newFill = currentFill + params.pledgedQuantity;
    const fillPercent = (newFill / group.targetQuantity) * 100;

    if (fillPercent >= group.minFillPercent) {
        group.status = 'filled';
        logger.info('multi_agent_group_filled', {
            group_id: group.id,
            participants: group.participants.length,
            fill_percent: fillPercent.toFixed(1),
        });
        eventBus.publish('group_filled' as any, { groupId: group.id } as any);
    }

    logger.info('multi_agent_group_joined', {
        group_id: group.id,
        agent: params.agentId,
        pledge: params.pledgedQuantity,
        fill: `${fillPercent.toFixed(1)}%`,
        participants: group.participants.length,
    });

    return group;
}

/**
 * Execute a filled group — creates an aggregated deal ticket.
 * Returns the ticket ID.
 */
export function executeGroup(groupId: string): string {
    const group = _groups.get(groupId);
    if (!group) throw new Error(`Group ${groupId} not found`);
    if (group.status !== 'filled') throw new Error(`Group is ${group.status}, must be 'filled' to execute`);
    if (group.participants.length < 2) throw new Error('Need at least 2 participants');

    // Generate aggregated ticket
    const ticketId = `MULTI-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    group.status = 'executed';
    group.executedTicketId = ticketId;
    _totalExecuted++;

    // Calculate pro-rata shares
    const totalPledged = group.participants.reduce((s, p) => s + p.pledgedQuantity, 0);
    const midPrice = (group.minPriceSol + group.maxPriceSol) / 2;
    const shares = group.participants.map(p => ({
        agentId: p.agentId,
        wallet: p.wallet,
        quantity: p.pledgedQuantity,
        share: ((p.pledgedQuantity / totalPledged) * 100).toFixed(2) + '%',
        valueSol: p.pledgedQuantity * midPrice,
    }));

    logger.info('multi_agent_group_executed', {
        group_id: group.id,
        ticket_id: ticketId,
        asset: group.asset,
        side: group.side,
        total_quantity: totalPledged,
        mid_price: midPrice,
        participants: group.participants.length,
        shares,
    });

    eventBus.publish('group_executed' as any, {
        groupId: group.id,
        ticketId,
        asset: group.asset,
        side: group.side,
        totalQuantity: totalPledged,
        midPrice,
        shares,
    } as any);

    return ticketId;
}

/**
 * Cancel a group. Only the creator can cancel.
 */
export function cancelGroup(groupId: string, requestedBy: string): void {
    const group = _groups.get(groupId);
    if (!group) throw new Error(`Group ${groupId} not found`);
    if (group.status !== 'open' && group.status !== 'filled') {
        throw new Error(`Group is ${group.status}, cannot cancel`);
    }
    if (group.createdBy !== requestedBy) {
        throw new Error('Only the group creator can cancel');
    }

    group.status = 'cancelled';
    logger.info('multi_agent_group_cancelled', { group_id: group.id, by: requestedBy });
}

/**
 * Leave a group (remove self). Cannot leave if already executed.
 */
export function leaveGroup(groupId: string, wallet: string): void {
    const group = _groups.get(groupId);
    if (!group) throw new Error(`Group ${groupId} not found`);
    if (group.status !== 'open') throw new Error(`Cannot leave ${group.status} group`);

    const idx = group.participants.findIndex(p => p.wallet === wallet);
    if (idx === -1) throw new Error('Wallet not in this group');
    if (group.participants[idx].agentId === group.createdBy) {
        throw new Error('Creator cannot leave — cancel the group instead');
    }

    group.participants.splice(idx, 1);
    logger.info('multi_agent_group_left', { group_id: group.id, wallet });
}

// ==========================================
// QUERIES
// ==========================================

/**
 * Get a group by ID.
 */
export function getGroup(groupId: string): DealGroup | null {
    return _groups.get(groupId) || null;
}

/**
 * List open groups, optionally filtered by asset and/or side.
 */
export function listGroups(filter?: { asset?: string; side?: string; status?: string }): DealGroup[] {
    let groups = Array.from(_groups.values());

    // Expire old groups
    const now = Date.now();
    for (const g of groups) {
        if (g.status === 'open' && now - g.createdAt > g.maxDurationMs) {
            g.status = 'expired';
        }
    }

    if (filter?.asset) groups = groups.filter(g => g.asset.toLowerCase() === filter.asset!.toLowerCase());
    if (filter?.side) groups = groups.filter(g => g.side === filter.side);
    if (filter?.status) groups = groups.filter(g => g.status === filter.status);

    return groups.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Get aggregator stats.
 */
export function getGroupStats(): {
    totalCreated: number;
    totalExecuted: number;
    activeGroups: number;
    totalParticipants: number;
} {
    const active = Array.from(_groups.values()).filter(g => g.status === 'open' || g.status === 'filled');
    return {
        totalCreated: _totalCreated,
        totalExecuted: _totalExecuted,
        activeGroups: active.length,
        totalParticipants: active.reduce((s, g) => s + g.participants.length, 0),
    };
}

// ==========================================
// LIFECYCLE
// ==========================================

let _pruneInterval: ReturnType<typeof setInterval> | null = null;

export function startMultiAgentAggregator(): void {
    // Prune expired groups every 5 min
    _pruneInterval = setInterval(() => {
        const now = Date.now();
        for (const [, group] of _groups) {
            if (group.status === 'open' && now - group.createdAt > group.maxDurationMs) {
                group.status = 'expired';
                logger.debug('multi_agent_group_expired', { group_id: group.id });
            }
        }
        // Remove groups older than 2 hours
        for (const [id, group] of _groups) {
            if (['expired', 'cancelled', 'executed'].includes(group.status) &&
                now - group.createdAt > 2 * 60 * 60 * 1000) {
                _groups.delete(id);
            }
        }
    }, 5 * 60 * 1000);

    logger.info('multi_agent_aggregator_started');
}

export function stopMultiAgentAggregator(): void {
    if (_pruneInterval) {
        clearInterval(_pruneInterval);
        _pruneInterval = null;
    }
}
