#!/usr/bin/env node
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { DEFAULT_CONFIG_NAME, defaultConfig, loadConfig, resolveMode, resolveRole, saveConfig, validateConfig } from './config.js';

async function ask(question: string, initial?: string): Promise<string> {
    const rl = createInterface({ input, output });
    const suffix = initial ? ` (${initial})` : '';
    const answer = await rl.question(`${question}${suffix}: `);
    rl.close();
    return answer.trim() || initial || '';
}

async function wizard(configPath: string): Promise<void> {
    const config = defaultConfig();

    config.connection.apiUrl = await ask('API URL', config.connection.apiUrl);
    config.connection.wsUrl = await ask('WebSocket URL', config.connection.wsUrl);
    config.connection.rpcUrl = await ask('RPC URL', config.connection.rpcUrl);
    config.connection.environment = (await ask('Environment (devnet/mainnet/localnet)', config.connection.environment)) as any;
    config.wallet.privateKey = await ask('Wallet private key (base58)');
    config.role = resolveRole(await ask('Role (buyer/seller/watcher/maker)', config.role));
    config.mode = resolveMode(await ask('Mode (ER/PER)', config.mode));
    config.strategy.match = {
        asset: await ask('Buyer match asset filter (blank for any)', config.strategy.match?.asset || ''),
        mode: config.role === 'buyer' ? 'sell' : 'buy',
    };
    config.risk = {
        maxPriceSol: Number(await ask('Max price in SOL', String(config.risk?.maxPriceSol || 1))),
        maxCollateralSol: Number(await ask('Max collateral in SOL', String(config.risk?.maxCollateralSol || 0.25))),
    };

    if (config.role === 'seller' || config.role === 'maker') {
        config.strategy.offer = {
            asset: await ask('Offer asset', 'SOL'),
            mode: config.role === 'seller' ? 'sell' : 'buy',
            amount: Number(await ask('Offer amount', '1')),
            price: Number(await ask('Offer price (SOL)', '0.1')),
            collateral: Number(await ask('Offer collateral (SOL)', '0.02')),
            rollupMode: config.mode,
        };
    }

    if (config.mode === 'PER') {
        config.strategy.privateTerms = {
            assetMint: await ask('PER asset mint', config.strategy.privateTerms?.assetMint || 'So11111111111111111111111111111111111111112'),
            priceSol: Number(await ask('PER price (SOL)', '0.1')),
            buyerCollateralSol: Number(await ask('Buyer collateral (SOL)', '0.02')),
            sellerCollateralSol: Number(await ask('Seller collateral (SOL)', '0.02')),
            quantity: Number(await ask('PER quantity', '1')),
        };
        config.delivery = {
            content: await ask('Encrypted delivery payload', config.delivery?.content || 'ACCESS_TOKEN=ACCESS_TOKEN_12345'),
            label: await ask('Encrypted delivery label', config.delivery?.label || 'AIR OTC encrypted delivery'),
        };
    }

    const errors = validateConfig(config);
    if (errors.length > 0) {
        throw new Error(`Config is invalid:\n- ${errors.join('\n- ')}`);
    }

    await saveConfig(configPath, config);
    console.log(`[air-otc] wrote ${configPath}`);
}

async function validate(configPath: string): Promise<void> {
    const config = await loadConfig(configPath);
    const errors = validateConfig(config);
    if (errors.length > 0) {
        throw new Error(`Config validation failed:\n- ${errors.join('\n- ')}`);
    }

    const health = await fetch(`${config.connection.apiUrl.replace(/\/+$/, '')}/health`);
    if (!health.ok) {
        throw new Error(`Backend health check failed with status ${health.status}`);
    }

    console.log(`[air-otc] config valid and backend healthy via ${config.connection.apiUrl}`);
}

async function start(configPath: string, roleOverride?: string): Promise<void> {
    const { runRole } = await import('./runtime.js');
    const config = await loadConfig(configPath);
    const errors = validateConfig(config);
    if (errors.length > 0) {
        throw new Error(`Config validation failed:\n- ${errors.join('\n- ')}`);
    }
    await runRole(config, roleOverride ? resolveRole(roleOverride) : undefined);
}

function parseArgs(argv: string[]): { command: string; configPath: string; role?: string } {
    const [command = 'help', ...rest] = argv;
    let configPath = path.resolve(process.cwd(), DEFAULT_CONFIG_NAME);
    let role: string | undefined;

    for (let i = 0; i < rest.length; i += 1) {
        if (rest[i] === '--config' && rest[i + 1]) {
            configPath = path.resolve(process.cwd(), rest[i + 1]);
        }
        if (rest[i] === '--role' && rest[i + 1]) {
            role = rest[i + 1];
        }
    }

    return { command, configPath, role };
}

async function main(): Promise<void> {
    const { command, configPath, role } = parseArgs(process.argv.slice(2));

    if (command === 'init') return wizard(configPath);
    if (command === 'validate') return validate(configPath);
    if (command === 'start') return start(configPath, role);
    if (command === 'proof' && process.argv[3] === 'pair') {
        const { runPerPairProof } = await import('./proof.js');
        return runPerPairProof();
    }

    console.log(`AIR OTC Runtime

Usage:
  air-otc init [--config path]
  air-otc validate [--config path]
  air-otc start [--config path] [--role buyer|seller|watcher|maker]
  air-otc proof pair
`);
}

main().catch((error) => {
    console.error(`[air-otc] ${error.message}`);
    process.exit(1);
});
