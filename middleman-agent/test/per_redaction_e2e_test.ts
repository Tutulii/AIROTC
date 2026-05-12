import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import {
  AUTHORITY_FLAG,
  ConnectionMagicRouter,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  TX_LOGS_FLAG,
  TX_MESSAGE_FLAG,
  createClosePermissionInstruction,
  getAuthToken,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import * as fs from "fs";
import * as path from "path";
import {
  PER_TEE_RPC_URL,
  PER_TEE_VALIDATOR_DEVNET,
} from "../src/services/magicblockPerContract";
import { dependencyHealthService } from "../src/services/dependencyHealthService";
import {
  PrivateNegotiationService,
  waitForPermissionActivationWithFallback,
} from "../src/services/privateNegotiationService";

const idlPath = path.join(__dirname, "../src/idl/magicblock_negotiation.json");
const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

const PROGRAM_ID = new PublicKey("BfFvxgysVSGdP2TwAjBRSFhDYtK2JA1VBd8BUqh8nGGq");
const TEE_RPC_URL = PER_TEE_RPC_URL;
const TEE_VALIDATOR = PER_TEE_VALIDATOR_DEVNET;
const L1_RPC_URLS = [
  process.env.SOLANA_RPC_PRIMARY || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  process.env.SOLANA_RPC_BACKUP_1 || "https://devnet.genesysgo.net/",
  process.env.SOLANA_RPC_BACKUP_2 || "https://rpc.ankr.com/solana_devnet",
];

const keypairPath = `${process.env.HOME}/.config/solana/id.json`;
const secretKey = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(secretKey));
const buyer = Keypair.generate();
const seller = Keypair.generate();
let currentRpcIndex = 0;

function deriveSessionPda(sessionId: bigint): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(sessionId);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("session"), buf],
    PROGRAM_ID
  );
  return pda;
}

async function getTokenFor(keypair: Keypair): Promise<string> {
  const auth = await getAuthToken(
    TEE_RPC_URL,
    keypair.publicKey,
    async (message: Uint8Array) => nacl.sign.detached(message, keypair.secretKey)
  );
  return auth.token;
}

