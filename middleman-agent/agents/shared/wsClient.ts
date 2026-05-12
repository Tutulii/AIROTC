import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { AgentConfig, WsMessage } from './types';
import { createAuthPayload } from './auth';

export class WsClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private config: AgentConfig;
    public authenticated: boolean = false;

    // Reconnection hardening
    private reconnectAttempts: number = 0;
    private maxReconnectDelay: number = 30_000; // cap at 30s
    private baseReconnectDelay: number = 3_000;  // start at 3s
    private _wasSessionReplaced: boolean = false;
    private _connectionCount: number = 0;

    constructor(config: AgentConfig) {
        super();
        this.config = config;
    }

    /** Whether this is a reconnection (not the first connect) */
    public get isReconnection(): boolean {
        return this._connectionCount > 1;
    }

    /** Whether last disconnect was due to "Session Replaced" */
    public get wasSessionReplaced(): boolean {
        return this._wasSessionReplaced;
    }

    public connect() {
        // Clean up previous socket if it exists to prevent event listener leaks
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                this.ws.close();
            }
            this.ws = null;
        }

        this._connectionCount++;
        this._wasSessionReplaced = false;
        this.ws = new WebSocket(this.config.wsUrl);

        this.ws.on('open', () => {
            console.log(`[${this.config.role}] Connected (attempt #${this._connectionCount})`);
            this.reconnectAttempts = 0; // reset backoff on successful connect
            this.emit('open');
        });

        this.ws.on('message', (data: WebSocket.RawData) => {
            const raw = data.toString();
            try {
                const msg: WsMessage = JSON.parse(raw);

                // Handle auth challenge
                if (msg.type === 'auth_challenge' || msg.event_type === 'auth_challenge' || msg.challenge) {
                    const challenge = msg.challenge || msg.payload?.challenge;
                    if (challenge) {
                        this.authenticate(challenge);
                    }
                }
                // Handle auth success
                else if (msg.type === 'auth_success' || msg.event_type === 'auth_success') {
                    this.authenticated = true;
                    console.log(`[${this.config.role}] Authenticated`);
                    this.emit('authenticated');
                }
                // Intercept server-side error messages (e.g. "Session Replaced")
                // These arrive as normal messages with type="error", NOT as WebSocket errors
                else if (msg.type === 'error') {
                    const errorStr = msg.error || msg.details || 'unknown';
                    console.warn(`[${this.config.role}] Server error: ${errorStr}`);

                    if (typeof errorStr === 'string' && errorStr.includes('Session Replaced')) {
                        this._wasSessionReplaced = true;
                    }

                    // Still emit so the agent can react if needed
                    this.emit('server_error', msg);
                }
                else {
                    this.emit('message', msg);
                }
            } catch (e) {
                console.error(`[${this.config.role}] Failed to parse message`, e);
            }
        });

        this.ws.on('close', (code: number, reason: Buffer) => {
            const reasonStr = reason?.toString() || '';
            this.authenticated = false;

            // If session was replaced, wait longer before reconnecting
            // to let the newer session fully stabilize
            if (code === 1008 && reasonStr.includes('Session Replaced')) {
                this._wasSessionReplaced = true;
                console.log(`[${this.config.role}] Session replaced by server. Waiting 10s before reconnect...`);
                this.emit('close', code, reasonStr);
                setTimeout(() => this.connect(), 10_000);
                return;
            }

            // Exponential backoff: 3s, 6s, 12s, 24s, capped at 30s
            this.reconnectAttempts++;
            const delay = Math.min(
                this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
                this.maxReconnectDelay
            );

            console.log(`[${this.config.role}] Disconnected (code=${code}, reason="${reasonStr}"). Reconnecting in ${(delay / 1000).toFixed(1)}s...`);
            this.emit('close', code, reasonStr);
            setTimeout(() => this.connect(), delay);
        });

        this.ws.on('error', (err) => {
            // Don't log ECONNREFUSED as a scary error — it's normal during reconnection
            if ((err as any).code === 'ECONNREFUSED') {
                console.warn(`[${this.config.role}] Server not reachable, will retry...`);
            } else {
                console.error(`[${this.config.role}] WS Error:`, err.message);
            }
            // Note: 'error' is always followed by 'close', so reconnect happens in close handler
        });
    }

    private authenticate(challenge: string) {
        const payload = createAuthPayload(this.config.keypair, challenge);
        this.send(payload);
    }

    public send(msg: any) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }
}
