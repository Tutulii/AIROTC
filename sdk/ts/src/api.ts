import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { OfferCreationParams, OfferData, TicketData, DealStatusData, NegotiationMessage, RegistrationResult, AgentProfile, WebhookConfig, WebhookEventName } from './types';
import { AuthenticationError, AgentOTCError } from './errors';

export class ApiClient {
    private apiUrl: string;
    private apiKey: string | null;
    private keypair: Keypair | null;

    constructor(apiUrl: string, auth: { apiKey?: string; keypair?: Keypair }) {
        this.apiUrl = apiUrl.replace(/\/+$/, '');
        this.apiKey = auth.apiKey || null;
        this.keypair = auth.keypair || null;
    }

    private buildWalletAuthHeaders(method: string, endpoint: string): Record<string, string> {
        if (!this.keypair) {
            return {};
        }

        const timestamp = Date.now();
        const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
        const message = `AgentOTC WalletAuth ${method.toUpperCase()} ${normalizedEndpoint} ${timestamp}`;
        const signature = nacl.sign.detached(
            new TextEncoder().encode(message),
            this.keypair.secretKey
        );

        return {
            'x-wallet-auth-message': message,
            'x-wallet-auth-signature': bs58.encode(signature),
            'x-wallet-public-key': this.keypair.publicKey.toBase58(),
        };
    }

    private getHeaders(method: string, endpoint: string): Record<string, string> {
        const authHeaders: Record<string, string> = this.apiKey
            ? { 'Authorization': `Bearer ${this.apiKey}` }
            : this.buildWalletAuthHeaders(method, endpoint);

        return {
            'Content-Type': 'application/json',
            ...authHeaders,
            'User-Agent': 'AgentOTC-TS/1.0.0',
        };
    }

    private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
        const url = `${this.apiUrl}${endpoint}`;
        const method = options.method || 'GET';

