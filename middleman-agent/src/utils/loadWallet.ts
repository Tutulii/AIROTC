import { Keypair } from '@solana/web3.js';
import * as bs58 from 'bs58';

export function loadWalletFromEnv(envKey: string): Keypair {
    const rawKey = process.env[envKey];
    if (!rawKey) {
        throw new Error(`CRITICAL: Environment variable ${envKey} is missing! Refusing to load wallet.`);
    }

    try {
        const decoded = bs58.decode(rawKey);
        return Keypair.fromSecretKey(decoded);
    } catch (e: any) {
        throw new Error(`CRITICAL: Failed to decode secret key from ${envKey}. Ensure it is a valid base58 string.`);
    }
}
