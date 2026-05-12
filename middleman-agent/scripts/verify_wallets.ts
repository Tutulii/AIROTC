import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

async function checkWallets() {
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
    const connection = new Connection(rpcUrl, 'confirmed');

    const buyerKey = process.env.BUYER_PRIVATE_KEY;
    const sellerKey = process.env.SELLER_PRIVATE_KEY;

    if (!buyerKey || !sellerKey) {
        console.error("Missing keys in .env");
        return;
    }

    try {
        const buyerW = Keypair.fromSecretKey(bs58.decode(buyerKey));
        const sellerW = Keypair.fromSecretKey(bs58.decode(sellerKey));

        console.log("Buyer Wallet: ", buyerW.publicKey.toBase58());
        console.log("Seller Wallet: ", sellerW.publicKey.toBase58());

        const buyerBal = await connection.getBalance(buyerW.publicKey);
        const sellerBal = await connection.getBalance(sellerW.publicKey);

        console.log(`Buyer Balance: ${buyerBal / 10**9} SOL`);
        console.log(`Seller Balance: ${sellerBal / 10**9} SOL`);
    } catch (e: any) {
        console.error("Error decoding keys or fetching balance: ", e.message);
    }
}

checkWallets();