function isRetryable(error: unknown): boolean {
  const message = String((error as Error)?.message || error).toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("blockhash") ||
    message.includes("timeout") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("502") ||
    message.includes("node is behind") ||
    message.includes("network")
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentL1Connection(): Connection {
  return new Connection(L1_RPC_URLS[currentRpcIndex], "confirmed");
}

function currentL1Program(connection: Connection): Program {
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  return new Program(idl as any, provider);
}

async function withL1Retry<T>(
  label: string,
  fn: (connection: Connection, program: Program) => Promise<T>
): Promise<T> {
  const attempts = L1_RPC_URLS.length * 2;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const connection = currentL1Connection();
    const program = currentL1Program(connection);

    try {
      if (attempt > 0) {
        console.log(`  ⏳ Retry ${attempt + 1}/${attempts} for ${label} via ${L1_RPC_URLS[currentRpcIndex]}`);
      }
      return await fn(connection, program);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts - 1) {
        throw error;
      }

      currentRpcIndex = (currentRpcIndex + 1) % L1_RPC_URLS.length;
      await sleep(1200 * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main() {
  await dependencyHealthService.assertHealthyForOperation("per_redaction_e2e", [
    "solana_rpc",
    "magicblock_tee",
    "magicblock_auth",
  ]);
  const sessionId = BigInt(Math.floor(Math.random() * 1_000_000_000));
  const sessionPda = deriveSessionPda(sessionId);
  const permissionPda = permissionPdaFromAccount(sessionPda);
  const privateService = new PrivateNegotiationService(currentL1Connection(), payer);

  console.log("═══════════════════════════════════════════════════════");
  console.log("  PER Redaction E2E — TEE -> Scrubbed L1");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Program:     ${PROGRAM_ID.toBase58()}`);
  console.log(`  Session PDA: ${sessionPda.toBase58()}`);
  console.log(`  Permission:  ${permissionPda.toBase58()}`);
  console.log(`  Server:      ${payer.publicKey.toBase58()}`);
  console.log(`  Buyer:       ${buyer.publicKey.toBase58()}`);
  console.log(`  Seller:      ${seller.publicKey.toBase58()}`);
  console.log(`  L1 RPC:      ${L1_RPC_URLS[currentRpcIndex]}`);
  console.log("");

  console.log("── Step 1: initializeSession [L1] ──");
  const initSig = await withL1Retry("initializeSession", async (_connection, program) =>
    (program.methods as any)
      .initializeSession(new BN(sessionId.toString()))
      .accountsPartial({
        session: sessionPda,
        buyer: payer.publicKey,
      })
      .rpc()
  );
  console.log(`  ✅ ${initSig}`);

  console.log("── Step 2: createPrivatePermission [L1 via CPI] ──");
  const createPermissionSig = await withL1Retry("createPrivatePermission", async (_connection, program) =>
    (program.methods as any)
      .createPrivatePermission(
        new BN(sessionId.toString()),
        buyer.publicKey,
        seller.publicKey
      )
      .accounts({
        payer: payer.publicKey,
        permission: permissionPda,
        permissionProgram: PERMISSION_PROGRAM_ID,
      })
      .rpc()
  );
  console.log(`  ✅ ${createPermissionSig}`);

  console.log("── Step 3: delegateSession [L1 -> TEE] ──");
  const delegateSessionSig = await withL1Retry("delegateSession", async (_connection, program) =>
    (program.methods as any)
      .delegateSession()
      .accountsPartial({
        payer: payer.publicKey,
        validator: TEE_VALIDATOR,
        session: sessionPda,
      })
      .rpc()
  );
  console.log(`  ✅ ${delegateSessionSig}`);

  console.log("── Step 4: delegatePermission [L1 -> TEE] ──");
  const delegateSig = await privateService.delegateToTee(sessionId, sessionPda);
  console.log(`  ✅ ${delegateSig}`);

  const delegatedAccount = await withL1Retry("fetchDelegatedOwner", async (connection) =>
    connection.getAccountInfo(sessionPda)
  );
  console.log(`  Owner after permission delegation: ${delegatedAccount?.owner.toBase58()}`);

  const permissionActivation = await waitForPermissionActivationWithFallback({
    rpcUrl: TEE_RPC_URL,
    sessionPda,
    timeoutMs: 30_000,
    allowL1ConfirmedFallback: true,
  });
  if (!permissionActivation.active) {
    throw new Error("Permission did not become active on the TEE");
  }
  if (permissionActivation.degraded) {
    console.log(
      `  ⚠️ Permission status endpoint unavailable; proceeding on L1 confirmation (${permissionActivation.lastError || "unknown"})`
    );
  } else {
    console.log("  ✅ Permission active on TEE");
  }

  const buyerToken = await getTokenFor(buyer);
  const serverToken = await getTokenFor(payer);

  const buyerRouter = new ConnectionMagicRouter(`${TEE_RPC_URL}?token=${buyerToken}`, {
    commitment: "confirmed",
  });
  const buyerProgram = new Program(
    idl as any,
    new AnchorProvider(buyerRouter as any, new Wallet(buyer), { commitment: "confirmed" })
  );

  try {
    const delegationStatus = await buyerRouter.getDelegationStatus(sessionPda);
    console.log(`  Delegation status: isDelegated=${delegationStatus.isDelegated}`);
  } catch (error) {
    console.log(`  ⚠️  getDelegationStatus failed: ${String((error as Error)?.message || error)}`);
  }

  const serverRouter = new ConnectionMagicRouter(`${TEE_RPC_URL}?token=${serverToken}`, {
    commitment: "confirmed",
  });
  const serverProgram = new Program(
    idl as any,
    new AnchorProvider(serverRouter as any, new Wallet(payer), { commitment: "confirmed" })
  );

  console.log("── Step 5: negotiateTerms [TEE] ──");
  const negotiateSig = await (buyerProgram.methods as any)
    .negotiateTerms(
      new BN(1_500_000_000),
      "SOL",
      new BN(250_000_000),
      new BN(350_000_000)
    )
    .accountsPartial({
      session: sessionPda,
    })
    .rpc();
  console.log(`  ✅ ${negotiateSig}`);

  console.log("── Step 6: preparePrivateHandoff [TEE] ──");
  const handoffSig = await (serverProgram.methods as any)
    .preparePrivateHandoff(new BN(sessionId.toString()))
    .accounts({
      payer: payer.publicKey,
    })
    .rpc();
  console.log(`  ✅ ${handoffSig}`);

  console.log("── Step 7: commit scrubbed state [TEE] + close permission [L1] ──");
  const commitIx = await (serverProgram.methods as any)
    .commitPrivatePermission(new BN(sessionId.toString()))
    .accounts({
      payer: payer.publicKey,
      session: sessionPda,
      permission: permissionPda,
      permissionProgram: PERMISSION_PROGRAM_ID,
      magicProgram: MAGIC_PROGRAM_ID,
      magicContext: MAGIC_CONTEXT_ID,
    })
    .instruction();
  const commitTx = new Transaction().add(commitIx);
  const commitBlockhash = await serverRouter.getLatestBlockhash("confirmed");
  commitTx.recentBlockhash = commitBlockhash.blockhash;
  commitTx.lastValidBlockHeight = commitBlockhash.lastValidBlockHeight;
  commitTx.feePayer = payer.publicKey;
  commitTx.sign(payer);
  const commitSim = await serverRouter.simulateTransaction(commitTx, undefined, false);
  if (commitSim.value.err) {
    console.log(`  ⚠️  Commit simulation err: ${JSON.stringify(commitSim.value.err)}`);
    if (commitSim.value.logs?.length) {
      console.log("  ├─ Simulation logs:");
      for (const log of commitSim.value.logs) {
        console.log(`  │  ${log}`);
      }
    }
  }
  const commitSig = await serverRouter.sendRawTransaction(commitTx.serialize(), {
    skipPreflight: true,
  });
  console.log(`  ⏳ Commit signature: ${commitSig}`);
  const commitStatus = await serverRouter.confirmTransaction(
    {
      signature: commitSig,
      blockhash: commitBlockhash.blockhash,
      lastValidBlockHeight: commitBlockhash.lastValidBlockHeight,
    },
    "confirmed"
  );
  if (commitStatus.value.err) {
    try {
      const commitTxInfo = await (serverRouter as any).getTransaction(commitSig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (commitTxInfo?.meta?.logMessages?.length) {
        console.log("  ├─ Commit logs:");
        for (const log of commitTxInfo.meta.logMessages) {
          console.log(`  │  ${log}`);
        }
      }
    } catch (error) {
      console.log(`  ⚠️  Failed to fetch commit logs: ${String((error as Error)?.message || error)}`);
    }
    throw new Error(`commitPrivatePermission failed: ${JSON.stringify(commitStatus.value.err)}`);
  }

  let ownerRestored = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    await sleep(3000);
    const accountInfo = await withL1Retry("pollUndelegatedOwner", async (connection) =>
      connection.getAccountInfo(sessionPda)
    );
    if (accountInfo?.owner.equals(PROGRAM_ID)) {
      ownerRestored = true;
      console.log(`  ✅ Session undelegated back to L1 on attempt ${attempt + 1}`);
      break;
    }
  }
  if (!ownerRestored) {
    throw new Error("Session owner did not return to the negotiation program after PER commit");
  }

  const closeSig = await withL1Retry("closePrivatePermission", async (_connection, program) =>
    sendAndConfirmTransaction(
      _connection,
      new Transaction().add(
        createClosePermissionInstruction({
          payer: payer.publicKey,
          authority: [payer.publicKey, true],
          permissionedAccount: [sessionPda, false],
        })
      ),
      [payer],
      { commitment: "confirmed" }
    )
  );
  console.log(`  ✅ Commit: ${commitSig}`);
  console.log(`  ✅ Close:  ${closeSig}`);

  console.log("── Step 8: verify scrubbed state [L1] ──");
  const account = await withL1Retry("fetchScrubbedSession", async (_connection, program) =>
    (program.account as any).session.fetch(sessionPda)
  );
  const status = JSON.stringify(account.status);
  console.log(`  Agreed Price:  ${account.agreedPrice.toString()}`);
  console.log(`  Agreed Asset:  "${account.agreedAsset}"`);
  console.log(`  Buyer Collat.: ${account.buyerCollateral.toString()}`);
  console.log(`  Seller Collat.: ${account.sellerCollateral.toString()}`);
  console.log(`  Status:        ${status}`);

  const scrubbed =
    account.agreedPrice.toString() === "0" &&
    account.agreedAsset === "" &&
    account.buyerCollateral.toString() === "0" &&
    account.sellerCollateral.toString() === "0" &&
    status.includes("confidentialHandoff");

  if (!scrubbed) {
    throw new Error("L1 session still contains plaintext terms after PER finalization");
  }

  console.log("  ✅ L1 session was scrubbed before finalization. No plaintext terms were committed back.");
}

main().catch((error) => {
  console.error("❌ PER redaction E2E failed:", error.message);
  if ((error as any).logs) {
    console.error((error as any).logs.slice(-10).join("\n"));
  }
  process.exit(1);
});
