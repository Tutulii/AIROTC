import { PublicKey, Keypair } from "@solana/web3.js";
import { createCommitAndUndelegateInstruction } from "@magicblock-labs/ephemeral-rollups-sdk";

const payer = Keypair.generate().publicKey;
const sessionPda = Keypair.generate().publicKey;

const ix = createCommitAndUndelegateInstruction(
  payer,
  [sessionPda]
);

console.log("Raw SDK createCommitAndUndelegateInstruction Accounts:");
ix.keys.forEach((meta, i) => {
  console.log(`Account ${i}:`, {
    pubkey: meta.pubkey.toBase58(),
    isWritable: meta.isWritable,
    isSigner: meta.isSigner,
  });
});
