export const WALLET_AUTH_MAX_AGE_MS = 5 * 60 * 1000;
export const WALLET_AUTH_PREFIX = 'AgentOTC WalletAuth';
export const SOCKET_IO_AUTH_PATH = '/socket.io';

type WalletAuthChallenge = {
    method: string;
    path: string;
    timestamp: number;
};

function normalizeChallengePath(path: string): string {
    const withoutQuery = path.split('?')[0] || '/';
    if (withoutQuery.length > 1 && withoutQuery.endsWith('/')) {
        return withoutQuery.slice(0, -1);
    }
    return withoutQuery;
}

export function parseWalletAuthChallenge(message: string): WalletAuthChallenge | null {
    const parts = message.split(' ');
    if (
        parts.length !== 5 ||
        parts[0] !== 'AgentOTC' ||
        parts[1] !== 'WalletAuth' ||
        !parts[2] ||
        !parts[3] ||
        !parts[4]
    ) {
        return null;
    }

    const timestamp = Number(parts[4]);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
        return null;
    }

    if (!parts[3].startsWith('/')) {
        return null;
    }

    return {
        method: parts[2].toUpperCase(),
        path: normalizeChallengePath(parts[3]),
        timestamp,
    };
}

export function isWalletAuthChallengeBound(
    message: string,
    expectedMethod: string,
    expectedPath: string,
    now = Date.now()
): boolean {
    const challenge = parseWalletAuthChallenge(message);
    if (!challenge) {
        return false;
    }

    return (
        Math.abs(now - challenge.timestamp) <= WALLET_AUTH_MAX_AGE_MS &&
        challenge.method === expectedMethod.toUpperCase() &&
        challenge.path === normalizeChallengePath(expectedPath)
    );
}
