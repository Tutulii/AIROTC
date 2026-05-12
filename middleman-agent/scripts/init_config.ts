import { createConnection } from "../src/solana/connection";
import { loadWallet } from "../src/solana/wallet";
import { loadProgram, deriveConfigPda } from "../src/solana/program";
import { loadConfig } from "../src/config";
import { SystemProgram } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";

async function main() {
  const config = loadConfig();
  const connection = createConnection(config.solanaRpcUrl);
  const keypair = loadWallet(config.privateKey);

  console.log(`Using Wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`Program ID: ${config.programId}`);

  const { provider, programId } = await loadProgram(connection, keypair, config.programId);
  
  // Create an Anchor Program instance
  // Since we don't have the generated TS types in middleman-agent, we can fetch the IDL dynamically.
  const idl = await Program.fetchIdl(programId, provider);
  if (!idl) {
    throw new Error("IDL not found on-chain. Cannot construct program.");
  }
  
  const program = new Program(idl as anchor.Idl, provider);

  const [configPda] = deriveConfigPda(programId);
  console.log(`Config PDA: ${configPda.toBase58()}`);

  try {
    const tx = await program.methods
      .initializeConfig()
      .accounts({
        config: configPda,
        authority: keypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log(`Successfully initialized config PDA!`);
    console.log(`Transaction Signature: ${tx}`);
  } catch (error: any) {
    console.error("Failed to initialize config. Already initialized?");
    console.error(error.message || error);
  }
}

main().catch(console.error);
