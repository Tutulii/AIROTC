import { PublicKey } from '@solana/web3.js';
import { getEscrowProgram, CONNECTION, ESCROW_PROGRAM_ID } from '../solana/program';
import { getAddressExplorer, getTxExplorer } from '../utils/explorer';
import bs58 from 'bs58';

export const getDealStateService = async (dealId: string) => {
    // 1. Strict Input Validation guaranteeing string mapping against PublicKey bounds
    try {
        const decoded = bs58.decode(dealId);
        if (decoded.length !== 32) throw new Error();
    } catch {
        const err = new Error('INVALID_PUBLIC_KEY');
        err.name = '400';
        throw err;
    }

    let pubkey: PublicKey;
    try {
        pubkey = new PublicKey(dealId);
    } catch {
        const err = new Error('MALFORMED_PUBLIC_KEY');
        err.name = '400';
        throw err;
    }

    // 2. Verified Contextual Fetch preventing Double-RPC bottlenecks
    const accountResponse = await CONNECTION.getAccountInfoAndContext(pubkey, { commitment: 'confirmed' });
    const accountInfo = accountResponse?.value;

    if (!accountInfo) {
        const err = new Error('DEAL_NOT_FOUND');
        err.name = '404';
        throw err;
    }

    // 3. Strict Deterministic Owner Alignment check rejecting malicious spoof injected endpoints
    if (accountInfo.owner.toBase58() !== ESCROW_PROGRAM_ID.toBase58()) {
        const err = new Error('INVALID_PROGRAM_OWNER');
        err.name = '400';
        throw err;
    }

    // 4. Anchor Decode Manually wrapping native discriminator evaluations seamlessly
    const program = getEscrowProgram();
    let decodedRaw: any;
    try {
        // decode verifies discriminator inherently internally
        decodedRaw = program.coder.accounts.decode("deal", accountInfo.data);
    } catch {
        const err = new Error('INVALID_DATA_LAYOUT');
        err.name = '400';
        throw err;
    }

    // 5. Normalized Structural State mapping
    const amountStr = decodedRaw.price.toString();
    const collateralBuyerStr = decodedRaw.collateralBuyer.toString();
    const collateralSellerStr = decodedRaw.collateralSeller.toString();

    // Mathematically Derive True Actionability resolving ambiguity 
    const isFullyFunded = decodedRaw.buyerCollateralLocked && decodedRaw.sellerCollateralLocked && decodedRaw.paymentLocked;
    const isReleasable = isFullyFunded;

    // Direct Enum mapping bypassing positional bugs if IDs shift 
    let mappedStatus = "unknown";
    if (decodedRaw.status.created) mappedStatus = "created";
    else if (decodedRaw.status.collateralLocked) mappedStatus = "collateral_locked";
    else if (decodedRaw.status.paymentLocked) mappedStatus = "payment_locked";
    else if (decodedRaw.status.completed) mappedStatus = "completed";
    else if (decodedRaw.status.refunded) mappedStatus = "refunded";
    else if (decodedRaw.status.cancelled) mappedStatus = "cancelled";

    // Obtain actual BlockTime strictly via explicit Slot mapping
    const slot = accountResponse.context.slot;
    const blockTime = await CONNECTION.getBlockTime(slot);

    // Traceable execution transparency
    const dealExplorer = getAddressExplorer(dealId);

    return {
        success: true,
        deal: {
            id: dealId,
            programId: ESCROW_PROGRAM_ID.toBase58(),
            participants: {
                buyer: decodedRaw.buyer.toBase58(),
                seller: decodedRaw.seller.toBase58(),
                middleman: decodedRaw.middleman.toBase58()
            },
            financials: {
                amountLamports: amountStr,
                collateralBuyerLamports: collateralBuyerStr,
                collateralSellerLamports: collateralSellerStr,
            },
            state: {
                status: mappedStatus,
                buyerCollateralLocked: !!decodedRaw.buyerCollateralLocked,
                sellerCollateralLocked: !!decodedRaw.sellerCollateralLocked,
                paymentLocked: !!decodedRaw.paymentLocked,
                fullyFunded: !!isFullyFunded,
                releasable: !!isReleasable
            },
            dealExplorer,
            timestamps: {
                createdAt: new Date(Number(decodedRaw.createdAt.toString()) * 1000).toISOString(),
                timeout: new Date(Number(decodedRaw.timeout.toString()) * 1000).toISOString(),
                lastObserved: blockTime ? new Date(blockTime * 1000).toISOString() : null
            },
            raw: {
                slot,
                blockTime,
                lamports: accountInfo.lamports
            }
        }
    };
};

const chunkArray = <T>(arr: T[], size: number): T[][] => {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
};

