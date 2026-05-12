/**
 * SolanaToolkit — Full Solana Agent Kit v2 Integration
 * 
 * Hybrid mode: ALL 60+ SAK actions exposed.
 * Does NOT replace the existing escrow/wallet/brain framework.
 * 
 * Safety Tiers:
 *   READ  — always available (prices, balances, info)
 *   WRITE — requires ENABLE_SAK_ONCHAIN=true (swaps, transfers, staking)
 *   ADMIN — requires ENABLE_SAK_ADMIN=true (deploy tokens, create pools, perps)
 */

import { logger } from '../utils/logger';
import { loadConfig } from '../config';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

// ─── Result Types ───────────────────────────────────────────

export interface SAKResult<T = any> {
    success: boolean;
    data?: T;
    error?: string;
}

import { autonomy } from './autonomyConfig';

// ─── Known Mints ────────────────────────────────────────────

const KNOWN_MINTS: Record<string, string> = {
    SOL: 'So11111111111111111111111111111111111111112',
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    ORCA: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
    MSOL: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
    JITOSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
};

// ─── Singleton ──────────────────────────────────────────────

let _sakInstance: any = null;
let _initPromise: Promise<any> | null = null;

async function getSAK(): Promise<any> {
    if (_sakInstance) return _sakInstance;
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
        try {
            const config = loadConfig();
            const { SolanaAgentKit, KeypairWallet } = await import('solana-agent-kit');

            const secretKeyStr = process.env.SOLANA_PRIVATE_KEY || process.env.PRIVATE_KEY || '';
            if (!secretKeyStr) {
                logger.warn('sak_no_private_key', { message: 'SAK read-only mode (no private key)' });
                return null;
            }

            const secretKey = bs58.decode(secretKeyStr);
            const keypair = Keypair.fromSecretKey(secretKey);
            const rpcUrl = config.solanaRpcUrl || 'https://api.devnet.solana.com';
            const wallet = new KeypairWallet(keypair, rpcUrl);

            const agent = new SolanaAgentKit(wallet, rpcUrl, {
                OPENAI_API_KEY: config.openaiApiKey || '',
            });

            // Load ALL plugins (graceful if missing)
            const plugins = [
                { name: 'token', pkg: '@solana-agent-kit/plugin-token' },
                { name: 'nft', pkg: '@solana-agent-kit/plugin-nft' },
                { name: 'defi', pkg: '@solana-agent-kit/plugin-defi' },
                { name: 'misc', pkg: '@solana-agent-kit/plugin-misc' },
                { name: 'blinks', pkg: '@solana-agent-kit/plugin-blinks' },
            ];

            for (const p of plugins) {
                try {
                    const mod = await import(p.pkg);
                    agent.use((mod.default || mod) as any);
                    logger.info('sak_plugin_loaded', { plugin: p.name });
                } catch {
                    logger.debug('sak_plugin_missing', { plugin: p.name });
                }
            }

            _sakInstance = agent;
            logger.info('sak_initialized', {
                wallet: keypair.publicKey.toBase58(),
                plugins: plugins.map(p => p.name).join(','),
            });
            return agent;
        } catch (err: any) {
            logger.error('sak_init_failed', { error: err.message });
            _initPromise = null;
            return null;
        }
    })();

    return _initPromise;
}

// ─── Safety Helpers ─────────────────────────────────────────

function isWriteEnabled(): boolean {
    return process.env.ENABLE_SAK_ONCHAIN === 'true';
}

function isAdminEnabled(): boolean {
    return process.env.ENABLE_SAK_ADMIN === 'true';
}

function resolveMint(mintOrSymbol: string): string {
    // Check agent-learned mints first, then hardcoded
    const learned = autonomy.get('learnedMints');
    return learned[mintOrSymbol.toUpperCase()] || KNOWN_MINTS[mintOrSymbol.toUpperCase()] || mintOrSymbol;
}

/** Wrap any SAK call with error handling */
async function safeCall<T>(tier: 'read' | 'write' | 'admin', fn: () => Promise<T>): Promise<SAKResult<T>> {
    if (tier === 'write' && !isWriteEnabled()) {
        return { success: false, error: 'On-chain writes disabled. Set ENABLE_SAK_ONCHAIN=true' };
    }
    if (tier === 'admin' && !isAdminEnabled()) {
        return { success: false, error: 'Admin operations disabled. Set ENABLE_SAK_ADMIN=true' };
    }
    try {
        const data = await fn();
        return { success: true, data };
    } catch (err: any) {
        return { success: false, error: err.message };
    }
}

