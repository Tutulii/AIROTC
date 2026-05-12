import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createCommitAndUndelegateInstruction } from "@magicblock-labs/ephemeral-rollups-sdk";
import * as fs from "fs";

const keypairPath = `${process.env.HOME}/.config/solana/id.json`;
const secretKey = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(secretKey));

// Use the exact session PDA from the previous run
const delegatedAccount = new PublicKey("GaV3YVnFUcAvDzrriddB6s2suToZ5CRrisrDvG4c2U7z");

const connection = new Connection("https://api.devnet.solana.com");
const erConnection = new Connection("https://devnet.magicblock.app"); // friend's URL

async function testCommit() {
  const ix = createCommitAndUndelegateInstruction(payer.publicKey, [delegatedAccount]);

  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  tx.sign(payer);
  try {
      const sig = await erConnection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      console.log("Commit signature:", sig);

      // Poll for success
      for (let i = 0; i < 30; i++) {
        const status = await erConnection.getSignatureStatus(sig);
        console.log(`Poll ${i}:`, status);
        if (status?.value?.confirmationStatus === "finalized" || status?.value?.confirmationStatus === "confirmed") {
          console.log("✅ Commit succeeded!");
          return;
        }
        await new Promise(r => setTimeout(r, 2000));
      }
      console.log("❌ Timeout");
  } catch (err: any) {
      console.error(err);
  }
}

testCommit();