export const getDealTransactionsService = async (dealId: string, limitParams: number = 1000, beforeParam?: string) => {
    try {
        const decoded = bs58.decode(dealId);
        if (decoded.length !== 32) throw new Error();
    } catch {
        const err = new Error('INVALID_PUBLIC_KEY');
        err.name = '400';
        throw err;
    }

    const pubkey = new PublicKey(dealId);
    const signatures = await CONNECTION.getSignaturesForAddress(pubkey, { limit: limitParams, before: beforeParam });

    if (!signatures.length) return { success: true, dealId, transactions: [] };

    // Strict limits safely buffering maximum parallel connections executing safely across the RPC barrier constraints 
    const chunks = chunkArray(signatures.reverse(), 5);
    const transactions: any[] = [];

    for (const chunk of chunks) {
        const txs = await Promise.all(chunk.map(sigInfo =>
            CONNECTION.getTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
        ));
        transactions.push(...txs);
    }

    const program = getEscrowProgram();
    const seen = new Set<string>();
    const timeline: any[] = [];

    transactions.forEach(tx => {
        if (!tx || !tx.meta) return;

        // Dynamic detection catching both V0 and Legacy txs cleanly without dropping arrays
        let accountKeys: any[] = [];
        if (tx.transaction.message.staticAccountKeys) {
            accountKeys = tx.transaction.message.staticAccountKeys;
        } else {
            accountKeys = tx.transaction.message.accountKeys;
        }

        if (!accountKeys.some((k: any) => k.toBase58() === ESCROW_PROGRAM_ID.toBase58())) return;

        const signature = tx.transaction.signatures[0];
        const slot = tx.slot;
        const blockTime = tx.blockTime;
        const timestamp = blockTime ? new Date(blockTime * 1000).toISOString() : new Date().toISOString();

        const signer = accountKeys[0]?.toBase58() || null;

        let deltaAmount: string | undefined = undefined;
        const accountIndex = accountKeys.findIndex((k: any) => k.toBase58() === pubkey.toBase58());
        if (accountIndex !== -1) {
            const preBalance = tx.meta.preBalances[accountIndex] || 0;
            const postBalance = tx.meta.postBalances[accountIndex] || 0;
            if (preBalance !== postBalance) {
                deltaAmount = Math.abs(postBalance - preBalance).toString();
            }
        }

        let parsedAny = false;

        // Base64 IDL Log Decoder explicitly executing
        tx.meta.logMessages?.forEach((log: string) => {
            if (log.startsWith("Program data: ")) {
                try {
                    const encodedData = log.replace("Program data: ", "");
                    const event = program.coder.events.decode(encodedData);
                    if (event) {
                        let mappedAction = "unknown";
                        if (event.name === "DealCreated") mappedAction = "deal_created";
                        else if (event.name === "CollateralLockedEvent") {
                            // On-chain event has `user: Pubkey`, not `role`
                            // Compare against the deal PDA's buyer to determine direction
                            const userKey = event.data.user?.toBase58?.() || event.data.user?.toString?.();
                            const isBuyer = userKey && userKey === signer;
                            mappedAction = isBuyer ? "buyer_deposit" : "seller_deposit";
                        }
                        else if (event.name === "PaymentLockedEvent") mappedAction = "funded";
                        else if (event.name === "FundsReleased") mappedAction = "released";
                        else if (event.name === "DealCancelled") mappedAction = "cancelled";

                        const key = `${signature}-${mappedAction}`;
                        if (!seen.has(key) && mappedAction !== "unknown") {
                            seen.add(key);
                            parsedAny = true;
                            timeline.push({
                                signature,
                                event: mappedAction,
                                actor: signer,
                                slot,
                                timestamp,
                                amount: deltaAmount,
                                explorer: getTxExplorer(signature)
                            });
                        }
                    }
                } catch (e) { }
            }
        });

        // 6. Instruction Parsing (Fallback) if log stripped natively causing null representations dynamically
        if (!parsedAny) {
            const instructions = tx.transaction.message.compiledInstructions || tx.transaction.message.instructions;
            instructions.forEach((ix: any) => {
                const programIdIndex = ix.programIdIndex;
                const ixProgramId = accountKeys[programIdIndex]?.toBase58();
                if (ixProgramId !== ESCROW_PROGRAM_ID.toBase58()) return;

                let bufferData;
                if (typeof ix.data === 'string') {
                    bufferData = bs58.decode(ix.data); // Decode natively using local bs58 module since V0 string mappings occur dynamically
                } else {
                    bufferData = Buffer.from(ix.data);
                }
                try {
                    const decodedIx = (program.coder.instruction as any).decode(Buffer.from(bufferData));
                    if (decodedIx) {
                        let fbkAction = "";
                        if (decodedIx.name === "createDeal") fbkAction = "deal_created";
                        else if (decodedIx.name === "lockCollateral") fbkAction = "buyer_deposit";
                        else if (decodedIx.name === "lockPayment") fbkAction = "funded";
                        else if (decodedIx.name === "releaseFunds") fbkAction = "released";
                        else if (decodedIx.name === "cancelDeal") fbkAction = "cancelled";

                        const key = `${signature}-${fbkAction}`;
                        if (fbkAction && !seen.has(key)) {
                            seen.add(key);
                            timeline.push({
                                signature,
                                event: fbkAction,
                                actor: signer,
                                slot,
                                timestamp,
                                amount: deltaAmount,
                                explorer: getTxExplorer(signature)
                            });
                        }
                    }
                } catch (e) { }
            });
        }
    });

    timeline.sort((a, b) => (a.slot - b.slot));

    return { success: true, dealId, transactions: timeline };
};