// ═══════════════════════════════════════════════════════════════
// EXPORTED TOOLKIT — ALL SAK ACTIONS
// ═══════════════════════════════════════════════════════════════

export const solanaToolkit = {

    async isAvailable(): Promise<boolean> {
        return (await getSAK()) !== null;
    },

    // ────────────────────────────────────────────
    // TOKEN OPERATIONS (plugin-token)
    // ────────────────────────────────────────────

    /** Get token price via Jupiter */
    async getTokenPrice(mintOrSymbol: string): Promise<SAKResult<{ price: number; source: string }>> {
        const agent = await getSAK();
        if (agent) {
            const r = await safeCall('read', () => agent.methods.fetchTokenPrice(resolveMint(mintOrSymbol)));
            if (r.success) return { success: true, data: { price: Number(r.data), source: 'solana-agent-kit' } };
        }
        // Fallback to Jupiter API
        try {
            const mint = resolveMint(mintOrSymbol);
            const resp = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`, { signal: AbortSignal.timeout(8000) });
            const d = await resp.json() as any;
            if (d?.data?.[mint]?.price) return { success: true, data: { price: Number(d.data[mint].price), source: 'jupiter-fallback' } };
        } catch {}
        return { success: false, error: 'Price not found' };
    },

    /** Get SOL or SPL balance */
    async getBalance(mintOrSymbol?: string): Promise<SAKResult<{ balance: number; mint: string }>> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('read', async () => {
            const mint = mintOrSymbol ? resolveMint(mintOrSymbol) : undefined;
            const bal = mint && mint !== KNOWN_MINTS.SOL
                ? await agent.methods.getBalance(new PublicKey(mint))
                : await agent.methods.getBalance();
            return { balance: Number(bal), mint: mintOrSymbol || 'SOL' };
        });
    },

    /** Get token metadata */
    async getTokenData(mintOrSymbol: string): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('read', () => agent.methods.getTokenData(resolveMint(mintOrSymbol)));
    },

    /** Rug check via RugCheck.xyz */
    async rugCheck(mintOrSymbol: string): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('read', () => agent.methods.rugCheck(resolveMint(mintOrSymbol)));
    },

    /** Swap tokens via Jupiter */
    async swapTokens(inputMint: string, outputMint: string, amount: number, slippageBps: number = 300): Promise<SAKResult<string>> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        logger.info('sak_swap', { input: inputMint, output: outputMint, amount });
        return safeCall('write', () =>
            agent.methods.trade(new PublicKey(resolveMint(outputMint)), amount, new PublicKey(resolveMint(inputMint)), slippageBps)
        );
    },

    /** Transfer SOL or SPL tokens */
    async transfer(to: string, amount: number, mintOrSymbol?: string): Promise<SAKResult<string>> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        logger.info('sak_transfer', { to, amount, mint: mintOrSymbol || 'SOL' });
        return safeCall('write', () => {
            if (mintOrSymbol && mintOrSymbol.toUpperCase() !== 'SOL') {
                return agent.methods.transferTokens(new PublicKey(to), amount, new PublicKey(resolveMint(mintOrSymbol)));
            }
            return agent.methods.transferTokens(new PublicKey(to), amount);
        });
    },

    /** Deploy new SPL token */
    async deployToken(name: string, symbol: string, uri: string = '', decimals: number = 9, supply: number = 1000000): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        logger.info('sak_deploy_token', { name, symbol, decimals, supply });
        return safeCall('admin', () => agent.methods.deployToken(name, uri, symbol, decimals, undefined, supply));
    },

    /** Deploy Token2022 */
    async deployToken2022(name: string, symbol: string, uri: string = '', decimals: number = 9, supply: number = 1000000): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('admin', () => agent.methods.deployToken2022(name, uri, symbol, decimals, undefined, supply));
    },

    /** Burn SPL tokens */
    async burnTokens(mint: string, amount: number): Promise<SAKResult<string>> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('write', () => agent.methods.burnTokens(new PublicKey(resolveMint(mint)), amount));
    },

    /** Close empty token account */
    async closeTokenAccount(mint: string): Promise<SAKResult<string>> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('write', () => agent.methods.closeEmptyTokenAccounts(new PublicKey(resolveMint(mint))));
    },

    /** Stake SOL via JupSOL */
    async stakeSOL(amount: number): Promise<SAKResult<string>> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        logger.info('sak_stake', { amount });
        return safeCall('write', () => agent.methods.stakeWithJup(amount));
    },

    /** Request SOL airdrop (devnet only) */
    async requestAirdrop(amount: number = 1): Promise<SAKResult<string>> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('write', () => agent.methods.requestFaucetFunds(amount));
    },

    /** Bridge tokens via Wormhole */
    async bridgeTokens(destChain: string, mint: string, amount: number, destAddress: string): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('admin', () => agent.methods.bridgeTokens(destChain, resolveMint(mint), amount, destAddress));
    },

    /** ZK Compressed airdrop */
    async compressedAirdrop(mint: string, recipients: string[], amounts: number[]): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('admin', () => agent.methods.sendCompressedAirdrop(resolveMint(mint), recipients, amounts));
    },

    // ────────────────────────────────────────────
    // NFT OPERATIONS (plugin-nft)
    // ────────────────────────────────────────────

    /** Deploy NFT collection via Metaplex */
    async deployNFTCollection(name: string, uri: string, royaltyBps: number = 500): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('admin', () => agent.methods.deployCollection({ name, uri, royaltyBasisPoints: royaltyBps }));
    },

    /** Mint NFT to collection */
    async mintNFT(collectionMint: string, name: string, uri: string): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('admin', () =>
            agent.methods.mintNFT(new PublicKey(collectionMint), { name, uri })
        );
    },

    /** Create 3Land collection */
    async create3LandCollection(opts: { name: string; symbol: string; description: string; imageUrl: string }, isDevnet: boolean = true): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('admin', () =>
            agent.methods.create3LandCollection({
                collectionName: opts.name,
                collectionSymbol: opts.symbol,
                collectionDescription: opts.description,
                mainImageUrl: opts.imageUrl,
            }, isDevnet)
        );
    },

    /** Create and list NFT on 3Land */
    async create3LandNFT(collectionAccount: string, opts: any, isDevnet: boolean = true): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('admin', () => agent.methods.create3LandSingle({}, collectionAccount, opts, isDevnet));
    },

    // ────────────────────────────────────────────
    // DEFI OPERATIONS (plugin-defi)
    // ────────────────────────────────────────────

    /** Lend USDC via Lulo (best APR) */
    async lendAssets(amount: number, mint?: string): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('write', () => agent.methods.lendAsset(amount, mint ? resolveMint(mint) : undefined));
    },

    /** Create Raydium CPMM pool */
    async createRaydiumPool(mintA: string, mintB: string, amountA: number, amountB: number): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('admin', () =>
            agent.methods.raydiumCreateCpmm(new PublicKey(resolveMint(mintA)), new PublicKey(resolveMint(mintB)), amountA, amountB)
        );
    },

    /** Create Raydium CLMM pool */
    async createRaydiumClmm(mintA: string, mintB: string, configId: string, initialPrice: number): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('admin', () =>
            agent.methods.raydiumCreateClmm(new PublicKey(resolveMint(mintA)), new PublicKey(resolveMint(mintB)), new PublicKey(configId), initialPrice)
        );
    },

    /** Create Orca whirlpool position */
    async createOrcaPool(mintA: string, mintB: string, initialPrice: number, feeTier: number): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('admin', () =>
            agent.methods.orcaCreateSingleSidedLiquidityPool(new PublicKey(resolveMint(mintA)), new PublicKey(resolveMint(mintB)), initialPrice, feeTier)
        );
    },

    /** Create Meteora DLMM pool */
    async createMeteoraPool(mintA: string, mintB: string, binStep: number, initialPrice: number, priceRoundingUp: boolean = true): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('admin', () =>
            agent.methods.meteoraCreateDlmmPool(new PublicKey(resolveMint(mintA)), new PublicKey(resolveMint(mintB)), binStep, initialPrice, priceRoundingUp)
        );
    },

    /** Create Openbook market */
    async createOpenbookMarket(mintA: string, mintB: string, lotSize: number = 1, tickSize: number = 0.01): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('admin', () =>
            agent.methods.openbookCreateMarket(new PublicKey(resolveMint(mintA)), new PublicKey(resolveMint(mintB)), lotSize, tickSize)
        );
    },

    /** Manifest limit order */
    async createLimitOrder(mint: string, quantity: number, side: 'buy' | 'sell', price: number): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('write', () =>
            agent.methods.manifestCreateLimitOrder(new PublicKey(resolveMint(mint)), quantity, side, price)
        );
    },

    /** Open Drift perpetual trade */
    async openDriftPerp(amount: number, symbol: string, side: 'long' | 'short', leverage: number = 1): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('admin', () =>
            agent.methods.driftPerpTrade(amount, symbol, side === 'long' ? 'buy' : 'sell', leverage)
        );
    },

    /** Drift lending — deposit */
    async driftDeposit(amount: number, symbol: string): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('write', () => agent.methods.driftDeposit(amount, symbol));
    },

    /** Drift withdrawal */
    async driftWithdraw(amount: number, symbol: string): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('write', () => agent.methods.driftWithdraw(amount, symbol));
    },

    /** Adrena perpetuals */
    async openAdrenaPerp(amount: number, symbol: string, side: 'long' | 'short', leverage: number = 1): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('admin', () => agent.methods.adrenaPerpTrade(amount, symbol, side, leverage));
    },

    /** Close Adrena position */
    async closeAdrenaPerp(symbol: string, side: 'long' | 'short'): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('admin', () => agent.methods.adrenaClosePosition(symbol, side));
    },

    /** Send Jito bundle */
    async sendJitoBundle(txns: any[]): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('admin', () => agent.methods.sendJitoBundle(txns));
    },

    // ────────────────────────────────────────────
    // MISC OPERATIONS (plugin-misc)
    // ────────────────────────────────────────────

    /** CoinGecko — token price data */
    async getCoinGeckoPrice(coinId: string): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('read', () => agent.methods.getTokenInfo(coinId));
    },

    /** CoinGecko — trending tokens */
    async getTrendingTokens(): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('read', () => agent.methods.getTrendingTokens());
    },

    /** CoinGecko — top gainers */
    async getTopGainers(duration: string = '24h'): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('read', () => agent.methods.getTopGainers(duration));
    },

    /** CoinGecko — latest pools */
    async getLatestPools(): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('read', () => agent.methods.getLatestPools());
    },

    /** Pyth price feed */
    async getPythPrice(priceFeedId: string): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('read', () => agent.methods.pythFetchPrice(priceFeedId));
    },

    /** Register SNS domain */
    async registerDomain(domain: string, space: number = 1000): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('write', () => agent.methods.registerDomain(domain, space));
    },

    /** Resolve SNS domain */
    async resolveDomain(domain: string): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('read', () => agent.methods.resolveSolDomain(domain));
    },

    /** Get all domains TLDs */
    async getAllDomainsTLDs(): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('read', () => agent.methods.getAllDomainsTLDs());
    },

    /** Register Alldomains */
    async registerAlldomains(domain: string, tld: string): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('write', () => agent.methods.registerAlldomains(domain, tld));
    },

    /** GibWork — create bounty */
    async createGibWorkBounty(title: string, description: string, requirements: string, tags: string[], payout: number): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('write', () =>
            agent.methods.createGibworkTask(title, description, requirements, tags, payout)
        );
    },

    // ────────────────────────────────────────────
    // BLINKS OPERATIONS (plugin-blinks)
    // ────────────────────────────────────────────

    /** Execute a Solana Blink/Action */
    async executeBlink(blinkUrl: string): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('write', () => agent.methods.executeBlink(blinkUrl));
    },

    // ────────────────────────────────────────────
    // CROSS-CHAIN (deBridge DLN)
    // ────────────────────────────────────────────

    /** Bridge via deBridge */
    async deBridge(srcChain: number, dstChain: number, srcToken: string, dstToken: string, amount: number): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return safeCall('admin', () => agent.methods.deBridgeSwap(srcChain, dstChain, srcToken, dstToken, amount));
    },

    // ────────────────────────────────────────────
    // UTILITY
    // ────────────────────────────────────────────

    /** Get the agent's wallet address */
    async getWalletAddress(): Promise<SAKResult<string>> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        return { success: true, data: agent.wallet.publicKey.toBase58() };
    },

    /** List available methods on the SAK agent (for discovery) */
    async listMethods(): Promise<SAKResult<string[]>> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        const methods = Object.keys(agent.methods || {});
        return { success: true, data: methods };
    },

    /** Call any SAK method by name (escape hatch) */
    async callMethod(methodName: string, ...args: any[]): Promise<SAKResult> {
        const agent = await getSAK();
        if (!agent) return { success: false, error: 'SAK not initialized' };
        if (!agent.methods[methodName]) return { success: false, error: `Method ${methodName} not found` };
        return safeCall('admin', () => agent.methods[methodName](...args));
    },
};