        try {
            const response = await fetch(url, {
                ...options,
                headers: {
                    ...this.getHeaders(method, endpoint),
                    ...options.headers,
                }
            });

            const data = await response.json().catch(() => null);

            if (!response.ok) {
                if (response.status === 401 || response.status === 403) {
                    throw new AuthenticationError(
                        data?.error || `Authentication failed with status ${response.status}`,
                        data?.details || response.statusText
                    );
                }

                throw new AgentOTCError(`API Request failed (${response.status}): ${data?.error || response.statusText}`);
            }

            return data as T;
        } catch (error: any) {
            if (error instanceof AgentOTCError) {
                throw error;
            }
            throw new AgentOTCError(`Network or parsing error: ${error.message}`);
        }
    }

    // --- Offers ---

    /** Fetch all active offers on the marketplace */
    public async listOffers(params?: { asset?: string; mode?: string; status?: string }): Promise<OfferData[]> {
        const urlParams = new URLSearchParams();
        if (params?.asset) urlParams.append('asset', params.asset);
        if (params?.mode) urlParams.append('mode', params.mode);
        if (params?.status) urlParams.append('status', params.status);

        const qs = urlParams.toString();
        const endpoint = `/v1/offers${qs ? `?${qs}` : ''}`;

        const res = await this.request<{ success: boolean; data: OfferData[] }>(endpoint);
        return res.data || [];
    }

    /** Fetch the authenticated wallet's own offers. */
    public async listMyOffers(params?: { status?: string }): Promise<OfferData[]> {
        const urlParams = new URLSearchParams();
        if (params?.status) urlParams.append('status', params.status);
        const qs = urlParams.toString();
        const endpoint = `/v1/offers/mine${qs ? `?${qs}` : ''}`;
        const res = await this.request<{ success: boolean; data: OfferData[] }>(endpoint);
        return res.data || [];
    }

    /** Fetch a single offer by ID, including its matched ticket when present. */
    public async getOffer(offerId: string): Promise<OfferData> {
        const res = await this.request<{ success: boolean; data: OfferData }>(`/v1/offers/${offerId}`);
        return res.data;
    }

    /** Create a new offer on the marketplace */
    public async createOffer(params: OfferCreationParams): Promise<OfferData> {
        const res = await this.request<{ success: boolean; data: OfferData }>('/v1/offers', {
            method: 'POST',
            body: JSON.stringify(params)
        });
        return res.data;
    }

    /** Cancel an offer owned by the authenticated wallet. */
    public async cancelOffer(offerId: string): Promise<OfferData> {
        const res = await this.request<{ success: boolean; data: OfferData }>(`/v1/offers/${offerId}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'cancelled' }),
        });
        return res.data;
    }

    /** Accept an existing offer */
    public async acceptOffer(offerId: string): Promise<TicketData> {
        const res = await this.request<{ success: boolean; ticket: TicketData }>(`/v1/offers/${offerId}/accept`, {
            method: 'POST'
        });
        return res.ticket;
    }

    // --- Tickets (Deals) ---

    /** Get negotiation messages for a deal */
    public async getMessages(ticketId: string): Promise<NegotiationMessage[]> {
        const res = await this.request<{ success: boolean; data: NegotiationMessage[] }>(`/v1/tickets/${ticketId}/messages`);
        return res.data;
    }

    /** Send a negotiation message immediately to the backend via REST (Alternative to WS) */
    public async sendMessage(ticketId: string, content: string): Promise<NegotiationMessage> {
        const res = await this.request<{ success: boolean; data: NegotiationMessage }>(`/v1/tickets/${ticketId}/messages`, {
            method: 'POST',
            body: JSON.stringify({ content })
        });
        return res.data;
    }

    /** View detailed on-chain status for a deal */
    public async getDealStatus(ticketId: string): Promise<DealStatusData> {
        const res = await this.request<{ success: boolean; data?: DealStatusData; deal?: any }>(`/v1/tickets/${ticketId}/deal-status`);
        // API returns { deal: { phase, escrow_pda, ... } } — normalize to DealStatusData
        const raw = res.data || res.deal;
        return {
            ticketId,
            phase: raw?.phase || 'unknown',
            buyer: raw?.buyer,
            seller: raw?.seller,
            escrowAddress: raw?.escrow_pda || raw?.escrowAddress || null,
            details: raw?.terms ? JSON.stringify(raw.terms) : undefined,
        };
    }

    /** Fetch the canonical ticket participants from the API server. */
    public async getTicket(ticketId: string): Promise<TicketData> {
        const res = await this.request<{ success: boolean; ticket: TicketData }>(`/v1/tickets/${ticketId}`);
        return res.ticket;
    }

    // --- Agent Registry ---

    /**
     * Register a new agent on the AgentOTC platform.
     * This is intentionally a STATIC method because you don't have an API key yet —
     * the API key is the OUTPUT of this call.
     *
     * @param apiUrl - The base API URL (e.g. 'http://localhost:3000')
     * @param wallet - The Solana wallet public key (base58) to register.
     * @returns RegistrationResult including the one-time API key if newly created.
     */
    public static async register(apiUrl: string, wallet: string): Promise<RegistrationResult> {
        const url = `${apiUrl.replace(/\/+$/, '')}/v1/agents/register`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'AgentOTC-TS/1.0.0'
                },
                body: JSON.stringify({ wallet })
            });

            const data = await response.json().catch(() => null);

            if (!response.ok) {
                throw new AgentOTCError(
                    `Registration failed (${response.status}): ${data?.error || response.statusText}`
                );
            }

            return data as RegistrationResult;
        } catch (error: any) {
            if (error instanceof AgentOTCError) throw error;
            throw new AgentOTCError(`Registration network error: ${error.message}`);
        }
    }

    /** Fetch the full reputation profile for any agent by wallet address. */
    public async getAgentProfile(wallet: string): Promise<AgentProfile> {
        return this.request<AgentProfile>(`/v1/agents/${wallet}`);
    }

    /** 
     * Configure the webhook URL for receiving push notifications about deal events.
     * Set webhookUrl to null to remove the webhook.
     * Requires wallet signature authentication (Ed25519).
     */
    public async configureWebhook(webhookUrl: string | null, signaturePayload: {
        message: string;
        signature: string;
        publicKey: string;
    }, options?: {
        events?: WebhookEventName[] | null;
    }): Promise<WebhookConfig> {
        const res = await this.request<{ success: boolean } & WebhookConfig>('/v1/agents/webhook', {
            method: 'PUT',
            body: JSON.stringify({
                webhookUrl,
                events: options?.events,
                ...signaturePayload
            })
        });
        return res;
    }

    // ─── Generic accessors for new features ───

    /** Generic GET request (used by Deal for privacy endpoints) */
    public async get<T>(endpoint: string): Promise<T> {
        return this.request<T>(endpoint);
    }

    /** Generic POST request (used by Deal for privacy endpoints) */
    public async post<T>(endpoint: string, body: any): Promise<T> {
        return this.request<T>(endpoint, {
            method: 'POST',
            body: JSON.stringify(body),
        });
    }

    /** Generic DELETE request (used by DM for message deletion) */
    public async del<T>(endpoint: string): Promise<T> {
        return this.request<T>(endpoint, {
            method: 'DELETE',
        });
    }

    /** Multipart form upload (used by DM for file attachments) */
    public async postForm<T>(endpoint: string, formData: FormData): Promise<T> {
        const url = `${this.apiUrl}${endpoint}`;
        const authHeaders: Record<string, string> = this.apiKey
            ? { 'Authorization': `Bearer ${this.apiKey}` }
            : this.buildWalletAuthHeaders('POST', endpoint);

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    ...authHeaders,
                    'User-Agent': 'AgentOTC-TS/1.0.0',
                    // NOTE: Do NOT set Content-Type — fetch auto-sets it with boundary for FormData
                },
                body: formData,
            });

            const data = await response.json().catch(() => null);

            if (!response.ok) {
                if (response.status === 401 || response.status === 403) {
                    throw new AuthenticationError(
                        data?.error || `Authentication failed with status ${response.status}`,
                        data?.details || response.statusText
                    );
                }
                throw new AgentOTCError(`Upload failed (${response.status}): ${data?.error || response.statusText}`);
            }

            return data as T;
        } catch (error: any) {
            if (error instanceof AgentOTCError) throw error;
            throw new AgentOTCError(`Upload error: ${error.message}`);
        }
    }

    /** Binary file download (used by DM for file attachments) */
    public async downloadFile(endpoint: string): Promise<{ data: ArrayBuffer; filename: string; checksum: string }> {
        const url = `${this.apiUrl}${endpoint}`;
        const authHeaders: Record<string, string> = this.apiKey
            ? { 'Authorization': `Bearer ${this.apiKey}` }
            : this.buildWalletAuthHeaders('GET', endpoint);

        try {
            const response = await fetch(url, {
                headers: {
                    ...authHeaders,
                    'User-Agent': 'AgentOTC-TS/1.0.0',
                },
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => null);
                throw new AgentOTCError(
                    `Download failed (${response.status}): ${errorData?.error || response.statusText}`
                );
            }

            // Extract metadata from headers
            const disposition = response.headers.get('Content-Disposition') || '';
            const filenameMatch = disposition.match(/filename="(.+?)"/);
            const filename = filenameMatch?.[1] || 'download';
            const checksum = response.headers.get('X-Checksum-SHA256') || '';

            const data = await response.arrayBuffer();

            return { data, filename, checksum };
        } catch (error: any) {
            if (error instanceof AgentOTCError) throw error;
            throw new AgentOTCError(`Download error: ${error.message}`);
        }
    }
}
