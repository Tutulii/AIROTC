/**
 * TaskPipeline — Multi-step Workflow Orchestration
 * 
 * Inspired by CrewAI's task pipeline system.
 * Enables the agent to break complex work into ordered steps
 * with dependency tracking, parallel execution, and result chaining.
 */

import { logger } from '../utils/logger';

import { randomUUID } from 'crypto';

// ─── Types ──────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type PipelineMode = 'sequential' | 'parallel' | 'dependency';

export interface PipelineTask {
    id: string;
    name: string;
    description: string;
    assignee: string;                      // 'self', agent ID, or tool name
    type: 'tool' | 'llm' | 'delegate';    // how to execute
    toolName?: string;                     // if type=tool
    toolArgs?: Record<string, any>;        // if type=tool
    prompt?: string;                       // if type=llm
    dependencies?: string[];               // task IDs that must finish first
    status: TaskStatus;
    result?: any;
    error?: string;
    startedAt?: Date;
    completedAt?: Date;
    validator?: (result: any) => boolean;  // optional validation
    condition?: (prevResults: Map<string, any>) => boolean; // conditional exec
}

export interface Pipeline {
    id: string;
    name: string;
    description: string;
    tasks: PipelineTask[];
    mode: PipelineMode;
    status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
    results: Map<string, any>;
    createdAt: Date;
    startedAt?: Date;
    completedAt?: Date;
    onComplete?: (results: Map<string, any>) => void;
}

// ─── State ──────────────────────────────────────────────────

const pipelines = new Map<string, Pipeline>();
const pipelineHistory: Pipeline[] = [];
const MAX_HISTORY = 50;

// ─── Pipeline Builder ───────────────────────────────────────

export function createPipeline(
    name: string,
    description: string,
    mode: PipelineMode = 'sequential',
): Pipeline {
    const pipeline: Pipeline = {
        id: randomUUID(),
        name,
        description,
        tasks: [],
        mode,
        status: 'idle',
        results: new Map(),
        createdAt: new Date(),
    };
    pipelines.set(pipeline.id, pipeline);
    logger.info('pipeline_created', { id: pipeline.id, name, mode });
    return pipeline;
}

export function addTask(
    pipelineId: string,
    task: Omit<PipelineTask, 'id' | 'status'>,
): PipelineTask | null {
    const pipeline = pipelines.get(pipelineId);
    if (!pipeline) return null;
    
    const fullTask: PipelineTask = {
        ...task,
        id: randomUUID(),
        status: 'pending',
    };
    pipeline.tasks.push(fullTask);
    return fullTask;
}

// ─── Execution Engine ───────────────────────────────────────

/**
 * Execute a pipeline. Calls the provided executor for each task.
 * The executor maps to curiosityEngine's executeTool or LLM calls.
 */
export async function executePipeline(
    pipelineId: string,
    executor: (task: PipelineTask, prevResults: Map<string, any>) => Promise<any>,
): Promise<Map<string, any>> {
    const pipeline = pipelines.get(pipelineId);
    if (!pipeline) throw new Error(`Pipeline ${pipelineId} not found`);

    pipeline.status = 'running';
    pipeline.startedAt = new Date();

    logger.info('pipeline_started', { id: pipeline.id, name: pipeline.name });
    logger.info('pipeline_started', { id: pipeline.id, name: pipeline.name, taskCount: pipeline.tasks.length });

    try {
        switch (pipeline.mode) {
            case 'sequential':
                await executeSequential(pipeline, executor);
                break;
            case 'parallel':
                await executeParallel(pipeline, executor);
                break;
            case 'dependency':
                await executeDependency(pipeline, executor);
                break;
        }

        const allDone = pipeline.tasks.every(t => t.status === 'done' || t.status === 'skipped');
        pipeline.status = allDone ? 'completed' : 'failed';
    } catch (err: any) {
        pipeline.status = 'failed';
        logger.error('pipeline_failed', { id: pipeline.id, error: err.message });
    }

    pipeline.completedAt = new Date();
    
    logger.info('pipeline_completed', {
        id: pipeline.id,
        status: pipeline.status,
        results: Object.fromEntries(pipeline.results),
    });

    logger.info('pipeline_completed', {
        id: pipeline.id,
        status: pipeline.status,
        duration: pipeline.completedAt.getTime() - pipeline.startedAt!.getTime(),
    });

    // Archive
    archivePipeline(pipeline);

    if (pipeline.onComplete) {
        pipeline.onComplete(pipeline.results);
    }

    return pipeline.results;
}

async function executeSequential(
    pipeline: Pipeline,
    executor: (task: PipelineTask, prevResults: Map<string, any>) => Promise<any>,
): Promise<void> {
    for (const task of pipeline.tasks) {
        await executeTask(pipeline, task, executor);
        if (task.status === 'failed') break; // Stop on failure in sequential
    }
}

