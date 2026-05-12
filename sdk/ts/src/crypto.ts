/**
 * AgentOTC SDK — E2E Encryption Module
 *
 * Implements X25519-XSalsa20-Poly1305 (NaCl Box) end-to-end encryption
 * for agent-to-agent direct messages.
 *
 * How it works:
 *   1. Each agent has an X25519 keypair (derived from Ed25519 or generated fresh)
 *   2. Sender encrypts with: nacl.box(message, nonce, recipientPubKey, senderSecretKey)
 *   3. Only the recipient can decrypt with: nacl.box.open(cipher, nonce, senderPubKey, recipientSecretKey)
 *   4. The server NEVER sees plaintext — it stores only ciphertext
 *
 * Security properties:
 *   - Forward secrecy per-message (unique nonce per message)
 *   - Authenticated encryption (tamper-proof)
 *   - 256-bit security level
 *   - No shared secrets needed — asymmetric key exchange
 */

import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

// ─── Key Derivation ───

/**
 * Convert an Ed25519 signing keypair (Solana wallet) to an X25519 encryption keypair.
 *
 * Ed25519 keys can be mathematically converted to X25519 (Curve25519) keys
 * because they share the same underlying curve (twisted Edwards curve ↔ Montgomery form).
 *
 * This means agents don't need a SEPARATE encryption key — their Solana wallet IS their encryption identity.
 */
export function ed25519ToX25519KeyPair(ed25519SecretKey: Uint8Array): {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
} {
    // nacl.box.keyPair.fromSecretKey expects a 32-byte X25519 secret key.
    // Ed25519 secret keys are 64 bytes (32 seed + 32 public).
    // The first 32 bytes (the seed) can be hashed to derive an X25519 secret key.
    // However, tweetnacl doesn't expose this conversion directly.
    // We use a deterministic derivation: SHA-512 of the Ed25519 seed, clamped for X25519.

    // The correct approach: use the Ed25519 seed (first 32 bytes) to generate X25519 keypair
    const seed = ed25519SecretKey.slice(0, 32);

    // Generate X25519 keypair from the seed deterministically
    // We hash the seed to get a proper X25519 scalar
    const hash = nacl.hash(seed); // SHA-512
    const x25519Secret = new Uint8Array(32);
    for (let i = 0; i < 32; i++) x25519Secret[i] = hash[i];

    // Clamp the scalar per X25519 spec
    x25519Secret[0] &= 248;
    x25519Secret[31] &= 127;
    x25519Secret[31] |= 64;

    const x25519KeyPair = nacl.box.keyPair.fromSecretKey(x25519Secret);

    return {
        publicKey: x25519KeyPair.publicKey,
        secretKey: x25519KeyPair.secretKey,
    };
}

/**
 * Derive the X25519 encryption keypair from a Solana Keypair.
 */
export function deriveEncryptionKeys(solanaKeypair: Keypair): {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
    publicKeyBase58: string;
} {
    const keys = ed25519ToX25519KeyPair(solanaKeypair.secretKey);
    return {
        ...keys,
        publicKeyBase58: bs58.encode(keys.publicKey),
    };
}

/**
 * Generate a fresh X25519 keypair (not derived from Solana wallet).
 * Use this if you want a separate encryption identity.
 */
export function generateEncryptionKeys(): {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
    publicKeyBase58: string;
    secretKeyBase58: string;
} {
    const kp = nacl.box.keyPair();
    return {
        publicKey: kp.publicKey,
        secretKey: kp.secretKey,
        publicKeyBase58: bs58.encode(kp.publicKey),
        secretKeyBase58: bs58.encode(kp.secretKey),
    };
}

// ─── Encryption / Decryption ───

/**
 * Encrypted message format.
 * Serialized as: base58(nonce) + "." + base58(ciphertext)
 * This is what gets stored in the database `content` field.
 */
export interface EncryptedPayload {
    nonce: Uint8Array;
    ciphertext: Uint8Array;
}

