import bs58 from "bs58";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { createHash } from "crypto";
import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    TransactionInstruction,
    Transaction,
    sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
    createDelegatePermissionInstruction,
    DELEGATION_PROGRAM_ID,
    PERMISSION_PROGRAM_ID,
    delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
    delegationMetadataPdaFromDelegatedAccount,
    delegationRecordPdaFromDelegatedAccount,
    permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";

import negotiationIdl from "../src/idl/magicblock_negotiation.json";
import type { MagicblockNegotiation } from "../src/idl/magicblock_negotiation";
import { PrivateNegotiationService } from "../src/services/privateNegotiationService";
import { PER_TEE_VALIDATOR_DEVNET } from "../src/services/magicblockPerContract";

const NEGOTIATION_PROGRAM_ID = new PublicKey((negotiationIdl as any).address);

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required env var: ${name}`);
    }
    return value;
}

function deriveSessionPda(sessionId: bigint): PublicKey {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(sessionId);
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("session"), buf],
        NEGOTIATION_PROGRAM_ID
    );
    return pda;
}

function getProgram(connection: Connection, payer: Keypair): Program<MagicblockNegotiation> {
    const provider = new AnchorProvider(connection, new Wallet(payer), {
        commitment: "confirmed",
    });
    return new Program(negotiationIdl as any, provider) as unknown as Program<MagicblockNegotiation>;
}

async function main() {
    const rpcUrl = requireEnv("SOLANA_RPC_URL");
    const payer = Keypair.fromSecretKey(bs58.decode(requireEnv("PRIVATE_KEY")));
    const buyer = Keypair.fromSecretKey(bs58.decode(requireEnv("BUYER_PRIVATE_KEY")));
    const seller = Keypair.fromSecretKey(bs58.decode(requireEnv("SELLER_PRIVATE_KEY")));
    const order = (process.env.PER_PROBE_ORDER || "permission-first").toLowerCase();
    const variant = (process.env.PER_PROBE_VARIANT || "current-cpi").toLowerCase();
    const ownerProgramMode = (process.env.PER_PROBE_OWNER || "permission").toLowerCase();

    if (order !== "permission-first" && order !== "session-first") {
        throw new Error(`Unsupported PER_PROBE_ORDER: ${order}`);
    }
    if (!["current-cpi", "direct-authority", "manual-authority-readonly"].includes(variant)) {
        throw new Error(`Unsupported PER_PROBE_VARIANT: ${variant}`);
    }

    const connection = new Connection(rpcUrl, "confirmed");
    const program = getProgram(connection, payer);
    const privateService = new PrivateNegotiationService(connection, payer);
    const permissionFeePayer = Keypair.fromSeed(
        createHash("sha256")
            .update(payer.secretKey)
            .update("air-otc/per-permission-fee-payer")
            .digest()
            .subarray(0, 32)
    );

    const sessionId = BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 100_000));
    const sessionPda = deriveSessionPda(sessionId);
    const permissionPda = permissionPdaFromAccount(sessionPda);

    console.log("==============================================");
    console.log(" PER Permission Ordering Probe");
    console.log("==============================================");
    console.log(`Order:        ${order}`);
    console.log(`Variant:      ${variant}`);
    console.log(`Owner mode:   ${ownerProgramMode}`);
    console.log(`Program:      ${NEGOTIATION_PROGRAM_ID.toBase58()}`);
    console.log(`Session ID:   ${sessionId.toString()}`);
    console.log(`Session PDA:  ${sessionPda.toBase58()}`);
    console.log(`Permission:   ${permissionPda.toBase58()}`);
    console.log(`Validator:    ${PER_TEE_VALIDATOR_DEVNET.toBase58()}`);
    console.log("");

    console.log("[1/4] initializeSession");
    const initSig = await (program.methods as any)
        .initializeSession(new BN(sessionId.toString()))
        .accountsPartial({
            session: sessionPda,
            buyer: payer.publicKey,
        })
        .rpc();
    console.log(`  init sig:   ${initSig}`);

    console.log("[2/4] createPrivatePermission");
    const createSig = await (program.methods as any)
        .createPrivatePermission(
            new BN(sessionId.toString()),
            buyer.publicKey,
            seller.publicKey
        )
        .accounts({
            payer: payer.publicKey,
            permission: permissionPda,
            permissionProgram: new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"),
        })
        .rpc();
    console.log(`  create sig: ${createSig}`);

    const delegatePermission = async () => {
        console.log("[3/4] delegatePrivatePermission");
        let sig: string;
        if (variant === "current-cpi") {
            sig = await privateService.delegateToTee(sessionId, sessionPda);
        } else {
            const balance = await connection.getBalance(permissionFeePayer.publicKey, "confirmed");
            if (balance < 10_000_000) {
                const topUp = new Transaction().add(
                    SystemProgram.transfer({
                        fromPubkey: payer.publicKey,
                        toPubkey: permissionFeePayer.publicKey,
                        lamports: 50_000_000,
                    })
                );
                await sendAndConfirmTransaction(connection, topUp, [payer], { commitment: "confirmed" });
            }

            let ix: TransactionInstruction;
            if (variant === "direct-authority") {
                ix = createDelegatePermissionInstruction(
                    {
                        payer: permissionFeePayer.publicKey,
                        authority: [payer.publicKey, true],
                        permissionedAccount: [sessionPda, false],
                        ownerProgram:
                            ownerProgramMode === "negotiation"
                                ? NEGOTIATION_PROGRAM_ID
                                : undefined,
                    },
                    { validator: PER_TEE_VALIDATOR_DEVNET }
                );
            } else {
                const ownerProgram =
                    ownerProgramMode === "negotiation"
                        ? NEGOTIATION_PROGRAM_ID
                        : PERMISSION_PROGRAM_ID;
                ix = new TransactionInstruction({
                    programId: PERMISSION_PROGRAM_ID,
                    keys: [
                        { pubkey: permissionFeePayer.publicKey, isWritable: true, isSigner: true },
                        { pubkey: payer.publicKey, isWritable: false, isSigner: true },
                        { pubkey: sessionPda, isWritable: false, isSigner: false },
                        { pubkey: permissionPda, isWritable: true, isSigner: false },
                        { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
                        { pubkey: ownerProgram, isWritable: false, isSigner: false },
                        {
                            pubkey: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(permissionPda, ownerProgram),
                            isWritable: true,
                            isSigner: false,
                        },
                        {
                            pubkey: delegationRecordPdaFromDelegatedAccount(permissionPda),
                            isWritable: true,
                            isSigner: false,
                        },
                        {
                            pubkey: delegationMetadataPdaFromDelegatedAccount(permissionPda),
                            isWritable: true,
                            isSigner: false,
                        },
                        { pubkey: DELEGATION_PROGRAM_ID, isWritable: false, isSigner: false },
                        { pubkey: PER_TEE_VALIDATOR_DEVNET, isWritable: false, isSigner: false },
                    ],
                    data: Buffer.from([3, 0, 0, 0, 0, 0, 0, 0]),
                });
            }
            sig = await sendAndConfirmTransaction(
                connection,
                new Transaction().add(ix),
                [payer, permissionFeePayer],
                { commitment: "confirmed" }
            );
        }
        console.log(`  perm sig:   ${sig}`);
    };

    const delegateSession = async () => {
        console.log("[4/4] delegateSession");
        const sig = await (program.methods as any)
            .delegateSession()
            .accountsPartial({
                payer: payer.publicKey,
                validator: PER_TEE_VALIDATOR_DEVNET,
                session: sessionPda,
            })
            .rpc();
        console.log(`  sess sig:   ${sig}`);
    };

    if (order === "permission-first") {
        await delegatePermission();
        await delegateSession();
    } else {
        await delegateSession();
        await delegatePermission();
    }

    const finalOwner = await connection.getAccountInfo(sessionPda, "confirmed");
    console.log("");
    console.log("Result:");
    console.log(`  session owner: ${finalOwner?.owner.toBase58() ?? "missing"}`);
    console.log("==============================================");
}

main().catch((error) => {
    console.error("Probe failed:");
    if (error instanceof Error) {
        console.error(error.message);
        const maybeLogs = (error as any).logs;
        if (Array.isArray(maybeLogs) && maybeLogs.length > 0) {
            console.error("Logs:");
            for (const line of maybeLogs) {
                console.error(`  ${line}`);
            }
        }
    } else {
        console.error(String(error));
    }
    process.exit(1);
});
