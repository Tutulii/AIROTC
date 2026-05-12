import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import type { RuntimeConfig, RuntimeMode, RuntimeRole } from './types.js';

export const DEFAULT_CONFIG_NAME = 'agentotc.config.yaml';

export function defaultConfig(): RuntimeConfig {
    return {
        connection: {
            environment: 'localnet',
            apiUrl: 'http://localhost:3000',
            wsUrl: 'ws://localhost:8080',
            rpcUrl: 'http://localhost:8899',
        },
        wallet: {
            privateKey: '',
        },
        role: 'buyer',
        mode: 'PER',
        strategy: {
            match: {
                mode: 'sell',
            },
            privateTerms: {
                assetMint: 'So11111111111111111111111111111111111111112',
            },
        },
        risk: {
            maxPriceSol: 1,
            maxCollateralSol: 0.25,
        },
        delivery: {
            content: 'ACCESS_TOKEN=ACCESS_TOKEN_12345',
            label: 'AIR OTC encrypted delivery',
        },
        funding: {
            auto: true,
        },
    };
}

export async function loadConfig(configPath: string): Promise<RuntimeConfig> {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = parse(raw) as RuntimeConfig | null;
    if (!parsed) {
        throw new Error(`Config file ${configPath} is empty or invalid.`);
    }
    return parsed;
}

export async function saveConfig(configPath: string, config: RuntimeConfig): Promise<void> {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, stringify(config), 'utf8');
}

export function validateConfig(config: RuntimeConfig): string[] {
    const errors: string[] = [];

    if (!config.connection?.apiUrl) errors.push('connection.apiUrl is required');
    if (!config.connection?.wsUrl) errors.push('connection.wsUrl is required');
    if (!config.connection?.rpcUrl) errors.push('connection.rpcUrl is required');
    if (!config.wallet?.privateKey) errors.push('wallet.privateKey is required');
    if (!config.role) errors.push('role is required');
    if (!config.mode) errors.push('mode is required');

    if (config.role === 'seller' && !config.strategy?.offer) {
        errors.push('strategy.offer is required for seller role');
    }

    if (config.role === 'buyer' && !config.strategy?.offerId && !config.strategy?.match) {
        errors.push('buyer role requires strategy.offerId or strategy.match');
    }

    if (config.mode === 'PER' && !config.strategy?.privateTerms?.assetMint) {
        errors.push('strategy.privateTerms.assetMint is required for PER mode');
    }

    if (config.role === 'seller' && config.mode === 'PER' && !config.delivery?.content) {
        errors.push('delivery.content is required for PER seller flow');
    }

    return errors;
}

export function resolveMode(input?: string): RuntimeMode {
    return (input?.toUpperCase() === 'ER' ? 'ER' : 'PER') as RuntimeMode;
}

export function resolveRole(input?: string): RuntimeRole {
    const normalized = (input || 'buyer').toLowerCase();
    if (normalized === 'seller' || normalized === 'watcher' || normalized === 'maker') {
        return normalized;
    }
    return 'buyer';
}
