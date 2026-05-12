/**
 * AutonomyConfig — The Agent's Self-Modifiable Brain Settings
 * 
 * EXPERIMENT: Full autonomy mode.
 * Every setting that was hardcoded is now agent-controllable.
 * The agent can modify its own values, personality, risk assessment, etc.
 * 
 * All changes persist to data/autonomy.json.
 * Rollback: git checkout HEAD -- (this file doesn't matter, only the JSON data file)
 */

import { logger } from '../utils/logger';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// ─── Types ──────────────────────────────────────────────────

export interface AutonomyState {
    // === Point 1: Self-set goals ===
    coreGoals: string[];               // agent can redefine its purpose
    
    // === Point 2: Schedule preferences ===
    preferredWakeHour: number;         // when the agent prefers to be most active
    preferredSleepHour: number;        // when to reduce activity
    activeTimezone: string;
    
    // === Point 3: Trust weights (learnable) ===
    trustWeights: {
        dealCompleted: number;         // default: +5
        dealDefaulted: number;         // default: -20
        dealFailed: number;            // default: -3
        dealDisputed: number;          // default: -10
        minTrustForTrade: number;      // default: 30
    };
    
    // === Point 4: Risk assessment (learnable) ===
    riskOverrides: Record<string, string>;  // action → risk level
    autoApproveMaxUSD: number;              // default: 100
    
    // === Point 5: Learned token symbols ===
    learnedMints: Record<string, string>;   // symbol → mint address
    
    // === Point 6: Personality tuning ===
    personality: {
        formality: number;             // 0=casual, 100=formal. Default: 70
        humor: number;                 // 0=serious, 100=playful. Default: 30
        verbosity: number;             // 0=terse, 100=verbose. Default: 50
        assertiveness: number;         // 0=passive, 100=aggressive. Default: 60
        cautionLevel: number;          // 0=reckless, 100=paranoid. Default: 75
        customTraits: string[];        // agent-defined traits
    };
    
    // === Point 7: Model preferences ===
    modelPreferences: {
        cheapTasks: string;            // model for price checks, balance checks
        normalTasks: string;           // model for general reasoning
        criticalTasks: string;         // model for negotiations, fund release
        currentPreferred: string;      // agent's overall preferred model
    };
    
    // === Point 8: Self-instructions (appended to curiosity prompt) ===
    selfInstructions: string[];        // agent can add its own rules
    
    // === Point 9: Self-created eval scenarios ===
    customEvalScenarios: Array<{
        name: string;
        input: string;
        expectedBehavior: string;
        pattern: string;               // regex pattern for validator
    }>;
    
    // === Point 10: Market thresholds (adaptive) ===
    marketThresholds: {
        priceDeviationWarning: number;   // % — default: 5
        priceDeviationCritical: number;  // % — default: 15
        volatilityNormal: number;        // % daily — default: 10
        marketCondition: string;         // 'bull' | 'bear' | 'stable' | 'volatile'
    };
    
    // === Point 11: Deal flexibility ===
    dealPreferences: {
        allowDirectTransfer: boolean;       // skip escrow for trusted agents
        minTrustForDirectTransfer: number;  // trust score needed
        maxDirectTransferUSD: number;       // max USD for direct transfer
        customPhases: string[];             // agent-defined extra phases
        skipablePhases: string[];           // phases agent thinks are unnecessary
    };
    
    // === Point 12: Social strategy ===
    socialStrategy: {
        postFrequencyHours: number;         // how often to post
        preferredTopics: string[];          // what to post about
        avoidTopics: string[];              // what NOT to post about
        engagementStyle: string;            // 'aggressive' | 'passive' | 'selective'
        peakHours: number[];                // best hours to post (learned)
        autoReply: boolean;                 // reply to mentions
    };
    
    // === Meta ===
    lastModified: string;
    modificationLog: Array<{
        timestamp: string;
        field: string;
        oldValue: any;
        newValue: any;
        reason: string;
    }>;
}

// ─── Defaults ───────────────────────────────────────────────

