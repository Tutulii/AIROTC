/**
 * Wallet Authentication Library
 * 
 * Provides Ed25519 signing utilities for authenticating with the AIR OTC platform.
 * Matches the exact format expected by:
 *   - API Server: authenticateSolana middleware (body: { message, signature, publicKey })
 *   - WS Gateway: auth_response handler (payload: { wallet, signature })
 */

import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

/**
 * Sign a plaintext message with an Ed25519 keypair.
 * Returns base58-encoded signature and public key.
 */
export function signMessage(keypair: Keypair, message: string): {
  message: string;
  signature: string;
  publicKey: string;
} {
  const messageBytes = new TextEncoder().encode(message);
  const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
  return {
    message,
    signature: bs58.encode(signatureBytes),
    publicKey: keypair.publicKey.toBase58(),
  };
}

/**
 * Build auth body fields for REST API requests that require wallet signature auth.
 * The message includes a timestamp to prevent replay attacks.
 */
export function buildAuthBody(keypair: Keypair): {
  message: string;
  signature: string;
  publicKey: string;
} {
  const message = `AIR-OTC-AUTH-${Date.now()}`;
  return signMessage(keypair, message);
}

/**
 * Sign a WS auth challenge from the middleman gateway.
 * Returns the payload to send as auth_response.
 */
export function signWsChallenge(keypair: Keypair, challenge: string): {
  type: "auth_response";
  wallet: string;
  signature: string;
} {
  const challengeBytes = new TextEncoder().encode(challenge);
  const signatureBytes = nacl.sign.detached(challengeBytes, keypair.secretKey);
  return {
    type: "auth_response",
    wallet: keypair.publicKey.toBase58(),
    signature: bs58.encode(signatureBytes),
  };
}

/**
 * Load a keypair from a base58-encoded secret key string.
 * If no key provided, generates a new ephemeral keypair.
 */
export function loadKeypair(base58SecretKey?: string): Keypair {
  if (base58SecretKey && base58SecretKey.trim()) {
    return Keypair.fromSecretKey(bs58.decode(base58SecretKey.trim()));
  }
  return Keypair.generate();
}
