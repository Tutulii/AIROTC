import { describe, it, expect, beforeEach, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const prismaMock = vi.hoisted(() => ({
    agent: {
        upsert: vi.fn(),
        findUnique: vi.fn(),
    },
}));

const loggerMock = vi.hoisted(() => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
}));

vi.mock('../src/lib/prisma', () => ({
    prisma: prismaMock,
}));

vi.mock('../src/lib/logger', () => ({
    logger: loggerMock,
}));

type SignedPayload = {
    message: string;
    signature: string;
    publicKey: string;
};

function signPayload(keypair: nacl.SignKeyPair, message: string): SignedPayload {
    return {
        message,
        signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey)),
        publicKey: bs58.encode(keypair.publicKey),
    };
}

async function loadRestAuth(env?: { delegationToken?: string; allowedWallets?: string }) {
    vi.resetModules();

    if (env?.delegationToken) {
        process.env.AIR_OTC_MCP_DELEGATION_TOKEN = env.delegationToken;
    } else {
        delete process.env.AIR_OTC_MCP_DELEGATION_TOKEN;
    }

    if (env?.allowedWallets) {
        process.env.AIR_OTC_MCP_ALLOWED_WALLETS = env.allowedWallets;
    } else {
        delete process.env.AIR_OTC_MCP_ALLOWED_WALLETS;
    }

    return import('../src/middleware/auth');
}

async function callRestAuth(
    authenticateSolana: Awaited<ReturnType<typeof loadRestAuth>>['authenticateSolana'],
    reqPatch: Record<string, any>
) {
    const req = {
        headers: {},
        body: {},
        method: 'POST',
        originalUrl: '/secure',
        ...reqPatch,
    } as any;

    const res: any = {};
    res.status = vi.fn((statusCode: number) => {
        res.statusCode = statusCode;
        return res;
    });
    res.json = vi.fn((body: unknown) => {
        res.body = body;
        return res;
    });

    const next = vi.fn();
    await authenticateSolana(req, res, next);
    return { req, res, next };
}

async function loadWsAuth() {
    vi.resetModules();
    return import('../src/ws/auth');
}

async function callSocketAuth(payload: SignedPayload, url = '/socket.io/?EIO=4&transport=websocket') {
    const { socketAuthenticate } = await loadWsAuth();
    const socket = {
        handshake: {
            auth: {
                message: payload.message,
                signature: payload.signature,
                wallet: payload.publicKey,
            },
            url,
        },
        data: {},
    } as any;
    const next = vi.fn();

    await socketAuthenticate(socket, next);
    return { socket, next };
}

beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    delete process.env.AIR_OTC_MCP_DELEGATION_TOKEN;
    delete process.env.AIR_OTC_MCP_ALLOWED_WALLETS;
});

