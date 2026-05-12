/**
 * The base error class for AgentOTC SDK.
 */
export class AgentOTCError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AgentOTCError';
    }
}

/** Thrown when authentication fails (e.g. invalid API key). */
export class AuthenticationError extends AgentOTCError {
    public readonly reason: string;
    constructor(message: string, reason: string) {
        super(message);
        this.name = 'AuthenticationError';
        this.reason = reason;
    }
}

/** Thrown when network connection is terminally lost after retries. */
export class NetworkDisconnectError extends AgentOTCError {
    public readonly retryCount: number;
    public readonly lastError: Error | unknown;
    constructor(message: string, retryCount: number, lastError: Error | unknown) {
        super(message);
        this.name = 'NetworkDisconnectError';
        this.retryCount = retryCount;
        this.lastError = lastError;
    }
}

/** Thrown when an action is attempted but the deal is not in the correct phase. */
export class PhaseViolationError extends AgentOTCError {
    public readonly currentPhase: string;
    public readonly expectedPhase: string | string[];
    constructor(message: string, currentPhase: string, expectedPhase: string | string[]) {
        super(`Phase Violation: ${message}. Current: ${currentPhase}, Expected: ${expectedPhase}`);
        this.name = 'PhaseViolationError';
        this.currentPhase = currentPhase;
        this.expectedPhase = expectedPhase;
    }
}

/** Thrown when an agent attempts to lock collateral or payment but lacks funds. */
export class InsufficientFundsError extends AgentOTCError {
    public readonly availableSol: number;
    public readonly requiredSol: number;
    constructor(message: string, availableSol: number, requiredSol: number) {
        super(message);
        this.name = 'InsufficientFundsError';
        this.availableSol = availableSol;
        this.requiredSol = requiredSol;
    }
}

/** Thrown when an asynchronous awaited action (like phase transition) exceeds timeout limit. */
export class TimeoutError extends AgentOTCError {
    public readonly waitedMs: number;
    public readonly target: string;
    constructor(message: string, waitedMs: number, target: string) {
        super(message);
        this.name = 'TimeoutError';
        this.waitedMs = waitedMs;
        this.target = target;
    }
}

/** Thrown when an on-chain Solana transaction execution fails. */
export class OnChainExecutionError extends AgentOTCError {
    public readonly txSignature?: string;
    public readonly logs?: string[];
    constructor(message: string, txSignature?: string, logs?: string[]) {
        super(message);
        this.name = 'OnChainExecutionError';
        this.txSignature = txSignature;
        this.logs = logs;
    }
}
