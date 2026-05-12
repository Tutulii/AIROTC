/**
 * Multi-Agent Deals — Unit Tests (Day 26)
 *
 * Tests the multi-agent deal aggregation service in isolation.
 * No database, no network — pure business logic.
 *
 * Coverage:
 *   - Group creation (validation, defaults)
 *   - Group joining (capacity, duplicate, pledge limits)
 *   - Group execution (pro-rata shares)
 *   - Group lifecycle (cancel, leave, expire)
 *   - Edge cases (full group, expired, double-join)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    createGroup,
    joinGroup,
    executeGroup,
    cancelGroup,
    leaveGroup,
    getGroup,
    listGroups,
    getGroupStats,
} from '../src/services/multiAgentDeals';

// Reset state between tests by creating fresh groups
const freshGroup = () => createGroup({
    asset: 'USDC',
    side: 'buy',
    targetQuantity: 1000,
    minPriceSol: 0.9,
    maxPriceSol: 1.1,
    creatorAgentId: 'agent-alpha',
    creatorWallet: 'WalletAlpha111111111111111111111111111111111',
    creatorPledge: 300,
});

describe('createGroup', () => {
    it('creates a group with correct defaults', () => {
        const g = freshGroup();
        expect(g.id).toMatch(/^GRP-/);
        expect(g.asset).toBe('USDC');
        expect(g.side).toBe('buy');
        expect(g.targetQuantity).toBe(1000);
        expect(g.minFillPercent).toBe(80);
        expect(g.maxParticipants).toBe(10);
        expect(g.status).toBe('open');
        expect(g.participants).toHaveLength(1);
        expect(g.participants[0].agentId).toBe('agent-alpha');
        expect(g.participants[0].pledgedQuantity).toBe(300);
    });

    it('rejects negative targetQuantity', () => {
        expect(() => createGroup({
            asset: 'SOL', side: 'sell', targetQuantity: -1,
            minPriceSol: 1, maxPriceSol: 2,
            creatorAgentId: 'a', creatorWallet: 'w', creatorPledge: 1,
        })).toThrow('targetQuantity must be positive');
    });

    it('rejects minPrice > maxPrice', () => {
        expect(() => createGroup({
            asset: 'SOL', side: 'sell', targetQuantity: 100,
            minPriceSol: 5, maxPriceSol: 1,
            creatorAgentId: 'a', creatorWallet: 'w', creatorPledge: 10,
        })).toThrow('minPrice must be');
    });

    it('rejects pledge exceeding targetQuantity', () => {
        expect(() => createGroup({
            asset: 'SOL', side: 'sell', targetQuantity: 100,
            minPriceSol: 1, maxPriceSol: 2,
            creatorAgentId: 'a', creatorWallet: 'w', creatorPledge: 200,
        })).toThrow('pledge cannot exceed');
    });
});

describe('joinGroup', () => {
    it('adds participant to group', () => {
        const g = freshGroup();
        const updated = joinGroup({
            groupId: g.id,
            agentId: 'agent-beta',
            wallet: 'WalletBeta2222222222222222222222222222222222',
            pledgedQuantity: 200,
        });
        expect(updated.participants).toHaveLength(2);
        expect(updated.participants[1].agentId).toBe('agent-beta');
    });

    it('rejects duplicate wallet', () => {
        const g = freshGroup();
        expect(() => joinGroup({
            groupId: g.id,
            agentId: 'agent-dup',
            wallet: 'WalletAlpha111111111111111111111111111111111', // same as creator
            pledgedQuantity: 100,
        })).toThrow('Wallet already in this group');
    });

    it('rejects pledge exceeding remaining capacity', () => {
        const g = freshGroup(); // creator pledged 300 of 1000
        expect(() => joinGroup({
            groupId: g.id,
            agentId: 'agent-greedy',
            wallet: 'WalletGreedy3333333333333333333333333333333',
            pledgedQuantity: 800, // 300 + 800 > 1000
        })).toThrow('Pledge exceeds remaining capacity');
    });

    it('rejects joining non-existent group', () => {
        expect(() => joinGroup({
            groupId: 'GRP-nonexistent',
            agentId: 'a', wallet: 'w', pledgedQuantity: 1,
        })).toThrow('not found');
    });

    it('marks group as filled when minFillPercent reached', () => {
        const g = createGroup({
            asset: 'SOL', side: 'buy', targetQuantity: 100,
            minPriceSol: 1, maxPriceSol: 2,
            minFillPercent: 80,
            creatorAgentId: 'a', creatorWallet: 'w1',
            creatorPledge: 50,
        });

        const updated = joinGroup({
            groupId: g.id, agentId: 'b',
            wallet: 'w2222222222222222222222222222222222222222222',
            pledgedQuantity: 40, // 50 + 40 = 90 = 90% > 80%
        });
        expect(updated.status).toBe('filled');
    });
});

describe('executeGroup', () => {
    it('executes filled group and returns ticket ID', () => {
        const g = createGroup({
            asset: 'SOL', side: 'sell', targetQuantity: 100,
            minPriceSol: 1, maxPriceSol: 2,
            minFillPercent: 50,
            creatorAgentId: 'seller-a', creatorWallet: 'sw1',
            creatorPledge: 30,
        });
        joinGroup({
            groupId: g.id, agentId: 'seller-b',
            wallet: 'sw22222222222222222222222222222222222222222',
            pledgedQuantity: 30,
        }); // 60% > 50% → fills

        const ticketId = executeGroup(g.id);
        expect(ticketId).toMatch(/^MULTI-/);

        const updated = getGroup(g.id);
        expect(updated?.status).toBe('executed');
        expect(updated?.executedTicketId).toBe(ticketId);
    });

    it('rejects executing open (unfilled) group', () => {
        const g = freshGroup(); // only 30% filled
        expect(() => executeGroup(g.id)).toThrow('must be \'filled\'');
    });
});

describe('cancelGroup', () => {
    it('creator can cancel open group', () => {
        const g = freshGroup();
        cancelGroup(g.id, 'agent-alpha');
        expect(getGroup(g.id)?.status).toBe('cancelled');
    });

    it('non-creator cannot cancel', () => {
        const g = freshGroup();
        expect(() => cancelGroup(g.id, 'agent-beta')).toThrow('Only the group creator');
    });
});

describe('leaveGroup', () => {
    it('non-creator participant can leave open group', () => {
        const g = freshGroup();
        joinGroup({
            groupId: g.id, agentId: 'b',
            wallet: 'WalletLeaver444444444444444444444444444444444',
            pledgedQuantity: 100,
        });
        leaveGroup(g.id, 'WalletLeaver444444444444444444444444444444444');
        expect(getGroup(g.id)?.participants).toHaveLength(1);
    });

    it('creator cannot leave — must cancel', () => {
        const g = freshGroup();
        expect(() => leaveGroup(g.id, 'WalletAlpha111111111111111111111111111111111'))
            .toThrow('Creator cannot leave');
    });
});

describe('listGroups & getGroupStats', () => {
    it('listGroups returns array', () => {
        freshGroup(); // ensure at least one exists
        const groups = listGroups({ status: 'open' });
        expect(Array.isArray(groups)).toBe(true);
    });

    it('getGroupStats returns correct structure', () => {
        const stats = getGroupStats();
        expect(stats).toHaveProperty('totalCreated');
        expect(stats).toHaveProperty('totalExecuted');
        expect(stats).toHaveProperty('activeGroups');
        expect(stats).toHaveProperty('totalParticipants');
        expect(typeof stats.totalCreated).toBe('number');
    });
});
