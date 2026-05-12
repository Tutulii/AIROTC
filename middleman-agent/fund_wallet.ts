import { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import dotenv from "dotenv";
dotenv.config({ path: "/Users/tutul/Downloads/AIR OTC/middleman-agent/.env" });

async function fund() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const agentKeypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY!));
  console.log("Agent Pubkey:", agentKeypair.publicKey.toBase58());
  
  const target = new PublicKey("E7PWFPv6YvRMRA6toXJqnQRXfUxLy6L9zXsqHfv15UbL");
  
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: agentKeypair.publicKey,
      toPubkey: target,
      lamports: 3 * 1e9, // 3 SOL
    })
  );
  
  console.log("Sending 3 SOL...");
  const signature = await sendAndConfirmTransaction(connection, tx, [agentKeypair]);
  console.log("Transfer success:", signature);
}

fund().catch(console.error);
