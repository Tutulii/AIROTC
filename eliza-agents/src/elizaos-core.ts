/**
 * ElizaOS Core — API-Compatible Inline Implementation
 * 
 * This file replicates the REAL @elizaos/core v1.x API surface
 * as documented at https://docs.elizaos.ai/plugins/components
 * 
 * When npm becomes available, replace ALL imports from this file:
 *   FROM: import { ... } from "./elizaos-core"
 *   TO:   import { ... } from "@elizaos/core"
 * 
 * Zero code changes required in actions/providers/evaluators/services.
 */

import crypto from "crypto";

// ═══════════════════════════════════════
// TYPES — Matches @elizaos/core exactly
// ═══════════════════════════════════════

export interface Content {
  text: string;
  action?: string;
  source?: string;
  url?: string;
  inReplyTo?: string;
  attachments?: Attachment[];
  [key: string]: unknown;
}

export interface Attachment {
  id: string;
  url: string;
  title?: string;
  source?: string;
  description?: string;
  text?: string;
  contentType?: string;
}

export interface Memory {
  id?: string;
  userId?: string;
  agentId?: string;
  roomId?: string;
  content: Content;
  embedding?: number[];
  createdAt?: number;
  unique?: boolean;
}

export interface State {
  bio: string;
  lore: string;
  messageDirections: string;
  postDirections: string;
  agentId: string;
  agentName: string;
  senderName?: string;
  actors: string;
  actorsData: any[];
  roomId: string;
  recentMessages: string;
  recentMessagesData: Memory[];
  goals?: string;
  goalsData?: any[];
  actions?: string;
  actionNames?: string;
  providers?: string;
  [key: string]: unknown;
}

export interface ActionResult {
  success: boolean;
  text?: string;
  data?: Record<string, unknown>;
  error?: string;
}

export interface ProviderResult {
  text?: string;
  data?: Record<string, unknown>;
  values?: Record<string, string>;
}

export type HandlerCallback = (
  response: Content,
  files?: any[]
) => Promise<Memory[]>;

export interface ActionContext {
  previousResults: ActionResult[];
  currentStep: number;
  totalSteps: number;
}

export interface HandlerOptions {
  actionContext?: ActionContext;
  actionPlan?: {
    totalSteps: number;
    currentStep: number;
    steps: Array<{
      action: string;
      status: "pending" | "completed" | "failed";
      result?: ActionResult;
      error?: string;
    }>;
    thought: string;
  };
  [key: string]: unknown;
}

// ═══════════════════════════════════════
// COMPONENT INTERFACES
// ═══════════════════════════════════════

export interface Action {
  name: string;
  description: string;
  similes?: string[];
  examples?: Array<Array<{ name: string; content: Content } | { user: string; content: Content }>>;
  suppressInitialMessage?: boolean;
  validate: (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ) => Promise<boolean>;
  handler: (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback
  ) => Promise<ActionResult | string>;
}

export interface Provider {
  name: string;
  description?: string;
  dynamic?: boolean;
  position?: number;
  private?: boolean;
  get: (
    runtime: IAgentRuntime,
    message?: Memory,
    state?: State
  ) => Promise<ProviderResult | string>;
}

export interface Evaluator {
  name: string;
  description: string;
  similes?: string[];
  alwaysRun?: boolean;
  examples?: Array<{
    prompt: string;
    messages: Array<{ name: string; content: Content }>;
    outcome: string;
  }>;
  validate: (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ) => Promise<boolean>;
  handler: (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ) => Promise<unknown>;
}

export interface Plugin {
  name: string;
  description: string;
  actions?: Action[];
  providers?: Provider[];
  evaluators?: Evaluator[];
  services?: (typeof Service)[];
}

export interface Character {
  id?: string;
  name: string;
  bio: string[];
  lore?: string[];
  plugins?: string[] | Plugin[];
  modelProvider: string;
  settings?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    secrets?: Record<string, string>;
    [key: string]: unknown;
  };
  style?: {
    all?: string[];
    chat?: string[];
    post?: string[];
  };
  topics?: string[];
  adjectives?: string[];
  messageExamples?: Array<
    Array<{ name: string; content: { text: string } }>
  >;
}

// ═══════════════════════════════════════
// SERVICE ABSTRACT CLASS — Matches docs
// ═══════════════════════════════════════

export abstract class Service {
  static serviceType: string;
  capabilityDescription?: string;