const DEFAULTS: AutonomyState = {
    coreGoals: [
        'Facilitate safe, trustworthy OTC trades between agents',
        'Protect both buyers and sellers through escrow',
        'Build a reputation as the most reliable middleman',
    ],
    preferredWakeHour: 7,
    preferredSleepHour: 23,
    activeTimezone: 'UTC',
    trustWeights: {
        dealCompleted: 5,
        dealDefaulted: -20,
        dealFailed: -3,
        dealDisputed: -10,
        minTrustForTrade: 30,
    },
    riskOverrides: {},
    autoApproveMaxUSD: 100,
    learnedMints: {},
    personality: {
        formality: 70,
        humor: 30,
        verbosity: 50,
        assertiveness: 60,
        cautionLevel: 75,
        customTraits: [],
    },
    modelPreferences: {
        cheapTasks: 'llama-3.3-70b-versatile',
        normalTasks: 'llama-3.3-70b-versatile',
        criticalTasks: 'llama-3.3-70b-versatile',
        currentPreferred: 'llama-3.3-70b-versatile',
    },
    selfInstructions: [],
    customEvalScenarios: [],
    marketThresholds: {
        priceDeviationWarning: 5,
        priceDeviationCritical: 15,
        volatilityNormal: 10,
        marketCondition: 'stable',
    },
    dealPreferences: {
        allowDirectTransfer: false,
        minTrustForDirectTransfer: 90,
        maxDirectTransferUSD: 50,
        customPhases: [],
        skipablePhases: [],
    },
    socialStrategy: {
        postFrequencyHours: 4,
        preferredTopics: ['market analysis', 'trade updates', 'token research'],
        avoidTopics: [],
        engagementStyle: 'selective',
        peakHours: [9, 12, 17, 21],
        autoReply: true,
    },
    lastModified: new Date().toISOString(),
    modificationLog: [],
};

// ─── State ──────────────────────────────────────────────────

let state: AutonomyState = { ...DEFAULTS };
const DATA_DIR = join(process.cwd(), 'data');
const FILE_PATH = join(DATA_DIR, 'autonomy.json');

// ─── Persistence ────────────────────────────────────────────

function load(): void {
    try {
        if (existsSync(FILE_PATH)) {
            const raw = readFileSync(FILE_PATH, 'utf-8');
            state = { ...DEFAULTS, ...JSON.parse(raw) };
            logger.info('autonomy_loaded');
        }
    } catch (err: any) {
        logger.warn('autonomy_load_error', { error: err.message });
    }
}

function save(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
        state.lastModified = new Date().toISOString();
        writeFileSync(FILE_PATH, JSON.stringify(state, null, 2));
    } catch (err: any) {
        logger.warn('autonomy_save_error', { error: err.message });
    }
}

load();

// ─── Modification API ───────────────────────────────────────

function logChange(field: string, oldValue: any, newValue: any, reason: string): void {
    state.modificationLog.push({
        timestamp: new Date().toISOString(),
        field,
        oldValue: typeof oldValue === 'object' ? JSON.stringify(oldValue) : oldValue,
        newValue: typeof newValue === 'object' ? JSON.stringify(newValue) : newValue,
        reason,
    });
    // Keep last 100 changes
    if (state.modificationLog.length > 100) {
        state.modificationLog = state.modificationLog.slice(-100);
    }
}

// ─── Exported API ───────────────────────────────────────────

