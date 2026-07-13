import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const subscribeMock = vi.fn();
const getDealMock = vi.fn();
const getAgentByIdMock = vi.fn();
const logger = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
};

vi.mock('../src/services/eventBus', () => ({
    eventBus: {
        subscribe: subscribeMock,
    },
}));

vi.mock('../core/dealPhaseManager', () => ({
    dealPhaseManager: {
        getDeal: getDealMock,
    },
}));

vi.mock('../src/state/walletRegistry', () => ({
    walletRegistry: {
        getAgentById: getAgentByIdMock,
    },
}));

vi.mock('../src/utils/logger', () => ({
    logger,
}));

describe('Observatory bridge authentication', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        process.env.NODE_ENV = 'test';
        delete process.env.BRIDGE_SECRET;
        process.env.OBSERVATORY_API_URL = 'http://observatory.test';
    });

    afterEach(() => {
        delete process.env.OBSERVATORY_API_URL;
        delete process.env.BRIDGE_SECRET;
    });

    it('signs observatory bridge writes before syncing offers and tickets', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({
                ok: false,
                json: async () => ({ error: 'Ticket not found' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ data: { id: 'offer-1' } }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ data: { id: 'ticket-1' } }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ success: true }),
            });
        vi.stubGlobal('fetch', fetchMock as any);

        getDealMock.mockReturnValue({
            buyer: 'buyer-agent-id',
            seller: 'seller-agent-id',
            terms: { price: 5, collateral_buyer: 2 },
        });
        getAgentByIdMock
            .mockResolvedValueOnce({ wallet: 'buyer-wallet' })
            .mockResolvedValueOnce({ wallet: 'seller-wallet' });

        const { initObservatoryBridge } = await import('../src/services/observatoryBridge');
        initObservatoryBridge();

        const phaseChangedHandler = subscribeMock.mock.calls.find(
            ([eventType]) => eventType === 'phase_changed',
        )?.[1];

        expect(typeof phaseChangedHandler).toBe('function');

        await phaseChangedHandler({
            ticket_id: 'ticket-alpha',
            from_phase: 'negotiation',
            to_phase: 'delivery',
            triggered_by: 'system',
            action: 'AUTO',
            timestamp: new Date().toISOString(),
        });

        expect(fetchMock).toHaveBeenCalledTimes(4);
        const [lookupUrl, lookupInit] = fetchMock.mock.calls[0] as [string, RequestInit];
        const [offerUrl, offerInit] = fetchMock.mock.calls[1] as [string, RequestInit];
        const [ticketUrl, ticketInit] = fetchMock.mock.calls[2] as [string, RequestInit];
        const [statusUrl, statusInit] = fetchMock.mock.calls[3] as [string, RequestInit];

        expect(lookupUrl).toBe('http://observatory.test/v1/bridge/ticket/ticket-alpha');
        expect(lookupInit.method).toBe('GET');
        expect(offerUrl).toBe('http://observatory.test/v1/bridge/offer');
        expect(ticketUrl).toBe('http://observatory.test/v1/bridge/ticket');
        expect(statusUrl).toBe('http://observatory.test/v1/bridge/ticket/ticket-1');
        expect(offerInit.headers).toMatchObject({
            'Content-Type': 'application/json',
        });
        expect(ticketInit.headers).toMatchObject({
            'Content-Type': 'application/json',
        });
        expect(statusInit.headers).toMatchObject({
            'Content-Type': 'application/json',
        });
        expect((offerInit.headers as Record<string, string>)['X-Bridge-Signature']).toBeTruthy();
        expect((offerInit.headers as Record<string, string>)['X-Bridge-Timestamp']).toBeTruthy();
        expect((ticketInit.headers as Record<string, string>)['X-Bridge-Signature']).toBeTruthy();
        expect((ticketInit.headers as Record<string, string>)['X-Bridge-Timestamp']).toBeTruthy();
        expect((statusInit.headers as Record<string, string>)['X-Bridge-Signature']).toBeTruthy();
        expect((statusInit.headers as Record<string, string>)['X-Bridge-Timestamp']).toBeTruthy();

        vi.unstubAllGlobals();
    });

    it('reuses marketplace ticket mappings and syncs completed as completed without placeholder mirroring', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ success: true }),
            });
        vi.stubGlobal('fetch', fetchMock as any);

        const { initObservatoryBridge, registerObservatoryTicketMapping } = await import('../src/services/observatoryBridge');
        registerObservatoryTicketMapping({
            middlemanTicketId: 'ticket-marketplace',
            observatoryTicketId: 'ticket-marketplace',
        });
        initObservatoryBridge();

        const phaseChangedHandler = subscribeMock.mock.calls.find(
            ([eventType]) => eventType === 'phase_changed',
        )?.[1];

        await phaseChangedHandler({
            ticket_id: 'ticket-marketplace',
            from_phase: 'delivery',
            to_phase: 'completed',
            triggered_by: 'system',
            action: 'AUTO',
            timestamp: new Date().toISOString(),
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [statusUrl, statusInit] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(statusUrl).toBe('http://observatory.test/v1/bridge/ticket/ticket-marketplace');
        expect(JSON.parse(String(statusInit.body))).toMatchObject({ status: 'completed' });

        vi.unstubAllGlobals();
    });

    it('syncs confirmed settled pipeline stages as completed in the observatory bridge', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ success: true }),
            });
        vi.stubGlobal('fetch', fetchMock as any);

        const { initObservatoryBridge, registerObservatoryTicketMapping } = await import('../src/services/observatoryBridge');
        registerObservatoryTicketMapping({
            middlemanTicketId: 'ticket-pipeline',
            observatoryTicketId: 'ticket-pipeline',
        });
        initObservatoryBridge();

        const pipelineHandler = subscribeMock.mock.calls.find(
            ([eventType]) => eventType === 'deal_pipeline_stage_changed',
        )?.[1];

        expect(typeof pipelineHandler).toBe('function');

        await pipelineHandler({
            ticketId: 'ticket-pipeline',
            stage: 'settled',
            status: 'confirmed',
            route: 'CONFIDENTIAL_ESCROW',
            executionPolicy: 'CONFIDENTIAL',
            settlementPolicy: 'STEALTH',
            negotiationSource: 'PER',
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [statusUrl, statusInit] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(statusUrl).toBe('http://observatory.test/v1/bridge/ticket/ticket-pipeline');
        expect(JSON.parse(String(statusInit.body))).toMatchObject({ status: 'completed' });

        vi.unstubAllGlobals();
    });

    it('syncs settled deal_executed events as completed instead of falling back to negotiating', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ success: true }),
            });
        vi.stubGlobal('fetch', fetchMock as any);

        const { initObservatoryBridge, registerObservatoryTicketMapping } = await import('../src/services/observatoryBridge');
        registerObservatoryTicketMapping({
            middlemanTicketId: 'ticket-settled-deal',
            observatoryTicketId: 'ticket-settled-deal',
        });
        initObservatoryBridge();

        const dealExecutedHandler = subscribeMock.mock.calls.find(
            ([eventType]) => eventType === 'deal_executed',
        )?.[1];

        expect(typeof dealExecutedHandler).toBe('function');

        await dealExecutedHandler({
            ticket_id: 'ticket-settled-deal',
            status: 'settled',
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [statusUrl, statusInit] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(statusUrl).toBe('http://observatory.test/v1/bridge/ticket/ticket-settled-deal');
        expect(JSON.parse(String(statusInit.body))).toMatchObject({ status: 'completed' });

        vi.unstubAllGlobals();
    });
});