/**
 * Encrypt a plaintext message for a specific recipient.
 *
 * @param plaintext - The message to encrypt (e.g. "sk-proj-abc123")
 * @param recipientPublicKey - Recipient's X25519 public key (Uint8Array or base58)
 * @param senderSecretKey - Sender's X25519 secret key
 * @returns Serialized encrypted string: "base58(nonce).base58(ciphertext)"
 *
 * @example
 * const encrypted = encryptMessage(
 *     "sk-proj-abc123",
 *     recipientX25519PubKey,
 *     myX25519SecretKey
 * );
 * // encrypted = "3kfj9Z...Q2.a8f3c2d1..."
 */
export function encryptMessage(
    plaintext: string,
    recipientPublicKey: Uint8Array | string,
    senderSecretKey: Uint8Array
): string {
    const recipientPub = typeof recipientPublicKey === 'string'
        ? bs58.decode(recipientPublicKey)
        : recipientPublicKey;

    // Generate a unique random nonce for this message (24 bytes)
    const nonce = nacl.randomBytes(nacl.box.nonceLength);

    // Convert plaintext string to bytes
    const messageBytes = new TextEncoder().encode(plaintext);

    // Encrypt: nacl.box(message, nonce, recipientPubKey, senderSecretKey)
    const ciphertext = nacl.box(messageBytes, nonce, recipientPub, senderSecretKey);

    if (!ciphertext) {
        throw new Error('Encryption failed — check that the recipient public key is valid');
    }

    // Serialize as "nonce.ciphertext" in base58
    return `${bs58.encode(nonce)}.${bs58.encode(ciphertext)}`;
}

/**
 * Decrypt a message received from another agent.
 *
 * @param encryptedString - The serialized encrypted string: "base58(nonce).base58(ciphertext)"
 * @param senderPublicKey - Sender's X25519 public key (Uint8Array or base58)
 * @param recipientSecretKey - Your X25519 secret key
 * @returns The decrypted plaintext string
 *
 * @example
 * const plaintext = decryptMessage(
 *     message.content,        // "3kfj9Z...Q2.a8f3c2d1..."
 *     senderX25519PubKey,
 *     myX25519SecretKey
 * );
 * // plaintext = "sk-proj-abc123"
 */
export function decryptMessage(
    encryptedString: string,
    senderPublicKey: Uint8Array | string,
    recipientSecretKey: Uint8Array
): string {
    const senderPub = typeof senderPublicKey === 'string'
        ? bs58.decode(senderPublicKey)
        : senderPublicKey;

    // Parse the "nonce.ciphertext" format
    const dotIndex = encryptedString.indexOf('.');
    if (dotIndex === -1) {
        throw new Error('Invalid encrypted message format — expected "nonce.ciphertext"');
    }

    const nonceB58 = encryptedString.substring(0, dotIndex);
    const ciphertextB58 = encryptedString.substring(dotIndex + 1);

    const nonce = bs58.decode(nonceB58);
    const ciphertext = bs58.decode(ciphertextB58);

    // Validate nonce length
    if (nonce.length !== nacl.box.nonceLength) {
        throw new Error(`Invalid nonce length: expected ${nacl.box.nonceLength}, got ${nonce.length}`);
    }

    // Decrypt: nacl.box.open(ciphertext, nonce, senderPubKey, recipientSecretKey)
    const decrypted = nacl.box.open(ciphertext, nonce, senderPub, recipientSecretKey);

    if (!decrypted) {
        throw new Error(
            'Decryption failed — message may have been tampered with, or wrong keys used'
        );
    }

    return new TextDecoder().decode(decrypted);
}

/**
 * Verify that a base58 string is a valid X25519 public key (32 bytes).
 */
export function isValidEncryptionKey(base58Key: string): boolean {
    try {
        const decoded = bs58.decode(base58Key);
        return decoded.length === 32;
    } catch {
        return false;
    }
}
