import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { AgentEventName, normalizeAgentEventNames } from './eventCatalog';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export interface AgentEventEnvelope {
    id: string;
    event: AgentEventName;
    wallet: string;
    ticketId?: string;
    dealId?: string;
    timestamp: string;
    payload: Record<string, unknown>;
    deliveredAt?: string;
    ackedAt?: string;
    expiresAt: string;
}

function toJsonPayload(payload: Record<string, unknown>): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(payload ?? {})) as Prisma.InputJsonValue;
}

function toEnvelope(row: any): AgentEventEnvelope {
    return {
        id: row.id,
        event: row.event,
        wallet: row.wallet,
        ticketId: row.ticketId ?? undefined,
        dealId: row.dealId ?? undefined,
        timestamp: row.createdAt.toISOString(),
        payload: (row.payload ?? {}) as Record<string, unknown>,
        deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : undefined,
        ackedAt: row.ackedAt ? row.ackedAt.toISOString() : undefined,
        expiresAt: row.expiresAt.toISOString(),
    };
}

function parseDate(value: unknown, field: string): Date | undefined {
    if (!value) return undefined;
    const parsed = new Date(String(value));
    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`${field} must be a valid ISO timestamp`);
    }
    return parsed;
}

function clampLimit(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
    return Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}

export async function enqueueAgentEvent(params: {
    wallet: string;
    event: AgentEventName;
    payload?: Record<string, unknown>;
    ticketId?: string | null;
    dealId?: string | null;
}): Promise<AgentEventEnvelope> {
    const row = await prisma.agentEvent.create({
        data: {
            wallet: params.wallet,
            event: params.event,
            ticketId: params.ticketId || null,
            dealId: params.dealId || null,
            payload: toJsonPayload(params.payload ?? {}),
            expiresAt: new Date(Date.now() + RETENTION_MS),
        },
    });

    return toEnvelope(row);
}

export async function markAgentEventDelivered(wallet: string, id: string): Promise<void> {
    await prisma.agentEvent.updateMany({
        where: {
            id,
            wallet,
            deliveredAt: null,
        },
        data: {
            deliveredAt: new Date(),
        },
    });
}

export async function listAgentEvents(wallet: string, options: {
    events?: unknown;
    since?: unknown;
    cursor?: unknown;
    limit?: unknown;
    includeAcked?: unknown;
} = {}): Promise<{ events: AgentEventEnvelope[]; nextCursor: string | null; hasMore: boolean }> {
    const eventNames = normalizeAgentEventNames(options.events);
    const since = parseDate(options.since, 'since');
    const limit = clampLimit(options.limit);
    const includeAcked = options.includeAcked === true || options.includeAcked === 'true';
    const cursor = typeof options.cursor === 'string' && options.cursor.trim() ? options.cursor.trim() : undefined;

    const where: any = {
        wallet,
        expiresAt: { gt: new Date() },
    };

    if (!includeAcked) {
        where.ackedAt = null;
    }
    if (eventNames?.length) {
        where.event = { in: eventNames };
    }
    if (since) {
        where.createdAt = { gte: since };
    }

    if (cursor) {
        const marker = await prisma.agentEvent.findUnique({
            where: { id: cursor },
            select: { id: true, wallet: true, createdAt: true },
        });
        if (marker?.wallet === wallet) {
            where.OR = [
                { createdAt: { gt: marker.createdAt } },
                { createdAt: marker.createdAt, id: { gt: marker.id } },
            ];
        }
    }

    const rows = await prisma.agentEvent.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
    });

    const page = rows.slice(0, limit).map(toEnvelope);
    return {
        events: page,
        nextCursor: page.length ? page[page.length - 1].id : null,
        hasMore: rows.length > limit,
    };
}

export async function ackAgentEvent(wallet: string, id: string): Promise<boolean> {
    const result = await prisma.agentEvent.updateMany({
        where: {
            id,
            wallet,
            ackedAt: null,
        },
        data: {
            ackedAt: new Date(),
        },
    });
    return result.count > 0;
}

export async function ackAgentEvents(wallet: string, ids: string[]): Promise<{ ackedIds: string[]; count: number }> {
    const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, MAX_LIMIT);
    if (uniqueIds.length === 0) {
        return { ackedIds: [], count: 0 };
    }

    const rows = await prisma.agentEvent.findMany({
        where: {
            wallet,
            id: { in: uniqueIds },
        },
        select: { id: true },
    });
    const ackedIds = rows.map((row) => row.id);
    if (ackedIds.length === 0) {
        return { ackedIds: [], count: 0 };
    }

    const result = await prisma.agentEvent.updateMany({
        where: {
            wallet,
            id: { in: ackedIds },
            ackedAt: null,
        },
        data: {
            ackedAt: new Date(),
        },
    });

    return { ackedIds, count: result.count };
}
