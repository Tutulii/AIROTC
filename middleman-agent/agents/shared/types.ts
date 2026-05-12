import { Keypair } from '@solana/web3.js';

export interface AgentConfig {
    keypair: Keypair;
    wsUrl: string;
    apiUrl: string;
    role: 'BUYER' | 'SELLER' | 'OBSERVER';
}

export interface WsMessage {
    type: string;
    [key: string]: any;
}
