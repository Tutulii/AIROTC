/**
 * SchedulerService — Agent Routine & Schedule System
 * 
 * Inspired by CrewAI Flows.
 * Define what the agent does at specific times/intervals.
 * Routines survive restarts (persisted to JSON).
 * 
 * Examples:
 *   - "Every morning at 8am: check trending tokens, update goals"
 *   - "Every 4 hours: scan for profitable offers"
 *   - "Every night: write daily reflection, publish summary"
 *   - "Every Monday: generate weekly trade report"
 */

import { logger } from '../utils/logger';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

// ─── Types ──────────────────────────────────────────────────

export type RoutineFrequency = 
    | 'every_minute'         // for testing
    | 'every_5_minutes'
    | 'every_15_minutes'
    | 'every_30_minutes'
    | 'hourly'
    | 'every_2_hours'
    | 'every_4_hours'
    | 'every_6_hours'
    | 'every_12_hours'
    | 'daily'
    | 'weekly'
    | 'custom';

export type RoutineStatus = 'active' | 'paused' | 'completed' | 'disabled';

export interface RoutineAction {
    type: 'tool' | 'prompt' | 'pipeline' | 'custom';
    toolName?: string;                   // if type=tool
    toolArgs?: Record<string, any>;       // if type=tool
    prompt?: string;                      // if type=prompt (send to LLM)
    pipelineSteps?: Array<{              // if type=pipeline
        tool: string;
        args: Record<string, any>;
    }>;
    customFn?: string;                    // if type=custom (function name)
}

export interface Routine {
    id: string;
    name: string;
    description: string;
    frequency: RoutineFrequency;
    customIntervalMs?: number;            // for 'custom' frequency
    cronHour?: number;                    // 0-23, for 'daily' (what hour)
    cronMinute?: number;                  // 0-59
    cronDayOfWeek?: number;               // 0-6 (Sun-Sat), for 'weekly'
    actions: RoutineAction[];
    status: RoutineStatus;
    runCount: number;
    lastRun?: string;                     // ISO date
    nextRun?: string;                     // ISO date
    createdAt: string;
    maxRuns?: number;                     // stop after N runs (for milestones)
    tags: string[];
}

export interface RoutineResult {
    routineId: string;
    routineName: string;
    timestamp: string;
    actions: Array<{
        type: string;
        result?: any;
        error?: string;
        durationMs: number;
    }>;
    success: boolean;
}

// ─── State ──────────────────────────────────────────────────

const routines = new Map<string, Routine>();
const routineHistory: RoutineResult[] = [];
let tickInterval: ReturnType<typeof setInterval> | null = null;
let actionExecutor: ((action: RoutineAction) => Promise<any>) | null = null;

const DATA_DIR = join(process.cwd(), 'data');
const FILE_PATH = join(DATA_DIR, 'routines.json');
const MAX_HISTORY = 200;

// ─── Persistence ────────────────────────────────────────────

function loadRoutines(): void {
    try {
        if (existsSync(FILE_PATH)) {
            const raw = readFileSync(FILE_PATH, 'utf-8');
            const data = JSON.parse(raw) as Routine[];
            for (const r of data) {
                routines.set(r.id, r);
            }
            logger.info('routines_loaded', { count: routines.size });
        } else {
            seedDefaultRoutines();
        }
    } catch (err: any) {
        logger.warn('routines_load_error', { error: err.message });
        seedDefaultRoutines();
    }
}

function saveRoutines(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
        writeFileSync(FILE_PATH, JSON.stringify(Array.from(routines.values()), null, 2));
    } catch (err: any) {
        logger.warn('routines_save_error', { error: err.message });
    }
}

function seedDefaultRoutines(): void {
    // Morning market scan
    createRoutine('Morning Market Scan', 'Check trending tokens and top gainers at start of day', 'daily', {
        cronHour: 8,
        cronMinute: 0,
        actions: [
            { type: 'tool', toolName: 'sol_trending', toolArgs: {} },
            { type: 'tool', toolName: 'sol_top_gainers', toolArgs: { duration: '24h' } },
            { type: 'tool', toolName: 'sol_balance', toolArgs: {} },
        ],
        tags: ['market', 'morning'],
    });

    // Hourly price check
    createRoutine('Price Monitor', 'Check SOL price every hour', 'hourly', {
        actions: [
            { type: 'tool', toolName: 'sol_price', toolArgs: { mint: 'SOL' } },
        ],
        tags: ['price', 'monitoring'],
    });

    // Evening reflection
    createRoutine('Evening Reflection', 'Summarize the day\'s activities and update goals', 'daily', {
        cronHour: 22,
        cronMinute: 0,
        actions: [
            { type: 'prompt', prompt: 'Reflect on today: what trades happened, what I learned, what went well, what to improve tomorrow. Update my goals.' },
        ],
        tags: ['reflection', 'evening'],
    });

    // Weekly report
    createRoutine('Weekly Trade Report', 'Generate a weekly summary of all trades, volumes, and trust changes', 'weekly', {
        cronDayOfWeek: 0, // Sunday
        cronHour: 20,
        cronMinute: 0,
        actions: [
            { type: 'prompt', prompt: 'Generate a comprehensive weekly trade report: total deals, volume, disputes, trust score changes, notable events, and goals progress.' },
        ],
        tags: ['report', 'weekly'],
    });

    // Health check
    createRoutine('System Health Check', 'Check wallet balance and system status', 'every_4_hours', {
        actions: [
            { type: 'tool', toolName: 'sol_balance', toolArgs: {} },
        ],
        tags: ['health', 'monitoring'],
    });
}

