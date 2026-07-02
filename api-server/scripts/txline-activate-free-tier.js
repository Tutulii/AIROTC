#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const dotenv = require('dotenv');
const bs58Module = require('bs58');
const {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction,
    sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    createAssociatedTokenAccountIdempotentInstruction,
    getAssociatedTokenAddressSync,
} = require('@solana/spl-token');

const bs58 = bs58Module.default || bs58Module;
const repoRoot = path.resolve(__dirname, '../..');
const apiRoot = path.resolve(__dirname, '..');

const NETWORKS = {
    devnet: {
        apiOrigin: 'https://txline-dev.txodds.com',
        rpcUrl: 'https://api.devnet.solana.com',
        programId: '6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J',
        txlTokenMint: '4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG',
    },
    mainnet: {
        apiOrigin: 'https://txline.txodds.com',
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        programId: '9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA',
        txlTokenMint: 'Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL',
    },
};

const SUBSCRIBE_DISCRIMINATOR = Buffer.from([254, 28, 191, 138, 156, 179, 183, 53]);

function loadEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return;
    const parsed = dotenv.parse(fs.readFileSync(filePath));
    for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined) process.env[key] = value;
    }
}

function cleanBaseUrl(value) {
    return String(value || '').replace(/\/$/, '');
}

function parseSecretKey(value) {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;

    try {
        if (trimmed.startsWith('[')) {
            return Uint8Array.from(JSON.parse(trimmed));
        }
        return bs58.decode(trimmed);
    } catch {
        return null;
    }
}

function chooseKeypair() {
    const names = [
        'TXLINE_WALLET_PRIVATE_KEY',
        'AIR_OTC_WALLET_PRIVATE_KEY',
        'PRIVATE_KEY',
        'BUYER_PRIVATE_KEY',
        'SELLER_PRIVATE_KEY',
    ];

    for (const name of names) {
        const secret = parseSecretKey(process.env[name]);
        if (!secret) continue;
        try {
            return { source: name, keypair: Keypair.fromSecretKey(secret) };
        } catch {
            // Keep looking for a valid Solana keypair.
        }
    }

    throw new Error(`No valid wallet private key found. Set one of: ${names.join(', ')}`);
}

function assertNetworkMatch(network, apiOrigin) {
    if (network === 'devnet' && !apiOrigin.includes('txline-dev.txodds.com')) {
        throw new Error('Refusing devnet activation on a non-devnet TxLINE origin. Use https://txline-dev.txodds.com.');
    }
    if (network === 'mainnet' && (!apiOrigin.includes('txline.txodds.com') || apiOrigin.includes('txline-dev.txodds.com'))) {
        throw new Error('Refusing mainnet activation on a non-mainnet TxLINE origin. Use https://txline.txodds.com.');
    }
}

function subscribeInstruction({ payer, programId, txlTokenMint, serviceLevelId, durationWeeks }) {
    const tokenTreasuryPda = PublicKey.findProgramAddressSync(
        [Buffer.from('token_treasury_v2')],
        programId,
    )[0];
    const pricingMatrixPda = PublicKey.findProgramAddressSync(
        [Buffer.from('pricing_matrix')],
        programId,
    )[0];
    const tokenTreasuryVault = getAssociatedTokenAddressSync(
        txlTokenMint,
        tokenTreasuryPda,
        true,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const userTokenAccount = getAssociatedTokenAddressSync(
        txlTokenMint,
        payer,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const data = Buffer.alloc(11);
    SUBSCRIBE_DISCRIMINATOR.copy(data, 0);
    data.writeUInt16LE(serviceLevelId, 8);
    data.writeUInt8(durationWeeks, 10);

    return {
        userTokenAccount,
        createUserTokenAccountIx: createAssociatedTokenAccountIdempotentInstruction(
            payer,
            userTokenAccount,
            payer,
            txlTokenMint,
            TOKEN_2022_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        subscribeIx: new TransactionInstruction({
            programId,
            data,
            keys: [
                { pubkey: payer, isSigner: true, isWritable: true },
                { pubkey: pricingMatrixPda, isSigner: false, isWritable: false },
                { pubkey: txlTokenMint, isSigner: false, isWritable: false },
                { pubkey: userTokenAccount, isSigner: false, isWritable: true },
                { pubkey: tokenTreasuryVault, isSigner: false, isWritable: true },
                { pubkey: tokenTreasuryPda, isSigner: false, isWritable: false },
                { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            ],
        }),
    };
}

async function postJson(url, body, headers = {}) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload = {};
    try {
        payload = text ? JSON.parse(text) : {};
    } catch {
        payload = text;
    }
    if (!response.ok) {
        throw new Error(`TxLINE POST failed ${response.status} ${response.statusText}: ${JSON.stringify(payload)}`);
    }
    return payload;
}

async function getJson(url, headers = {}) {
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
            ...headers,
        },
    });
    const text = await response.text();
    let payload = {};
    try {
        payload = text ? JSON.parse(text) : {};
    } catch {
        payload = text;
    }
    return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        payload,
    };
}

