import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

export function signChallenge(keypair: Keypair, challenge: string): string {
    const messageBytes = new TextEncoder().encode(challenge);
    const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
    return bs58.encode(signature);
}

export function createAuthPayload(keypair: Keypair, challenge: string) {
    return {
        type: 'auth_response',
        wallet: keypair.publicKey.toBase58(),
        signature: signChallenge(keypair, challenge),
        challenge
    };
}
