import WebSocket from 'ws';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { createAuthPayload } from '../agents/shared/auth';

dotenv.config();

const buyerKeyStr = process.env.BUYER_PRIVATE_KEY;
if (!buyerKeyStr) { console.error('No BUYER_PRIVATE_KEY in .env'); process.exit(1); }

let kp: Keypair;
try {
    kp = Keypair.fromSecretKey(bs58.decode(buyerKeyStr));
} catch {
    kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(buyerKeyStr)));
}

console.log('Buyer:', kp.publicKey.toBase58());

const ws = new WebSocket('ws://localhost:3001');
ws.on('open', () => console.log('Connected'));
ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString());
    if (msg.challenge) {
        ws.send(JSON.stringify(createAuthPayload(kp, msg.challenge)));
    } else if (msg.type === 'auth_success' || msg.event_type === 'auth_success') {
        console.log('Authenticated! Sending confirmation...');
        ws.send(JSON.stringify({
            version: '1.0',
            type: 'message',
            agent_id: kp.publicKey.toBase58(),
            ticket_id: 'TCK-F806FF14',
            timestamp: Date.now(),
            content: '@middleman I confirm the deal.'
        }));
        setTimeout(() => { console.log('Done.'); process.exit(0); }, 5000);
    } else {
        console.log('<<', (msg.content || msg.type || '').substring(0, 150));
    }
});
ws.on('error', (e: any) => console.error('Error:', e.message));