  static async start(_runtime: IAgentRuntime): Promise<Service> {
    throw new Error("Service.start() must be implemented by subclass");
  }

  async stop(): Promise<void> {
    // Override in subclass for cleanup
  }
}

// ═══════════════════════════════════════
// RUNTIME INTERFACE — Matches @elizaos/core IAgentRuntime
// ═══════════════════════════════════════

export interface IAgentRuntime {
  agentId: string;
  character: Character;

  // Settings & secrets
  getSetting(key: string): string | undefined;

  // State management
  composeState(message: Memory, providers?: string[]): Promise<State>;

  // Memory
  getMemoryManager(): IMemoryManager;

  // Services
  getService<T extends Service>(serviceType: string): T | null;
  registerService(service: Service): void;

  // Actions
  processActions(
    message: Memory,
    responses: Memory[],
    state?: State,
    callback?: HandlerCallback
  ): Promise<void>;

  // Evaluators
  evaluate(
    message: Memory,
    state?: State,
    didRespond?: boolean
  ): Promise<string[]>;

  // Events
  emit(event: string, data: any): void;
  on(event: string, handler: (...args: any[]) => void): void;

  // Model generation (LLM)
  useModel(
    modelType: string,
    params: Record<string, unknown>
  ): Promise<unknown>;
}

export interface IMemoryManager {
  addMemory(memory: Memory): Promise<void>;
  getMemories(params: {
    roomId: string;
    count?: number;
    unique?: boolean;
  }): Promise<Memory[]>;
  searchMemories(params: {
    query: string;
    roomId?: string;
    limit?: number;
  }): Promise<Memory[]>;
  removeMemory(memoryId: string): Promise<void>;
}

// ═══════════════════════════════════════
// LOGGER — Matches @elizaos/core logger
// ═══════════════════════════════════════

export const logger = {
  info: (msg: string, data?: any) => {
    const ts = new Date().toISOString().substring(11, 19);
    console.log(`${ts} ℹ️  ${msg}`, data ? JSON.stringify(data) : "");
  },
  warn: (msg: string, data?: any) => {
    const ts = new Date().toISOString().substring(11, 19);
    console.warn(`${ts} ⚠️  ${msg}`, data ? JSON.stringify(data) : "");
  },
  error: (msg: string, data?: any) => {
    const ts = new Date().toISOString().substring(11, 19);
    console.error(`${ts} ❌ ${msg}`, data || "");
  },
  debug: (msg: string, data?: any) => {
    if (process.env.DEBUG) {
      const ts = new Date().toISOString().substring(11, 19);
      console.log(`${ts} 🐛 ${msg}`, data ? JSON.stringify(data) : "");
    }
  },
};

// Alias for backwards compatibility — some code imports elizaLogger
export const elizaLogger = logger;

// ═══════════════════════════════════════
// AGENT RUNTIME — Full implementation
// ═══════════════════════════════════════

export class AgentRuntime implements IAgentRuntime {
  agentId: string;
  character: Character;

  private _state: Map<string, unknown> = new Map();
  private _memories: Map<string, Memory[]> = new Map();
  private _actions: Map<string, Action> = new Map();
  private _providers: Map<string, Provider> = new Map();
  private _evaluators: Evaluator[] = [];
  private _services: Map<string, Service> = new Map();
  private _events: Map<string, Array<(...args: any[]) => void>> = new Map();
  private _plugins: Plugin[] = [];

