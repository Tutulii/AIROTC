import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import * as fs from 'fs';
import * as path from 'path';

// Load IDL securely via filesystem to bypass resolveJsonModule tsconfig errors
const EscrowIDL = JSON.parse(fs.readFileSync(path.join(__dirname, 'idl', 'escrow.json'), 'utf-8'));

export const ESCROW_PROGRAM_ID = new PublicKey(process.env.ESCROW_PROGRAM_ID || 'Hp6RbB21KrKQEaKvqAZPLHYYVDFKNJaiRtzE1494dpmx');
export const CONNECTION = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');

let programInstance: Program | null = null;

export const getEscrowProgram = (): Program => {
    if (programInstance) return programInstance;

    const dummyProvider = new AnchorProvider(
        CONNECTION,
        new Wallet(Keypair.generate()),
        { commitment: 'confirmed' }
    );

    EscrowIDL.address = ESCROW_PROGRAM_ID.toBase58();

    programInstance = new Program(EscrowIDL as any, dummyProvider);
    return programInstance;
};
