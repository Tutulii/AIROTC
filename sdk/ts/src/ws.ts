import WebSocket from 'ws';
import { EventEmitter } from 'events';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { NetworkDisconnectError } from './errors';

export interface WSClientConfig {
    wsUrl: string;
    apiKey?: string;
    keypair: Keypair;
}

/**
 * Internal WebSocket Manager that handles reconnections and ping/pong.
 * Event emitters hide the underlying WS disconnects entirely.
 */
export class WsManager extends EventEmitter {
    private ws: WebSocket | null = null;
    private config: WSClientConfig;
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 10;
    private isManuallyClosed: boolean = false;
    public isConnected: boolean = false;

    constructor(config: WSClientConfig) {
        super();
        this.config = config;
    }

    public connect(): Promise<void> {
        this.isManuallyClosed = false;

        return new Promise((resolve, reject) => {
            if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
                resolve();
                return;
            }

            // Using standard WSS + headers approach for API key auth via middleman API gateway standard.
            // If Middleman requires standard raw auth packet, we send it on 'open'.
            this.ws = new WebSocket(this.config.wsUrl);

            const timeoutId = setTimeout(() => {
                if (this.ws?.readyState !== WebSocket.OPEN) {
                    this.ws?.close();
                    reject(new NetworkDisconnectError("WebSocket connection timeout", this.reconnectAttempts, null));
                }
            }, 10000);

            this.ws.on('open', () => {
                clearTimeout(timeoutId);
                this.isConnected = true;
                this.reconnectAttempts = 0;
                // Don't send auth yet — wait for auth_challenge from Middleman
            });

            this.ws.on('message', (data: WebSocket.RawData) => {
                try {
                    const msg = JSON.parse(data.toString());

                    // Step 1: Middleman sends auth_challenge → sign it with our keypair
                    if (msg.type === 'auth_challenge' && msg.challenge) {
                        const messageBytes = Buffer.from(msg.challenge, 'utf-8');
                        const signature = nacl.sign.detached(messageBytes, this.config.keypair.secretKey);
                        this.ws?.send(JSON.stringify({
                            type: 'auth_response',
                            wallet: this.config.keypair.publicKey.toBase58(),
                            signature: bs58.encode(signature),
                        }));
                        return;
                    }

                    // Step 2: Auth result
                    if (msg.type === 'auth_success' || msg.event_type === 'auth_success') {
                        this.emit('authenticated', msg);
                        resolve();
                    } else if (msg.type === 'auth_failed') {
                        reject(new Error("Authentication failed via WS"));
                    } else {
                        // Forward all valid internal protocol messages
                        this.emit('message', msg);
                    }
                } catch {
                    // ignore malformed payloads
                }
            });

            this.ws.on('close', (code, reason) => {
                this.isConnected = false;
                clearTimeout(timeoutId);
                this.emit('disconnect', { code, reason: reason.toString() });

                if (!this.isManuallyClosed) {
                    this.attemptReconnect();
                }
            });

            this.ws.on('error', (err) => {
                // error usually immediately followed by close
                this.emit('system_error', err);
            });
        });
    }

    private attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.emit('terminal_disconnect', new NetworkDisconnectError("Max WS reconnection attempts reached", this.reconnectAttempts, null));
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(3000 * Math.pow(2, this.reconnectAttempts - 1), 30000); // Max 30s backoff
        
        setTimeout(() => {
            if (!this.isManuallyClosed) {
                this.connect().catch(() => {});
            }
        }, delay);
    }

    public send(payload: any): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
        } else {
            console.warn('[AgentOTC SDK] Warning: Tried to send on disconnected WS. Payload dropped.');
            // Note: A robust implementation in production might queue the payload instead.
        }
    }

    public disconnect(): void {
        this.isManuallyClosed = true;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}
