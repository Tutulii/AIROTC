import { randomBytes } from "crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";

/**
 * Generates a 32-byte cryptographically secure mapped arbitrary challenge
 */
export function generateChallenge(): string {
  return randomBytes(32).toString("base64");
}

/**
 * Hardware wallet native Ed25519 signature verification against generated strings
 * 
 * @param publicKeyBase58 The SOL Wallet Address mapped in Base58
 * @param signatureBase58 The generated signature mapped in Base58
 * @param message The exact `challenge` string to verify
 */
export function verifySignature(publicKeyBase58: string, signatureBase58: string, message: string): boolean {
  try {
    const publicKey = bs58.decode(publicKeyBase58);
    const signature = bs58.decode(signatureBase58);
    const messageBuffer = Buffer.from(message, "utf-8");

    // Solana Ed25519 Key definitions
    if (publicKey.length !== 32) return false;
    if (signature.length !== 64) return false;

    return nacl.sign.detached.verify(messageBuffer, signature, publicKey);
  } catch (err: any) {
    return false;
  }
}

/**
 * Generates an Ed25519 signature for a message using the user's secret key.
 * Used for authenticating as a client to a remote agent's WebSocket Gateway.
 * 
 * @param secretKeyBase58 The SOL Wallet Secret Key mapped in Base58
 * @param message The exact `challenge` string to sign
 */
export function signMessage(secretKeyBase58: string, message: string): string {
  try {
    const secretKey = bs58.decode(secretKeyBase58);
    const messageBuffer = Buffer.from(message, "utf-8");

    if (secretKey.length !== 64) {
      throw new Error("Invalid secret key length");
    }

    const signature = nacl.sign.detached(messageBuffer, secretKey);
    return bs58.encode(signature);
  } catch (err: any) {
    throw new Error(`Failed to sign message: ${err.message}`);
  }
}