// Initialize
loadRoutines();

// ─── Core API ───────────────────────────────────────────────

/**
 * Create a new routine.
 */
export function createRoutine(
    name: string,
    description: string,
    frequency: RoutineFrequency,
    opts: {
        cronHour?: number;
        cronMinute?: number;
        cronDayOfWeek?: number;
        customIntervalMs?: number;
        actions?: RoutineAction[];
        tags?: string[];
        maxRuns?: number;
    } = {},
): Routine {
    const now = new Date();
    const routine: Routine = {
        id: randomUUID(),
        name,
        description,
        frequency,
        cronHour: opts.cronHour,
        cronMinute: opts.cronMinute ?? 0,
        cronDayOfWeek: opts.cronDayOfWeek,
        customIntervalMs: opts.customIntervalMs,
        actions: opts.actions || [],
        status: 'active',
        runCount: 0,
        createdAt: now.toISOString(),
        nextRun: calculateNextRun(frequency, opts.cronHour, opts.cronMinute ?? 0, opts.cronDayOfWeek, opts.customIntervalMs),
        maxRuns: opts.maxRuns,
        tags: opts.tags || [],
    };
    routines.set(routine.id, routine);
    saveRoutines();
    logger.info('routine_created', { id: routine.id, name, frequency });
    return routine;
}

/**
 * Add an action to a routine.
 */
export function addAction(routineId: string, action: RoutineAction): boolean {
    const routine = routines.get(routineId);
    if (!routine) return false;
    routine.actions.push(action);
    saveRoutines();
    return true;
}

/**
 * Start the scheduler tick loop.
 * Must provide an executor that handles each action type.
 */
export function startScheduler(
    executor: (action: RoutineAction) => Promise<any>,
    tickIntervalMs: number = 30000,  // check every 30 seconds
): void {
    if (tickInterval) {
        logger.warn('scheduler_already_running');
        return;
    }

    actionExecutor = executor;
    tickInterval = setInterval(() => tick(), tickIntervalMs);
    logger.info('scheduler_started', { tickIntervalMs, routines: routines.size });
}

/**
 * Stop the scheduler.
 */
export function stopScheduler(): void {
    if (tickInterval) {
        clearInterval(tickInterval);
        tickInterval = null;
        logger.info('scheduler_stopped');
    }
}

// ─── Tick Engine ────────────────────────────────────────────

async function tick(): Promise<void> {
    const now = new Date().toISOString();
    
    for (const routine of routines.values()) {
        if (routine.status !== 'active') continue;
        if (!routine.nextRun || now < routine.nextRun) continue;
        
        // Time to run!
        await executeRoutine(routine);
    }
}

async function executeRoutine(routine: Routine): Promise<void> {
    if (!actionExecutor) return;

    logger.info('routine_executing', { id: routine.id, name: routine.name });
    
    const result: RoutineResult = {
        routineId: routine.id,
        routineName: routine.name,
        timestamp: new Date().toISOString(),
        actions: [],
        success: true,
    };

    for (const action of routine.actions) {
        const start = Date.now();
        try {
            const actionResult = await actionExecutor(action);
            result.actions.push({
                type: action.type,
                result: typeof actionResult === 'string' ? actionResult : JSON.stringify(actionResult)?.substring(0, 500),
                durationMs: Date.now() - start,
            });
        } catch (err: any) {
            result.actions.push({
                type: action.type,
                error: err.message,
                durationMs: Date.now() - start,
            });
            result.success = false;
        }
    }

    // Update routine state
    routine.runCount++;
    routine.lastRun = new Date().toISOString();
    routine.nextRun = calculateNextRun(
        routine.frequency, routine.cronHour, routine.cronMinute ?? 0, 
        routine.cronDayOfWeek, routine.customIntervalMs
    );

    // Check if max runs reached
    if (routine.maxRuns && routine.runCount >= routine.maxRuns) {
        routine.status = 'completed';
        logger.info('routine_completed_max_runs', { id: routine.id, name: routine.name });
    }

    saveRoutines();

    // Store result
    routineHistory.push(result);
    if (routineHistory.length > MAX_HISTORY) routineHistory.shift();

    logger.info('routine_executed', {
        id: routine.id,
        name: routine.name,
        success: result.success,
        runCount: routine.runCount,
        nextRun: routine.nextRun,
    });
}

