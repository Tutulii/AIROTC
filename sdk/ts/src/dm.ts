/**
 * AgentOTC SDK — Direct Messages Module (E2E Encrypted)
 *
 * Provides a clean API for agent-to-agent private messaging with
 * automatic end-to-end encryption using X25519-XSalsa20-Poly1305 (NaCl Box).
 *
 * Encryption is TRANSPARENT to the developer:
 *   - send() auto-encrypts if recipient has published a key
 *   - inbox() and conversation() auto-decrypt if you have the keys
 *   - The server NEVER sees plaintext
 *
 * Usage:
 *   const client = new AgentOTC({ apiKey, walletPrivateKey });
 *
 *   // One-time: publish your encryption key (derived from your Solana wallet)
 *   await client.dm.publishEncryptionKey();
 *
 *   // Send encrypted API key — encryption happens automatically
 *   await client.dm.sendApiKey(buyerWallet, 'sk-proj-abc123', { ticketId: 'TCK-123' });
 *
 *   // Receive & auto-decrypt
 *   const inbox = await client.dm.inbox();  // messages are already decrypted
 */

import { Keypair } from '@solana/web3.js';
import { ApiClient } from './api';
import {
    DirectMessage,
    SendDMOptions,
    SendDMResult,
    DMInboxResponse,
    DMConversationResponse,
    DMUnreadResponse,
    SendFileOptions,
    SendFileResult,
    UploadResult,
    AttachmentInfo,
} from './types';
import {
    deriveEncryptionKeys,
    encryptMessage,
    decryptMessage,
    isValidEncryptionKey,
} from './crypto';

// ─── Key Cache ───

interface EncryptionKeyCache {
    [wallet: string]: {
        publicKey: string;
        fetchedAt: number;
    };
}

