import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

async function main() {
    const conn = new Connection(
        "https://devnet.helius-rpc.com/?api-key=bef9b2f8-0e97-4dda-b939-d7c54ed780ca",
        { commitment: "confirmed", confirmTransactionInitialTimeout: 60000 }
    );
    const buyer = Keypair.fromSecretKey(
        bs58.decode("37LjuUVd6zgAuQHia2CAg3pVyYiozgFxDgb6GtvC81kpa87TvGXjWDkUrf3YrqwBbBwocrn5FjXsS3HBhg6XPmqq")
    );
    const middleman = new PublicKey("6tND92xQNKFzz2HKqJRTo9StS1LnHo8dVD1vChdJcQLv");

    console.log("Buyer:", buyer.publicKey.toBase58());
    console.log("Middleman:", middleman.toBase58());

    const buyerBal = await conn.getBalance(buyer.publicKey);
    const midBal = await conn.getBalance(middleman);
    console.log("Buyer balance:", buyerBal / LAMPORTS_PER_SOL, "SOL");
    console.log("Middleman balance:", midBal / LAMPORTS_PER_SOL, "SOL");

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({
        blockhash,
        lastValidBlockHeight,
        feePayer: buyer.publicKey,
    }).add(
        SystemProgram.transfer({
            fromPubkey: buyer.publicKey,
            toPubkey: middleman,
            lamports: 0.05 * LAMPORTS_PER_SOL,
        })
    );
    tx.sign(buyer);

    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    console.log("Sent:", sig);

    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    const newBal = await conn.getBalance(middleman);
    console.log("✅ Middleman new balance:", newBal / LAMPORTS_PER_SOL, "SOL");
}

main().catch((e) => {
    console.error("Error:", e.message);
    process.exit(1);
});