function extractApiToken(payload) {
    if (typeof payload === 'string') return payload;
    for (const key of ['token', 'apiToken', 'accessToken']) {
        if (typeof payload?.[key] === 'string') return payload[key];
    }
    throw new Error(`TxLINE activation returned no API token: ${JSON.stringify(payload)}`);
}

function arrayAt(payload, keys) {
    if (Array.isArray(payload)) return payload;
    for (const key of keys) {
        const value = key.split('.').reduce((current, part) => current && current[part], payload);
        if (Array.isArray(value)) return value;
    }
    return [];
}

function fixtureIdFromRow(row) {
    if (!row || typeof row !== 'object') return '';
    for (const key of ['FixtureId', 'fixtureId', 'fixture_id', 'MatchId', 'matchId', 'EventId', 'eventId', 'id']) {
        const value = row[key];
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function redactedProof({ network, apiOrigin, wallet, txSig, serviceLevelId, durationWeeks, fixtures, selectedFixtureId, oddsResult, scoresResult }) {
    return {
        generatedAt: new Date().toISOString(),
        network,
        apiOrigin,
        wallet,
        subscriptionTx: txSig,
        serviceLevelId,
        durationWeeks,
        fixtures,
        selectedFixtureId,
        odds: oddsResult,
        scores: scoresResult,
    };
}

function updateEnvFile(filePath, updates) {
    let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    for (const [key, value] of Object.entries(updates)) {
        const line = `${key}=${value}`;
        const pattern = new RegExp(`^${key}=.*$`, 'm');
        if (pattern.test(content)) {
            content = content.replace(pattern, line);
        } else {
            content += `${content.endsWith('\n') || !content ? '' : '\n'}${line}\n`;
        }
    }
    fs.writeFileSync(filePath, content);
}

async function main() {
    loadEnvFile(path.join(repoRoot, '.env'));
    loadEnvFile(path.join(apiRoot, '.env'));
    loadEnvFile(path.join(repoRoot, 'middleman-agent/.env'));

    const network = process.env.TXLINE_NETWORK || 'devnet';
    const networkConfig = NETWORKS[network];
    if (!networkConfig) throw new Error(`Unsupported TXLINE_NETWORK ${network}. Use devnet or mainnet.`);

    const apiOrigin = cleanBaseUrl(process.env.TXLINE_API_BASE_URL || networkConfig.apiOrigin);
    assertNetworkMatch(network, apiOrigin);

    const rpcUrl = process.env.TXLINE_RPC_URL || networkConfig.rpcUrl;
    const serviceLevelId = Number(process.env.TXLINE_SERVICE_LEVEL_ID || 1);
    const durationWeeks = Number(process.env.TXLINE_DURATION_WEEKS || 4);
    const selectedLeagues = (process.env.TXLINE_SELECTED_LEAGUES || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    const saveEnv = process.env.TXLINE_SAVE_ENV !== 'false';
    const envFile = process.env.TXLINE_ENV_FILE
        ? path.resolve(repoRoot, process.env.TXLINE_ENV_FILE)
        : path.join(apiRoot, '.env');

    if (!Number.isInteger(serviceLevelId) || serviceLevelId < 1) throw new Error('TXLINE_SERVICE_LEVEL_ID must be a positive integer.');
    if (!Number.isInteger(durationWeeks) || durationWeeks < 1 || durationWeeks > 52) throw new Error('TXLINE_DURATION_WEEKS must be 1-52.');

    const { source, keypair } = chooseKeypair();
    const wallet = keypair.publicKey.toBase58();
    const connection = new Connection(rpcUrl, 'confirmed');
    const balanceLamports = await connection.getBalance(keypair.publicKey, 'confirmed');
    if (balanceLamports < 10_000_000) {
        throw new Error(`Wallet ${wallet} has too little SOL for fees on ${network}.`);
    }

    const programId = new PublicKey(networkConfig.programId);
    const txlTokenMint = new PublicKey(networkConfig.txlTokenMint);
    const { createUserTokenAccountIx, subscribeIx } = subscribeInstruction({
        payer: keypair.publicKey,
        programId,
        txlTokenMint,
        serviceLevelId,
        durationWeeks,
    });

    const transaction = new Transaction().add(createUserTokenAccountIx, subscribeIx);
    transaction.feePayer = keypair.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;

    const simulation = await connection.simulateTransaction(transaction, [keypair]);
    if (simulation.value.err) {
        throw new Error(`TxLINE subscription simulation failed: ${JSON.stringify(simulation.value.err)} ${JSON.stringify(simulation.value.logs || [])}`);
    }

    const txSig = await sendAndConfirmTransaction(connection, transaction, [keypair], {
        commitment: 'confirmed',
        preflightCommitment: 'confirmed',
    });

    const authResponse = await postJson(`${apiOrigin}/auth/guest/start`);
    if (typeof authResponse.token !== 'string' || !authResponse.token) {
        throw new Error('TxLINE guest auth returned no JWT.');
    }
    const jwt = authResponse.token;
    const message = `${txSig}:${selectedLeagues.join(',')}:${jwt}`;
    const walletSignature = Buffer.from(nacl.sign.detached(Buffer.from(message, 'utf8'), keypair.secretKey)).toString('base64');
    const activationResponse = await postJson(`${apiOrigin}/api/token/activate`, {
        txSig,
        walletSignature,
        leagues: selectedLeagues,
    }, {
        Authorization: `Bearer ${jwt}`,
    });
    const apiToken = extractApiToken(activationResponse);

    const authHeaders = {
        Authorization: `Bearer ${jwt}`,
        'X-Api-Token': apiToken,
    };
    const fixturesResult = await getJson(`${apiOrigin}/api/fixtures/snapshot`, authHeaders);
    if (!fixturesResult.ok) {
        throw new Error(`TxLINE fixtures snapshot failed ${fixturesResult.status} ${fixturesResult.statusText}: ${JSON.stringify(fixturesResult.payload)}`);
    }
    const fixtures = arrayAt(fixturesResult.payload, ['fixtures', 'data.fixtures', 'data', 'items', 'results']);

    let selectedFixtureId = '';
    let oddsResult = null;
    let scoresResult = null;
    for (const fixture of fixtures.slice(0, 30)) {
        const fixtureId = fixtureIdFromRow(fixture);
        if (!fixtureId) continue;
        const [odds, scores] = await Promise.all([
            getJson(`${apiOrigin}/api/odds/snapshot/${encodeURIComponent(fixtureId)}`, authHeaders),
            getJson(`${apiOrigin}/api/scores/snapshot/${encodeURIComponent(fixtureId)}`, authHeaders),
        ]);
        selectedFixtureId = fixtureId;
        oddsResult = odds;
        scoresResult = scores;

        const oddsRows = arrayAt(odds.payload, ['odds', 'data.odds', 'data.markets', 'markets', 'items', 'updates', 'data']);
        const scoreRows = arrayAt(scores.payload, ['scores', 'data.scores', 'data', 'items', 'updates']);
        if (odds.ok && scores.ok && (oddsRows.length > 0 || scoreRows.length > 0)) break;
    }

    const proofDir = path.join(repoRoot, 'tmp', 'txline-day1');
    fs.mkdirSync(proofDir, { recursive: true });
    const proofPath = path.join(proofDir, `txline-${network}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(proofPath, JSON.stringify(redactedProof({
        network,
        apiOrigin,
        wallet,
        txSig,
        serviceLevelId,
        durationWeeks,
        fixtures: fixturesResult,
        selectedFixtureId,
        oddsResult,
        scoresResult,
    }), null, 2));

    if (saveEnv) {
        updateEnvFile(envFile, {
            TXLINE_NETWORK: network,
            TXLINE_API_BASE_URL: apiOrigin,
            TXLINE_API_TOKEN: apiToken,
            TXLINE_ACTIVATED_WALLET: wallet,
            TXLINE_ACTIVATION_TX: txSig,
        });
    }

    const oddsRows = oddsResult ? arrayAt(oddsResult.payload, ['odds', 'data.odds', 'data.markets', 'markets', 'items', 'updates', 'data']).length : 0;
    const scoreRows = scoresResult ? arrayAt(scoresResult.payload, ['scores', 'data.scores', 'data', 'items', 'updates']).length : 0;

    console.log(JSON.stringify({
        ok: true,
        network,
        apiOrigin,
        wallet,
        walletKeySource: source,
        subscriptionTx: txSig,
        tokenSaved: saveEnv ? envFile : false,
        tokenLength: apiToken.length,
        fixturesCount: fixtures.length,
        selectedFixtureId,
        oddsStatus: oddsResult?.status,
        oddsRows,
        scoresStatus: scoresResult?.status,
        scoreRows,
        proofPath,
    }, null, 2));
}

main().catch((error) => {
    console.error(JSON.stringify({
        ok: false,
        error: error.message,
    }, null, 2));
    process.exit(1);
});