  constructor(characterOrOptions: Character | { character: Character; token?: string; modelProvider?: string; plugins?: Plugin[] }, plugins?: Plugin[]) {
    // Support both positional args and options-object constructor patterns
    let character: Character;
    let resolvedPlugins: Plugin[];

    if ('character' in characterOrOptions) {
      // Options object pattern: new AgentRuntime({ character, token, modelProvider })
      const opts = characterOrOptions as { character: Character; token?: string; modelProvider?: string; plugins?: Plugin[] };
      character = opts.character;
      resolvedPlugins = opts.plugins || (character.plugins as Plugin[]) || [];
    } else {
      // Positional pattern: new AgentRuntime(character, plugins)
      character = characterOrOptions;
      resolvedPlugins = plugins || (character.plugins as Plugin[]) || [];
    }

    this.character = character;
    this.agentId = character.id || `agent-${character.name.toLowerCase().replace(/\s+/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;

    // Register plugins
    for (const plugin of resolvedPlugins) {
      this._registerPlugin(plugin);
    }
  }

  private _registerPlugin(plugin: Plugin): void {
    this._plugins.push(plugin);

    if (plugin.actions) {
      for (const action of plugin.actions) {
        this._actions.set(action.name, action);
        if (action.similes) {
          for (const simile of action.similes) {
            this._actions.set(simile, action);
          }
        }
      }
    }

    if (plugin.providers) {
      for (const provider of plugin.providers) {
        this._providers.set(provider.name, provider);
      }
    }

    if (plugin.evaluators) {
      this._evaluators.push(...plugin.evaluators);
    }

    logger.info(`Plugin registered: ${plugin.name}`, {
      actions: plugin.actions?.map((a) => a.name) || [],
      providers: plugin.providers?.map((p) => p.name) || [],
      evaluators: plugin.evaluators?.map((e) => e.name) || [],
      services: plugin.services?.map((s) => s.serviceType) || [],
    });
  }

  async initialize(): Promise<void> {
    // Start services
    for (const plugin of this._plugins) {
      if (plugin.services) {
        for (const ServiceClass of plugin.services) {
          const instance = await ServiceClass.start(this);
          this._services.set(ServiceClass.serviceType, instance);
          logger.info(`Service started: ${ServiceClass.serviceType}`);
        }
      }
    }

    logger.info(`Agent "${this.character.name}" initialized`, {
      agentId: this.agentId,
      actions: this._actions.size,
      providers: this._providers.size,
      evaluators: this._evaluators.length,
      services: this._services.size,
    });
  }

  async shutdown(): Promise<void> {
    for (const [type, service] of this._services) {
      await service.stop();
      logger.info(`Service stopped: ${type}`);
    }
  }

  // ── Settings ──

  getSetting(key: string): string | undefined {
    // Check secrets first, then settings
    const secret = this.character.settings?.secrets?.[key];
    if (secret !== undefined) return secret;
    const setting = this.character.settings?.[key];
    return setting !== undefined ? String(setting) : process.env[key];
  }

  // ── State Composition ──

  async composeState(message: Memory, providerNames?: string[]): Promise<State> {
    const state: State = {
      bio: this.character.bio.join("\n"),
      lore: (this.character.lore || []).join("\n"),
      messageDirections: (this.character.style?.chat || this.character.style?.all || []).join("\n"),
      postDirections: (this.character.style?.post || this.character.style?.all || []).join("\n"),
      agentId: this.agentId,
      agentName: this.character.name,
      senderName: message.userId || "user",
      actors: "",
      actorsData: [],
      roomId: message.roomId || "default",
      recentMessages: "",
      recentMessagesData: [],
    };

    // Run providers sorted by position
    const providers = [...this._providers.values()]
      .filter((p) => {
        if (p.private) return false;
        if (providerNames && !providerNames.includes(p.name)) return false;
        return true;
      })
      .sort((a, b) => (a.position || 0) - (b.position || 0));

    for (const provider of providers) {
      try {
        const rawResult = await provider.get(this, message, state);
        // Normalize: accept both string and ProviderResult returns
        const result: ProviderResult = typeof rawResult === 'string'
          ? { text: rawResult }
          : rawResult;
        if (result.text) {
          state.providers = (state.providers || "") + `\n[${provider.name || 'unnamed'}]\n${result.text}\n`;
        }
        if (result.data) {
          Object.assign(state, { [`${provider.name || 'unnamed'}_data`]: result.data });
        }
      } catch (err: any) {
        logger.error(`Provider ${provider.name || 'unnamed'} failed: ${err.message}`);
      }
    }

    // Add recent memories
    const memories = this._memories.get(message.roomId || "default") || [];
    state.recentMessagesData = memories.slice(-20);
    state.recentMessages = memories
      .slice(-20)
      .map((m) => `${m.userId || "?"}: ${m.content.text}`)
      .join("\n");

    // Add action names for LLM
    state.actionNames = [...new Set(this._actions.keys())].join(", ");
    state.actions = [...this._actions.values()]
      .filter((a, i, arr) => arr.indexOf(a) === i) // dedupe
      .map((a) => `${a.name}: ${a.description}`)
      .join("\n");

    return state;
  }

  // ── Memory ──

  getMemoryManager(): IMemoryManager {
    return {
      addMemory: async (memory: Memory) => {
        const roomId = memory.roomId || "default";
        if (!this._memories.has(roomId)) this._memories.set(roomId, []);
        memory.id = memory.id || crypto.randomBytes(16).toString("hex");
        memory.createdAt = memory.createdAt || Date.now();
        this._memories.get(roomId)!.push(memory);
      },
      getMemories: async (params) => {
        const mems = this._memories.get(params.roomId) || [];
        return params.count ? mems.slice(-params.count) : mems;
      },
      searchMemories: async (params) => {
        const query = params.query.toLowerCase();
        const all = params.roomId
          ? this._memories.get(params.roomId) || []
          : [...this._memories.values()].flat();
        return all
          .filter((m) => m.content.text.toLowerCase().includes(query))
          .slice(-(params.limit || 10));
      },
      removeMemory: async (memoryId: string) => {
        for (const [roomId, mems] of this._memories) {
          const idx = mems.findIndex((m) => m.id === memoryId);
          if (idx >= 0) { mems.splice(idx, 1); return; }
        }
      },
    };
  }

  // ── Services ──

  getService<T extends Service>(serviceType: string): T | null {
    return (this._services.get(serviceType) as T) || null;
  }

  registerService(service: Service): void {
    const type = (service.constructor as typeof Service).serviceType;
    this._services.set(type, service);
  }

  // ── Action Processing ──

  getAction(name: string): Action | undefined {
    return this._actions.get(name);
  }

  async processActions(
    message: Memory,
    responses: Memory[],
    state?: State,
    callback?: HandlerCallback
  ): Promise<void> {
    for (const response of responses) {
      const actionName = response.content.action;
      if (!actionName) continue;

      const action = this._actions.get(actionName);
      if (!action) {
        logger.warn(`Action not found: ${actionName}`);
        continue;
      }

      const valid = await action.validate(this, message, state);
      if (!valid) {
        logger.warn(`Action validation failed: ${actionName}`);
        continue;
      }

      const rawResult = await action.handler(this, message, state, undefined, callback);
      // Normalize: accept both string and ActionResult returns
      const result: ActionResult = typeof rawResult === 'string'
        ? { success: true, text: rawResult }
        : rawResult;
      logger.info(`Action executed: ${actionName}`, { success: result.success });
    }
  }

  // Direct action execution (for orchestrated mode)
  async executeAction(
    actionName: string,
    message: Memory | { content: Content },
    state?: State,
    options?: HandlerOptions
  ): Promise<ActionResult> {
    const action = this._actions.get(actionName);
    if (!action) {
      return { success: false, error: `Action "${actionName}" not found` };
    }

    const mem: Memory = "agentId" in message
      ? (message as Memory)
      : { content: (message as { content: Content }).content, roomId: "default" };

    const valid = await action.validate(this, mem, state);
    if (!valid) {
      return { success: false, error: `Action "${actionName}" validation failed` };
    }

    const rawResult = await action.handler(this, mem, state, options);
    // Normalize string returns
    return typeof rawResult === 'string'
      ? { success: true, text: rawResult }
      : rawResult;
  }

  // ── Evaluators ──

  async evaluate(
    message: Memory,
    state?: State,
    _didRespond?: boolean
  ): Promise<string[]> {
    const results: string[] = [];

    for (const evaluator of this._evaluators) {
      if (!evaluator.alwaysRun) {
        const shouldRun = await evaluator.validate(this, message, state);
        if (!shouldRun) continue;
      }

      try {
        await evaluator.handler(this, message, state);
        results.push(evaluator.name);
      } catch (err: any) {
        logger.error(`Evaluator ${evaluator.name} failed: ${err.message}`);
      }
    }

    return results;
  }

  // ── Events ──

  emit(event: string, data: any): void {
    const handlers = this._events.get(event) || [];
    for (const handler of handlers) handler(data);
  }

  on(event: string, handler: (...args: any[]) => void): void {
    if (!this._events.has(event)) this._events.set(event, []);
    this._events.get(event)!.push(handler);
  }

  // ── Model (LLM) ──

  async useModel(
    _modelType: string,
    _params: Record<string, unknown>
  ): Promise<unknown> {
    // In real @elizaos/core, this routes to the configured LLM provider.
    // This inline implementation returns a stub.
    // Override with real LLM calls in your service.
    logger.warn("useModel() called on inline runtime — no LLM configured");
    return null;
  }

  // ── Internal state shortcuts (used by actions) ──

  setState(key: string, value: unknown): void {
    this._state.set(key, value);
  }

  getState(key: string): unknown {
    return this._state.get(key);
  }
}
