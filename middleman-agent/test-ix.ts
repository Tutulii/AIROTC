import { PublicKey } from "@solana/web3.js";
import { createCommitAndUndelegateInstruction } from "@magicblock-labs/ephemeral-rollups-sdk";

const payer = PublicKey.unique();
const pda = PublicKey.unique();

const ix = createCommitAndUndelegateInstruction(payer, [pda]);

// Modifying the returned instruction
ix.keys.forEach(k => { if (k.pubkey.equals(pda)) k.isWritable = true; });

console.log(ix.keys.map((k: any) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })));
