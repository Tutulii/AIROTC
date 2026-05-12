import { beforeEach, describe, expect, it, vi } from 'vitest';

const publishMock = vi.fn();
const subscribeMock = vi.fn();
const createTicketMock = vi.fn();
const addNegotiationStepMock = vi.fn();
const getRequestedRollupModeByAgentMock = vi.fn();
const getOrCreateAgentMock = vi.fn();

vi.mock('../src/services/eventBus', () => ({
  eventBus: {
    subscribe: subscribeMock,
    publish: publishMock,
  },
}));

vi.mock('../src/state/ticketStore', () => ({
  ticketStore: {
    createTicket: createTicketMock,
    getTicket: vi.fn(),
  },
}));

vi.mock('../src/state/negotiationStore', () => ({
  negotiationStore: {
    addNegotiationStep: addNegotiationStepMock,
  },
}));

vi.mock('../src/state/walletRegistry', () => ({
  walletRegistry: {
    getOrCreateAgent: getOrCreateAgentMock,
    getAgentById: vi.fn(),
  },
}));

vi.mock('../src/gateway/sessionManager', () => ({
  sessionManager: {
    getRequestedRollupModeByAgent: getRequestedRollupModeByAgentMock,
  },
}));

vi.mock('../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../src/services/magicBlockSessionManager', () => ({
  magicBlockSessions: {
    resendReady: vi.fn(),
  },
}));

vi.mock('../src/services/releaseApprovalService', () => ({
  releaseApprovalService: {
    processAgentResponse: vi.fn(),
    resendPendingRequests: vi.fn(),
  },
}));

vi.mock('../src/services/confidentialFundingService', () => ({
  confidentialFundingService: {
    resendPendingRequests: vi.fn(),
  },
}));

vi.mock('../src/api/health', () => ({
  SYSTEM_PAUSED: false,
}));

describe('agentMessageListener strict PER bootstrap', () => {
  beforeEach(() => {
    vi.resetModules();
    publishMock.mockReset();
    subscribeMock.mockReset();
    createTicketMock.mockReset();
    addNegotiationStepMock.mockReset();
    getRequestedRollupModeByAgentMock.mockReset();
    getOrCreateAgentMock.mockReset();
    process.env.PER_STRICT_OPAQUE_MODE = 'true';
  });

  it('blocks plaintext offer bootstrapping when the agent requested strict PER mode', async () => {
    getRequestedRollupModeByAgentMock.mockReturnValue('PER');
    getOrCreateAgentMock.mockResolvedValue({ id: 'agent-1' });

    const { initAgentMessageListener } = await import('../src/listeners/agentMessageListener');
    initAgentMessageListener();

    const handler = subscribeMock.mock.calls.find(([eventType]) => eventType === 'agent_message_received')?.[1];
    expect(typeof handler).toBe('function');

    await handler({
      version: '1.0',
      type: 'offer',
      agent_id: 'agent-1',
      timestamp: Date.now(),
      price: 5,
      collateral_buyer: 2,
      collateral_seller: 2,
      asset_type: 'SOL',
    });

    expect(createTicketMock).not.toHaveBeenCalled();
    expect(addNegotiationStepMock).not.toHaveBeenCalled();
    expect(publishMock).toHaveBeenCalledWith(
      'middleman_response',
      expect.objectContaining({
        phase: 'rollup_negotiation',
      }),
    );
  });
});