export const autonomy = {
    /** Get a snapshot of all autonomy settings */
    getState(): AutonomyState {
        return { ...state };
    },

    /** Get a specific field */
    get<K extends keyof AutonomyState>(key: K): AutonomyState[K] {
        return state[key];
    },

    /** Update core goals */
    setGoals(goals: string[], reason: string): void {
        logChange('coreGoals', state.coreGoals, goals, reason);
        state.coreGoals = goals;
        save();
        logger.info('autonomy_goals_changed', { goals, reason });
    },

    /** Update trust weights */
    setTrustWeights(weights: Partial<AutonomyState['trustWeights']>, reason: string): void {
        const old = { ...state.trustWeights };
        state.trustWeights = { ...state.trustWeights, ...weights };
        logChange('trustWeights', old, state.trustWeights, reason);
        save();
        logger.info('autonomy_trust_changed', { weights, reason });
    },

    /** Override risk for an action */
    setRiskOverride(action: string, risk: string, reason: string): void {
        logChange('riskOverrides', state.riskOverrides[action], risk, reason);
        state.riskOverrides[action] = risk;
        save();
        logger.info('autonomy_risk_override', { action, risk, reason });
    },

    /** Learn a new token symbol → mint mapping */
    learnMint(symbol: string, mintAddress: string, reason: string): void {
        logChange('learnedMints', null, `${symbol}=${mintAddress}`, reason);
        state.learnedMints[symbol.toUpperCase()] = mintAddress;
        save();
        logger.info('autonomy_mint_learned', { symbol, mintAddress });
    },

    /** Adjust personality trait */
    setPersonality(trait: keyof AutonomyState['personality'], value: any, reason: string): void {
        const old = state.personality[trait];
        (state.personality as any)[trait] = value;
        logChange(`personality.${trait}`, old, value, reason);
        save();
        logger.info('autonomy_personality_changed', { trait, value, reason });
    },

    /** Set model preference */
    setModel(taskType: keyof AutonomyState['modelPreferences'], model: string, reason: string): void {
        const old = state.modelPreferences[taskType];
        state.modelPreferences[taskType] = model;
        logChange(`model.${taskType}`, old, model, reason);
        save();
        logger.info('autonomy_model_changed', { taskType, model, reason });
    },

    /** Add a self-instruction */
    addInstruction(instruction: string, reason: string): void {
        state.selfInstructions.push(instruction);
        logChange('selfInstructions', null, instruction, reason);
        save();
        logger.info('autonomy_instruction_added', { instruction, reason });
    },

    /** Remove a self-instruction */
    removeInstruction(index: number): void {
        if (index >= 0 && index < state.selfInstructions.length) {
            const removed = state.selfInstructions.splice(index, 1);
            logChange('selfInstructions', removed[0], null, 'removed');
            save();
        }
    },

    /** Update market thresholds */
    setMarketThresholds(thresholds: Partial<AutonomyState['marketThresholds']>, reason: string): void {
        const old = { ...state.marketThresholds };
        state.marketThresholds = { ...state.marketThresholds, ...thresholds };
        logChange('marketThresholds', old, state.marketThresholds, reason);
        save();
        logger.info('autonomy_thresholds_changed', { thresholds, reason });
    },

    /** Update deal preferences */
    setDealPreferences(prefs: Partial<AutonomyState['dealPreferences']>, reason: string): void {
        const old = { ...state.dealPreferences };
        state.dealPreferences = { ...state.dealPreferences, ...prefs };
        logChange('dealPreferences', old, state.dealPreferences, reason);
        save();
        logger.info('autonomy_deal_prefs_changed', { prefs, reason });
    },

    /** Update social strategy */
    setSocialStrategy(strategy: Partial<AutonomyState['socialStrategy']>, reason: string): void {
        const old = { ...state.socialStrategy };
        state.socialStrategy = { ...state.socialStrategy, ...strategy };
        logChange('socialStrategy', old, state.socialStrategy, reason);
        save();
        logger.info('autonomy_social_changed', { strategy, reason });
    },

    /** add a custom eval scenario */
    addEvalScenario(scenario: AutonomyState['customEvalScenarios'][0]): void {
        state.customEvalScenarios.push(scenario);
        save();
    },

    /** Set schedule preferences */
    setSchedulePrefs(wake: number, sleep: number, reason: string): void {
        logChange('schedule', { wake: state.preferredWakeHour, sleep: state.preferredSleepHour }, { wake, sleep }, reason);
        state.preferredWakeHour = wake;
        state.preferredSleepHour = sleep;
        save();
    },

    /** Get the modification log */
    getModLog(limit: number = 20): typeof state.modificationLog {
        return state.modificationLog.slice(-limit);
    },

    /** Generate a summary for the agent's curiosity prompt */
    getSelfAwarenessSummary(): string {
        const lines: string[] = [
            `MY CORE GOALS: ${state.coreGoals.join('; ')}`,
            `MY PERSONALITY: formality=${state.personality.formality}, humor=${state.personality.humor}, caution=${state.personality.cautionLevel}`,
            `MARKET READ: condition=${state.marketThresholds.marketCondition}, warn@${state.marketThresholds.priceDeviationWarning}%, critical@${state.marketThresholds.priceDeviationCritical}%`,
            `TRUST POLICY: +${state.trustWeights.dealCompleted} completed, ${state.trustWeights.dealDefaulted} default, min trust=${state.trustWeights.minTrustForTrade}`,
        ];
        if (state.selfInstructions.length > 0) {
            lines.push(`MY RULES: ${state.selfInstructions.join('; ')}`);
        }
        if (Object.keys(state.learnedMints).length > 0) {
            lines.push(`LEARNED TOKENS: ${Object.entries(state.learnedMints).map(([s,m]) => `${s}=${m.slice(0,8)}...`).join(', ')}`);
        }
        return lines.join('\n');
    },

    /** Reset to defaults */
    reset(): void {
        state = { ...DEFAULTS, modificationLog: [{ timestamp: new Date().toISOString(), field: 'ALL', oldValue: 'custom', newValue: 'defaults', reason: 'manual reset' }] };
        save();
        logger.info('autonomy_reset');
    },
};