describe('REST wallet auth challenge binding', () => {
    it('accepts a fresh message bound to the current method and route', async () => {
        const { authenticateSolana } = await loadRestAuth();
        const keypair = nacl.sign.keyPair();
        const payload = signPayload(keypair, `AgentOTC WalletAuth POST /secure ${Date.now()}`);
        prismaMock.agent.upsert.mockResolvedValue({ id: 'agent-1', wallet: payload.publicKey });

        const { req, res, next } = await callRestAuth(authenticateSolana, {
            headers: {
                'x-wallet-auth-message': payload.message,
                'x-wallet-auth-signature': payload.signature,
                'x-wallet-public-key': payload.publicKey,
            },
            originalUrl: '/secure?ignored=1',
        });

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
        expect(req.wallet).toBe(payload.publicKey);
        expect(req.authMethod).toBe('wallet_signature');
    });

    it('accepts route-bound body auth when no wallet auth headers are present', async () => {
        const { authenticateSolana } = await loadRestAuth();
        const keypair = nacl.sign.keyPair();
        const payload = signPayload(keypair, `AgentOTC WalletAuth POST /secure ${Date.now()}`);
        prismaMock.agent.upsert.mockResolvedValue({ id: 'agent-1', wallet: payload.publicKey });

        const { req, next } = await callRestAuth(authenticateSolana, {
            body: payload,
        });

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.wallet).toBe(payload.publicKey);
    });

    it('rejects arbitrary legacy signed messages', async () => {
        const { authenticateSolana } = await loadRestAuth();
        const keypair = nacl.sign.keyPair();
        const payload = signPayload(keypair, `AIR-OTC-AUTH-${Date.now()}`);

        const { res, next } = await callRestAuth(authenticateSolana, {
            headers: {
                'x-wallet-auth-message': payload.message,
                'x-wallet-auth-signature': payload.signature,
                'x-wallet-public-key': payload.publicKey,
            },
        });

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
        expect(prismaMock.agent.upsert).not.toHaveBeenCalled();
    });

    it('rejects stale route-bound messages', async () => {
        const { authenticateSolana } = await loadRestAuth();
        const keypair = nacl.sign.keyPair();
        const staleTimestamp = Date.now() - 6 * 60 * 1000;
        const payload = signPayload(keypair, `AgentOTC WalletAuth POST /secure ${staleTimestamp}`);

        const { res, next } = await callRestAuth(authenticateSolana, {
            headers: {
                'x-wallet-auth-message': payload.message,
                'x-wallet-auth-signature': payload.signature,
                'x-wallet-public-key': payload.publicKey,
            },
        });

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
        expect(prismaMock.agent.upsert).not.toHaveBeenCalled();
    });

    it('rejects messages replayed across routes', async () => {
        const { authenticateSolana } = await loadRestAuth();
        const keypair = nacl.sign.keyPair();
        const payload = signPayload(keypair, `AgentOTC WalletAuth POST /v1/offers ${Date.now()}`);

        const { res, next } = await callRestAuth(authenticateSolana, {
            headers: {
                'x-wallet-auth-message': payload.message,
                'x-wallet-auth-signature': payload.signature,
                'x-wallet-public-key': payload.publicKey,
            },
            originalUrl: '/secure',
        });

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(401);
        expect(prismaMock.agent.upsert).not.toHaveBeenCalled();
    });

    it('keeps API key auth working', async () => {
        const { authenticateSolana, generateApiKey } = await loadRestAuth();
        const { raw, hash } = generateApiKey();
        prismaMock.agent.findUnique.mockResolvedValue({ id: 'agent-api', wallet: 'api-wallet' });

        const { req, res, next } = await callRestAuth(authenticateSolana, {
            headers: {
                authorization: `Bearer ${raw}`,
            },
        });

        expect(prismaMock.agent.findUnique).toHaveBeenCalledWith({ where: { apiKeyHash: hash } });
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
        expect(req.wallet).toBe('api-wallet');
        expect(req.authMethod).toBe('api_key');
    });

    it('keeps MCP delegated-wallet auth working', async () => {
        const keypair = nacl.sign.keyPair();
        const delegatedWallet = bs58.encode(keypair.publicKey);
        const { authenticateSolana } = await loadRestAuth({
            delegationToken: 'delegation-token',
            allowedWallets: delegatedWallet,
        });
        prismaMock.agent.upsert.mockResolvedValue({ id: 'agent-mcp', wallet: delegatedWallet });

        const { req, res, next } = await callRestAuth(authenticateSolana, {
            headers: {
                'x-airotc-mcp-delegation-token': 'delegation-token',
                'x-airotc-delegated-wallet': delegatedWallet,
            },
        });

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
        expect(req.wallet).toBe(delegatedWallet);
        expect(req.authMethod).toBe('mcp_delegated_wallet');
    });
});

describe('WebSocket wallet auth challenge binding', () => {
    it('accepts a fresh message bound to the Socket.IO endpoint and WS protocol', async () => {
        const keypair = nacl.sign.keyPair();
        const payload = signPayload(keypair, `AgentOTC WalletAuth WS /socket.io ${Date.now()}`);

        const { socket, next } = await callSocketAuth(payload);

        expect(next).toHaveBeenCalledWith();
        expect(socket.data.wallet).toBe(payload.publicKey);
    });

    it('rejects arbitrary legacy signed WebSocket messages', async () => {
        const keypair = nacl.sign.keyPair();
        const payload = signPayload(keypair, `AIR-OTC-WS-${Date.now()}`);

        const { next } = await callSocketAuth(payload);

        expect(next).toHaveBeenCalledTimes(1);
        expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
        expect(next.mock.calls[0][0].message).toContain('WebSocket-bound AgentOTC challenge');
    });

    it('rejects WebSocket messages replayed across endpoints', async () => {
        const keypair = nacl.sign.keyPair();
        const payload = signPayload(keypair, `AgentOTC WalletAuth WS /v1/offers ${Date.now()}`);

        const { next } = await callSocketAuth(payload);

        expect(next).toHaveBeenCalledTimes(1);
        expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
        expect(next.mock.calls[0][0].message).toContain('WebSocket-bound AgentOTC challenge');
    });
});