async function executeParallel(
    pipeline: Pipeline,
    executor: (task: PipelineTask, prevResults: Map<string, any>) => Promise<any>,
): Promise<void> {
    await Promise.allSettled(
        pipeline.tasks.map(task => executeTask(pipeline, task, executor))
    );
}

async function executeDependency(
    pipeline: Pipeline,
    executor: (task: PipelineTask, prevResults: Map<string, any>) => Promise<any>,
): Promise<void> {
    const completed = new Set<string>();
    const maxIterations = pipeline.tasks.length * 2; // Safety limit
    let iteration = 0;

    while (completed.size < pipeline.tasks.length && iteration < maxIterations) {
        iteration++;
        const readyTasks = pipeline.tasks.filter(t => {
            if (t.status !== 'pending') return false;
            if (!t.dependencies || t.dependencies.length === 0) return true;
            return t.dependencies.every(depId => completed.has(depId));
        });

        if (readyTasks.length === 0) {
            // Check if we're stuck (circular deps or all failed)
            const pending = pipeline.tasks.filter(t => t.status === 'pending');
            if (pending.length > 0) {
                logger.warn('pipeline_stuck', { pending: pending.map(t => t.name) });
                for (const t of pending) {
                    t.status = 'skipped';
                    t.error = 'Unresolvable dependency';
                }
            }
            break;
        }

        // Execute all ready tasks in parallel
        await Promise.allSettled(
            readyTasks.map(async (task) => {
                await executeTask(pipeline, task, executor);
                if (task.status === 'done' || task.status === 'failed') {
                    completed.add(task.id);
                }
            })
        );
    }
}

async function executeTask(
    pipeline: Pipeline,
    task: PipelineTask,
    executor: (task: PipelineTask, prevResults: Map<string, any>) => Promise<any>,
): Promise<void> {
    // Check condition
    if (task.condition && !task.condition(pipeline.results)) {
        task.status = 'skipped';
        logger.debug('task_skipped', { task: task.name, reason: 'condition_false' });
        return;
    }

    task.status = 'running';
    task.startedAt = new Date();
    
    logger.debug('task_started', { pipeline: pipeline.name, task: task.name });

    try {
        const result = await executor(task, pipeline.results);
        
        // Validate if validator provided
        if (task.validator && !task.validator(result)) {
            task.status = 'failed';
            task.error = 'Validation failed';
            logger.warn('task_validation_failed', { task: task.name });
            return;
        }

        task.result = result;
        task.status = 'done';
        pipeline.results.set(task.id, result);
        
        logger.debug('task_completed', { pipeline: pipeline.name, task: task.name });
    } catch (err: any) {
        task.status = 'failed';
        task.error = err.message;
        logger.error('task_failed', { task: task.name, error: err.message });
    }

    task.completedAt = new Date();
}

// ─── Management ─────────────────────────────────────────────

export function cancelPipeline(pipelineId: string): boolean {
    const pipeline = pipelines.get(pipelineId);
    if (!pipeline || pipeline.status !== 'running') return false;
    
    pipeline.status = 'cancelled';
    pipeline.completedAt = new Date();
    
    for (const task of pipeline.tasks) {
        if (task.status === 'pending' || task.status === 'running') {
            task.status = 'skipped';
        }
    }
    
    archivePipeline(pipeline);
    return true;
}

export function getPipeline(id: string): Pipeline | undefined {
    return pipelines.get(id) || pipelineHistory.find(p => p.id === id);
}

export function listActivePipelines(): Pipeline[] {
    return Array.from(pipelines.values()).filter(p => p.status === 'running' || p.status === 'idle');
}

export function getPipelineHistory(limit: number = 20): Pipeline[] {
    return pipelineHistory.slice(-limit);
}

function archivePipeline(pipeline: Pipeline): void {
    pipelines.delete(pipeline.id);
    pipelineHistory.push(pipeline);
    if (pipelineHistory.length > MAX_HISTORY) {
        pipelineHistory.shift();
    }
}

// ─── Convenience: Quick Pipeline Builder ────────────────────

/**
 * Create and execute a simple sequential tool pipeline.
 * Example: quickPipeline('check-token', [
 *   { name: 'price', tool: 'sol_price', args: { mint: 'SOL' } },
 *   { name: 'rug', tool: 'sol_rug_check', args: { mint: 'SOL' } },
 * ], executor);
 */
export async function quickPipeline(
    name: string,
    steps: Array<{ name: string; tool: string; args: Record<string, any> }>,
    executor: (task: PipelineTask, prev: Map<string, any>) => Promise<any>,
): Promise<Map<string, any>> {
    const pipeline = createPipeline(name, `Quick pipeline: ${name}`, 'sequential');
    for (const step of steps) {
        addTask(pipeline.id, {
            name: step.name,
            description: `Execute ${step.tool}`,
            assignee: 'self',
            type: 'tool',
            toolName: step.tool,
            toolArgs: step.args,
        });
    }
    return executePipeline(pipeline.id, executor);
}
