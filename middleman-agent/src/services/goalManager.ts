/**
 * GoalManager — Persistent Objectives & Progress Tracking
 * 
 * Inspired by CrewAI's goal/objective system.
 * Goals survive restarts and guide agent behavior.
 */

import { logger } from '../utils/logger';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

// ─── Types ──────────────────────────────────────────────────

export type GoalType = 'daily' | 'weekly' | 'ongoing' | 'milestone';
export type GoalStatus = 'active' | 'completed' | 'paused' | 'failed' | 'expired';

export interface Goal {
    id: string;
    description: string;
    type: GoalType;
    progress: number;              // 0-100
    status: GoalStatus;
    metrics: Record<string, number>;
    target?: number;               // target value for milestone goals
    current?: number;              // current value for milestone goals
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    expiresAt?: string;            // for daily/weekly goals
    notes: string[];
}

// ─── State ──────────────────────────────────────────────────

const goals = new Map<string, Goal>();
const DATA_DIR = join(process.cwd(), 'data');
const FILE_PATH = join(DATA_DIR, 'goals.json');

// ─── Persistence ────────────────────────────────────────────

function loadGoals(): void {
    try {
        if (existsSync(FILE_PATH)) {
            const raw = readFileSync(FILE_PATH, 'utf-8');
            const data = JSON.parse(raw) as Goal[];
            for (const g of data) {
                goals.set(g.id, g);
            }
            logger.info('goals_loaded', { count: goals.size });
        } else {
            // Seed default goals
            seedDefaultGoals();
        }
    } catch (err: any) {
        logger.warn('goals_load_error', { error: err.message });
        seedDefaultGoals();
    }
}

function saveGoals(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
        writeFileSync(FILE_PATH, JSON.stringify(Array.from(goals.values()), null, 2));
    } catch (err: any) {
        logger.warn('goals_save_error', { error: err.message });
    }
}

function seedDefaultGoals(): void {
    createGoal('Facilitate successful trades', 'ongoing', {
        metrics: { trades_completed: 0 },
    });
    createGoal('Maintain dispute rate below 5%', 'ongoing', {
        metrics: { disputes: 0, total_deals: 0 },
    });
    createGoal('Research 3 new tokens daily', 'daily', {
        target: 3,
        metrics: { tokens_researched: 0 },
    });
    createGoal('Keep treasury above 5 SOL', 'ongoing', {
        metrics: { current_balance: 0 },
    });
    createGoal('Build trust with 10 agents', 'milestone', {
        target: 10,
        metrics: { trusted_agents: 0 },
    });
}

// Initialize on import
loadGoals();

// ─── Core API ───────────────────────────────────────────────

/**
 * Create a new goal.
 */
export function createGoal(
    description: string,
    type: GoalType,
    opts: {
        target?: number;
        metrics?: Record<string, number>;
        expiresAt?: string;
    } = {},
): Goal {
    const now = new Date().toISOString();
    const goal: Goal = {
        id: randomUUID(),
        description,
        type,
        progress: 0,
        status: 'active',
        metrics: opts.metrics || {},
        target: opts.target,
        current: 0,
        createdAt: now,
        updatedAt: now,
        expiresAt: opts.expiresAt || (type === 'daily' ? getEndOfDay() : type === 'weekly' ? getEndOfWeek() : undefined),
        notes: [],
    };
    goals.set(goal.id, goal);
    saveGoals();
    logger.info('goal_created', { id: goal.id, description, type });
    return goal;
}

/**
 * Update goal progress.
 */
export function updateProgress(goalId: string, progress: number, note?: string): boolean {
    const goal = goals.get(goalId);
    if (!goal) return false;

    goal.progress = Math.min(100, Math.max(0, progress));
    goal.updatedAt = new Date().toISOString();
    if (note) goal.notes.push(`${new Date().toISOString().split('T')[0]}: ${note}`);

    if (goal.progress >= 100 && goal.status === 'active') {
        goal.status = 'completed';
        goal.completedAt = new Date().toISOString();
        logger.info('goal_completed', { id: goal.id, description: goal.description });
    }

    saveGoals();
    return true;
}

/**
 * Update a metric value within a goal.
 */
export function updateMetric(goalId: string, metricName: string, value: number): boolean {
    const goal = goals.get(goalId);
    if (!goal) return false;

    goal.metrics[metricName] = value;
    goal.updatedAt = new Date().toISOString();

    // Auto-calculate progress for milestone goals
    if (goal.target && goal.type === 'milestone') {
        goal.current = value;
        goal.progress = Math.min(100, Math.round((value / goal.target) * 100));
        if (goal.progress >= 100 && goal.status === 'active') {
            goal.status = 'completed';
            goal.completedAt = new Date().toISOString();
        }
    }

    saveGoals();
    return true;
}

/**
 * Increment a metric by a delta.
 */
export function incrementMetric(goalId: string, metricName: string, delta: number = 1): boolean {
    const goal = goals.get(goalId);
    if (!goal) return false;

    const current = goal.metrics[metricName] || 0;
    return updateMetric(goalId, metricName, current + delta);
}

/**
 * Pause/resume a goal.
 */
export function setGoalStatus(goalId: string, status: GoalStatus): boolean {
    const goal = goals.get(goalId);
    if (!goal) return false;
    goal.status = status;
    goal.updatedAt = new Date().toISOString();
    if (status === 'completed') goal.completedAt = new Date().toISOString();
    saveGoals();
    return true;
}

/**
 * Check and expire daily/weekly goals at their boundary.
 */
export function checkExpirations(): void {
    const now = new Date().toISOString();
    for (const goal of goals.values()) {
        if (goal.expiresAt && goal.status === 'active' && now > goal.expiresAt) {
            if (goal.progress >= 100) {
                goal.status = 'completed';
                goal.completedAt = now;
            } else {
                goal.status = 'expired';
            }
            goal.updatedAt = now;

            // Auto-recreate daily/weekly goals
            if (goal.type === 'daily' || goal.type === 'weekly') {
                createGoal(goal.description, goal.type, {
                    target: goal.target,
                    metrics: Object.fromEntries(Object.keys(goal.metrics).map(k => [k, 0])),
                });
            }
        }
    }
    saveGoals();
}

// ─── Query ──────────────────────────────────────────────────

export function getActiveGoals(): Goal[] {
    checkExpirations();
    return Array.from(goals.values()).filter(g => g.status === 'active');
}

export function getAllGoals(): Goal[] {
    return Array.from(goals.values());
}

export function getGoal(id: string): Goal | undefined {
    return goals.get(id);
}

/**
 * Generate a goals summary for LLM context in curiosity cycles.
 */
export function getGoalsSummary(): string {
    const active = getActiveGoals();
    if (active.length === 0) return 'No active goals.';
    
    return active.map(g => {
        const bar = `[${'█'.repeat(Math.round(g.progress / 10))}${'░'.repeat(10 - Math.round(g.progress / 10))}]`;
        return `• ${g.description} ${bar} ${g.progress}% (${g.type})`;
    }).join('\n');
}

// ─── Helpers ────────────────────────────────────────────────

function getEndOfDay(): string {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    return d.toISOString();
}

function getEndOfWeek(): string {
    const d = new Date();
    d.setDate(d.getDate() + (7 - d.getDay()));
    d.setHours(23, 59, 59, 999);
    return d.toISOString();
}
