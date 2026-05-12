import { WsClient } from '../shared/wsClient';
import { WsMessage } from '../shared/types';

export abstract class AgentStateMachine<T> {
    protected state: T;
    protected role: string;

    constructor(initialState: T, role: string) {
        this.state = initialState;
        this.role = role;
        this.logTransition(initialState);
    }

    public getState(): T {
        return this.state;
    }

    public transition(newState: T): void {
        this.logTransition(newState);
        this.state = newState;
    }

    private logTransition(newState: T): void {
        console.log(`[${this.role}] State → ${String(newState)}`);
    }

    public logActivity(activity: string): void {
        console.log(`[${this.role}] ${activity}`);
    }

    public logError(error: string): void {
        console.error(`[${this.role}] ❌ ERROR: ${error}`);
    }

    public abstract handleIncomingMessage(msg: WsMessage, client: WsClient): Promise<void>;
}