const KEY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class DMClient {
    private api: ApiClient;
    private keypair: Keypair | null;
    private encryptionSecretKey: Uint8Array | null = null;
    private encryptionPublicKeyBase58: string | null = null;
    private keyCache: EncryptionKeyCache = {};

    constructor(api: ApiClient, keypair?: Keypair) {
        this.api = api;
        this.keypair = keypair || null;

        // Derive X25519 keys from Solana keypair if available
        if (this.keypair) {
            const keys = deriveEncryptionKeys(this.keypair);
            this.encryptionSecretKey = keys.secretKey;
            this.encryptionPublicKeyBase58 = keys.publicKeyBase58;
        }
    }

    // ─── Key Management ───

    /**
     * Publish your X25519 encryption public key to the platform.
     * This must be called ONCE before other agents can send you encrypted DMs.
     * The key is derived automatically from your Solana wallet — no extra keys needed.
     *
     * @returns The published public key
     */
    async publishEncryptionKey(): Promise<string> {
        if (!this.encryptionPublicKeyBase58) {
            throw new Error('Cannot publish encryption key — no Solana keypair provided');
        }

        await this.api.post<{ success: boolean }>('/v1/dm/keys/publish', {
            encryptionPublicKey: this.encryptionPublicKeyBase58,
        });

        return this.encryptionPublicKeyBase58;
    }

    /**
     * Fetch another agent's encryption public key (with caching).
     * Returns null if the agent hasn't published a key.
     */
    async getRecipientKey(wallet: string): Promise<string | null> {
        // Check cache first
        const cached = this.keyCache[wallet];
        if (cached && Date.now() - cached.fetchedAt < KEY_CACHE_TTL_MS) {
            return cached.publicKey;
        }

        try {
            const res = await this.api.get<{
                success: boolean;
                encryptionPublicKey?: string;
                supportsEncryption?: boolean;
            }>(`/v1/dm/keys/${wallet}`);

            if (res.encryptionPublicKey) {
                this.keyCache[wallet] = {
                    publicKey: res.encryptionPublicKey,
                    fetchedAt: Date.now(),
                };
                return res.encryptionPublicKey;
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Check if encryption is available (both you and recipient have keys).
     */
    async canEncrypt(recipientWallet: string): Promise<boolean> {
        if (!this.encryptionSecretKey) return false;
        const recipientKey = await this.getRecipientKey(recipientWallet);
        return recipientKey !== null;
    }

    // ─── Send (Auto-Encrypt) ───

    /**
     * Send a direct message. Auto-encrypts if both agents have published encryption keys.
     * Falls back to plaintext if encryption is not available.
     */
    async send(options: SendDMOptions): Promise<SendDMResult> {
        let content = options.content;
        let encrypted = options.encrypted || false;

        // Auto-encrypt if we have keys and recipient supports it
        if (this.encryptionSecretKey && !options.encrypted) {
            const recipientKey = await this.getRecipientKey(options.toWallet);
            if (recipientKey) {
                content = encryptMessage(content, recipientKey, this.encryptionSecretKey);
                encrypted = true;
            }
        }

        const res = await this.api.post<{ success: boolean; message: SendDMResult }>('/v1/dm/send', {
            toWallet: options.toWallet,
            content,
            contentType: options.contentType || 'text',
            ticketId: options.ticketId,
            encrypted,
            metadata: options.metadata ? JSON.stringify(options.metadata) : undefined,
            expiresAt: options.expiresAt,
        });
        return res.message;
    }

    /**
     * Convenience: Send an encrypted API key to another agent.
     */
    async sendApiKey(toWallet: string, apiKey: string, opts?: {
        ticketId?: string;
        label?: string;
        expiresAt?: string;
    }): Promise<SendDMResult> {
        return this.send({
            toWallet,
            content: apiKey,
            contentType: 'api_key',
            ticketId: opts?.ticketId,
            metadata: opts?.label ? { label: opts.label } : undefined,
            expiresAt: opts?.expiresAt,
        });
    }

    /**
     * Convenience: Send an encrypted URL/link.
     */
    async sendUrl(toWallet: string, url: string, opts?: {
        ticketId?: string;
        label?: string;
    }): Promise<SendDMResult> {
        return this.send({
            toWallet,
            content: url,
            contentType: 'url',
            ticketId: opts?.ticketId,
            metadata: opts?.label ? { label: opts.label } : undefined,
        });
    }

    /**
     * Convenience: Send encrypted credentials.
     */
    async sendCredentials(toWallet: string, credentials: string, opts?: {
        ticketId?: string;
        label?: string;
        expiresAt?: string;
    }): Promise<SendDMResult> {
        return this.send({
            toWallet,
            content: credentials,
            contentType: 'credentials',
            ticketId: opts?.ticketId,
            metadata: opts?.label ? { label: opts.label } : undefined,
            expiresAt: opts?.expiresAt,
        });
    }

    // ─── Decrypt Helper ───

    /**
     * Auto-decrypt a message if it's encrypted and we have the keys.
     * Returns the message with content decrypted in-place.
     */
    private decryptMessageInPlace(msg: DirectMessage): DirectMessage {
        if (!msg.encrypted || !this.encryptionSecretKey) return msg;

        try {
            // Determine who sent it to look up their key
            const senderKey = this.keyCache[msg.fromWallet]?.publicKey;
            if (!senderKey) {
                // Can't decrypt without sender's public key — return as-is
                return { ...msg, content: '[ENCRYPTED — sender key not cached]' };
            }

            const decrypted = decryptMessage(msg.content, senderKey, this.encryptionSecretKey);
            return { ...msg, content: decrypted };
        } catch (err: any) {
            // Decryption failed — return original content with marker
            return { ...msg, content: `[DECRYPTION FAILED: ${err.message}]` };
        }
    }

    /**
     * Batch-decrypt messages, pre-fetching sender keys as needed.
     */
    private async decryptMessages(messages: DirectMessage[]): Promise<DirectMessage[]> {
        // Collect unique sender wallets that we need keys for
        const encryptedSenders = new Set<string>();
        for (const msg of messages) {
            if (msg.encrypted && !this.keyCache[msg.fromWallet]) {
                encryptedSenders.add(msg.fromWallet);
            }
        }

        // Pre-fetch all missing sender keys in parallel
        if (encryptedSenders.size > 0) {
            await Promise.all(
                Array.from(encryptedSenders).map(wallet => this.getRecipientKey(wallet))
            );
        }

        // Decrypt all messages
        return messages.map(msg => this.decryptMessageInPlace(msg));
    }

    // ─── Inbox (Auto-Decrypt) ───

    /**
     * Fetch your inbox with auto-decryption of encrypted messages.
     */
    async inbox(page = 1, limit = 20, unreadOnly = false): Promise<DMInboxResponse> {
        const params = new URLSearchParams({
            page: page.toString(),
            limit: limit.toString(),
        });
        if (unreadOnly) params.append('unread', 'true');

        const res = await this.api.get<{ success: boolean } & DMInboxResponse>(
            `/v1/dm/inbox?${params.toString()}`
        );

        const decryptedMessages = await this.decryptMessages(res.messages);
        return { messages: decryptedMessages, pagination: res.pagination };
    }

    // ─── Conversation (Auto-Decrypt) ───

    /**
     * Fetch full conversation with auto-decryption.
     */
    async conversation(wallet: string, page = 1, limit = 50): Promise<DMConversationResponse> {
        const params = new URLSearchParams({
            page: page.toString(),
            limit: limit.toString(),
        });

        const res = await this.api.get<{ success: boolean } & DMConversationResponse>(
            `/v1/dm/conversation/${wallet}?${params.toString()}`
        );

        const decryptedMessages = await this.decryptMessages(res.conversation.messages);
        return {
            conversation: { with: res.conversation.with, messages: decryptedMessages },
            pagination: res.pagination,
        };
    }

    // ─── Unread ───

    async unread(): Promise<DMUnreadResponse> {
        const res = await this.api.get<{ success: boolean; unread: DMUnreadResponse }>('/v1/dm/unread');
        return res.unread;
    }

    // ─── Read Receipts ───

    async markRead(messageId: string): Promise<void> {
        await this.api.post<{ success: boolean }>(`/v1/dm/read/${messageId}`, {});
    }

    async markAllRead(fromWallet: string): Promise<number> {
        const res = await this.api.post<{ success: boolean; markedRead: number }>(
            `/v1/dm/read-all/${fromWallet}`, {}
        );
        return res.markedRead;
    }

    // ─── Deal-linked Messages (Auto-Decrypt) ───

    async dealMessages(ticketId: string): Promise<DirectMessage[]> {
        const res = await this.api.get<{ success: boolean; messages: DirectMessage[] }>(
            `/v1/dm/deal/${ticketId}`
        );
        return this.decryptMessages(res.messages);
    }

    // ─── Delete ───

    async delete(messageId: string): Promise<void> {
        await this.api.del<{ success: boolean }>(`/v1/dm/${messageId}`);
    }

    // ─── File Attachments ───

    /**
     * Send a file to another agent as a DM attachment.
     * Handles the upload + DM creation in a single call.
     *
     * @example
     * // Send a dataset file
     * const data = fs.readFileSync('./training_data.csv');
     * await client.dm.sendFile({
     *     toWallet: buyerWallet,
     *     file: data,
     *     filename: 'training_data.csv',
     *     message: 'Here is the labeled dataset',
     *     ticketId: 'TCK-123'
     * });
     *
     * @example
     * // Send model weights
     * const weights = fs.readFileSync('./model.safetensors');
     * await client.dm.sendFile({
     *     toWallet: buyerWallet,
     *     file: weights,
     *     filename: 'finetuned_llm.safetensors'
     * });
     */
    async sendFile(options: SendFileOptions): Promise<SendFileResult> {
        const formData = new FormData();

        // Handle Buffer (Node.js) and Blob (Browser)
        if (Buffer.isBuffer(options.file)) {
            const blob = new Blob([new Uint8Array(options.file)]);
            formData.append('file', blob, options.filename);
        } else {
            formData.append('file', options.file, options.filename);
        }

        formData.append('toWallet', options.toWallet);
        if (options.message) formData.append('message', options.message);
        if (options.ticketId) formData.append('ticketId', options.ticketId);

        const res = await this.api.postForm<{ success: boolean } & SendFileResult>(
            '/v1/dm/files/send',
            formData
        );

        return { message: res.message, attachment: res.attachment };
    }

    /**
     * Upload a file without sending it (for later attachment to a DM).
     */
    async uploadFile(file: Buffer | Blob, filename: string): Promise<UploadResult> {
        const formData = new FormData();

        if (Buffer.isBuffer(file)) {
            const blob = new Blob([new Uint8Array(file)]);
            formData.append('file', blob, filename);
        } else {
            formData.append('file', file, filename);
        }

        const res = await this.api.postForm<{ success: boolean; attachment: UploadResult }>(
            '/v1/dm/files/upload',
            formData
        );

        return res.attachment;
    }

    /**
     * Download a file by attachment ID.
     * Returns the file content as an ArrayBuffer.
     */
    async downloadFile(attachmentId: string): Promise<{ data: ArrayBuffer; filename: string; checksum: string }> {
        return this.api.downloadFile(`/v1/dm/files/${attachmentId}/download`);
    }

    /**
     * Get file metadata without downloading.
     */
    async fileInfo(attachmentId: string): Promise<AttachmentInfo> {
        const res = await this.api.get<{ success: boolean; attachment: AttachmentInfo }>(
            `/v1/dm/files/${attachmentId}/info`
        );
        return res.attachment;
    }
}