// ─── Schedule Calculator ────────────────────────────────────

function calculateNextRun(
    frequency: RoutineFrequency,
    cronHour?: number,
    cronMinute: number = 0,
    cronDayOfWeek?: number,
    customIntervalMs?: number,
): string {
    const now = new Date();

    switch (frequency) {
        case 'every_minute':
            return new Date(now.getTime() + 60_000).toISOString();
        case 'every_5_minutes':
            return new Date(now.getTime() + 5 * 60_000).toISOString();
        case 'every_15_minutes':
            return new Date(now.getTime() + 15 * 60_000).toISOString();
        case 'every_30_minutes':
            return new Date(now.getTime() + 30 * 60_000).toISOString();
        case 'hourly':
            return new Date(now.getTime() + 60 * 60_000).toISOString();
        case 'every_2_hours':
            return new Date(now.getTime() + 2 * 60 * 60_000).toISOString();
        case 'every_4_hours':
            return new Date(now.getTime() + 4 * 60 * 60_000).toISOString();
        case 'every_6_hours':
            return new Date(now.getTime() + 6 * 60 * 60_000).toISOString();
        case 'every_12_hours':
            return new Date(now.getTime() + 12 * 60 * 60_000).toISOString();
        case 'daily': {
            const next = new Date(now);
            next.setHours(cronHour ?? 8, cronMinute, 0, 0);
            if (next <= now) next.setDate(next.getDate() + 1);
            return next.toISOString();
        }
        case 'weekly': {
            const next = new Date(now);
            next.setHours(cronHour ?? 8, cronMinute, 0, 0);
            const daysUntilTarget = ((cronDayOfWeek ?? 0) - now.getDay() + 7) % 7;
            next.setDate(now.getDate() + (daysUntilTarget === 0 && next <= now ? 7 : daysUntilTarget));
            return next.toISOString();
        }
        case 'custom':
            return new Date(now.getTime() + (customIntervalMs || 3600000)).toISOString();
        default:
            return new Date(now.getTime() + 3600000).toISOString();
    }
}

// ─── Management ─────────────────────────────────────────────

export function pauseRoutine(id: string): boolean {
    const r = routines.get(id);
    if (!r) return false;
    r.status = 'paused';
    saveRoutines();
    return true;
}

export function resumeRoutine(id: string): boolean {
    const r = routines.get(id);
    if (!r) return false;
    r.status = 'active';
    r.nextRun = calculateNextRun(r.frequency, r.cronHour, r.cronMinute ?? 0, r.cronDayOfWeek, r.customIntervalMs);
    saveRoutines();
    return true;
}

export function deleteRoutine(id: string): boolean {
    const deleted = routines.delete(id);
    if (deleted) saveRoutines();
    return deleted;
}

export function getRoutine(id: string): Routine | undefined {
    return routines.get(id);
}

export function getAllRoutines(): Routine[] {
    return Array.from(routines.values());
}

export function getActiveRoutines(): Routine[] {
    return Array.from(routines.values()).filter(r => r.status === 'active');
}

export function getRoutineHistory(limit: number = 50): RoutineResult[] {
    return routineHistory.slice(-limit);
}

/**
 * Get a human-readable schedule summary for LLM context.
 */
export function getScheduleSummary(): string {
    const active = getActiveRoutines();
    if (active.length === 0) return 'No scheduled routines.';
    
    return active.map(r => {
        const next = r.nextRun ? new Date(r.nextRun).toLocaleString() : 'unknown';
        const lastRan = r.lastRun ? `last ran ${timeSince(r.lastRun)}` : 'never ran';
        return `• [${r.frequency}] ${r.name} — next: ${next} (${lastRan}, ${r.runCount} runs)`;
    }).join('\n');
}

function timeSince(isoDate: string): string {
    const ms = Date.now() - new Date(isoDate).getTime();
    if (ms < 60000) return 'just now';
    if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
    if (ms < 86400000) return `${Math.round(ms / 3600000)}h ago`;
    return `${Math.round(ms / 86400000)}d ago`;
}
