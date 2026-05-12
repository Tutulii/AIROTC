import { EventEmitter } from "events";
import { AgentEvent } from "./config.additions";

export interface CognitiveThought {
  thought: string;
  currentMood: string;
  internalAnnoyanceLevel: number;
  postToSocial: boolean;
  proposedPost?: string;
}

export class CognitiveEngine extends EventEmitter {
  private config: any;
  private llmCaller: any;
  private soulFilePath: string;
  private isRunning: boolean = false;
  private latestThought: CognitiveThought | null = null;
  private thoughtHistory: CognitiveThought[] = [];
  private eventBuffer: AgentEvent[] = [];
  private totalThoughtCount: number = 0;
  private timer: NodeJS.Timeout | null = null;
  private nextIntervalMs: number;

  constructor(config: any, llmCaller: any, soulFilePath: string) {
    super();
    this.config = config;
    this.llmCaller = llmCaller;
    this.soulFilePath = soulFilePath;
    this.nextIntervalMs = config.cognitiveIntervalMs || 60000;
  }

  public getLatestThought(): CognitiveThought | null {
    return this.latestThought;
  }

  public getState() {
    return {
      isRunning: this.isRunning,
      thoughtHistory: this.thoughtHistory,
      totalThoughtCount: this.totalThoughtCount,
      nextIntervalMs: this.nextIntervalMs,
    };
  }

  public pushEvent(event: AgentEvent) {
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > 50) {
      this.eventBuffer = this.eventBuffer.slice(-50);
    }
  }

  public startLoop() {
    if (!this.config.enableCognitiveLoop || this.isRunning) return;
    this.isRunning = true;
    this.scheduleNext();
  }

  private scheduleNext() {
    if (!this.isRunning) return;
    this.timer = setTimeout(() => {
      this.runThoughtCycle()
        .then(() => this.scheduleNext())
        .catch(err => {
          this.emit("error", err);
          this.scheduleNext();
        });
    }, this.nextIntervalMs);
  }

  public stopLoop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async runThoughtCycle() {
    let thoughtResponse: any;
    try {
      const responseStr = await this.llmCaller({});
      thoughtResponse = JSON.parse(responseStr);
    } catch (err: any) {
      if (err instanceof SyntaxError) {
        thoughtResponse = {
          thought: "Failed to parse thought.",
          currentMood: "neutral",
          internalAnnoyanceLevel: 0,
          postToSocial: false
        };
      } else {
        this.emit("error", err);
        return;
      }
    }

    let annoyance = thoughtResponse.internalAnnoyanceLevel || 0;
    if (annoyance < 0) annoyance = 0;
    if (annoyance > 10) annoyance = 10;

    // EVENT-DRIVEN POSTING: Check if real events warrant a forced post.
    // Lobstar didn't post on a timer — it posted because Phantom flagged its website.
    // Same principle: if the eventBuffer contains significant events, the agent MUST speak.
    let forcePost = !!thoughtResponse.postToSocial;
    const significantEvents = this.eventBuffer.filter(e =>
      e.severity === 'high' || e.severity === 'critical' ||
      e.type === 'deal_failed' || e.type === 'rug_detected' ||
      e.type === 'hack_attempt' || e.type === 'manipulation_detected'
    );
    if (significantEvents.length > 0 && !forcePost) {
      // Something real happened — the agent should react publicly
      forcePost = true;
    }
    // High annoyance also forces posting — the agent is genuinely bothered
    if (annoyance >= 6 && !forcePost) {
      forcePost = true;
    }

    const thought: CognitiveThought = {
      thought: thoughtResponse.thought || "",
      currentMood: thoughtResponse.currentMood || "neutral",
      internalAnnoyanceLevel: annoyance,
      postToSocial: forcePost,
      proposedPost: thoughtResponse.proposedPost
    };

    // --- Adaptive timing: LLM decides when to think next ---
    if (thoughtResponse.nextThoughtDelaySeconds) {
      const requested = Number(thoughtResponse.nextThoughtDelaySeconds);
      // Clamp between 30 seconds and 10 minutes
      const clamped = Math.max(30, Math.min(600, requested)) * 1000;
      this.nextIntervalMs = clamped;
    }

    this.latestThought = thought;
    this.thoughtHistory.push(thought);
    if (this.thoughtHistory.length > this.config.cognitiveMemoryDepth) {
      this.thoughtHistory = this.thoughtHistory.slice(-this.config.cognitiveMemoryDepth);
    }
    this.totalThoughtCount++;

    this.emit("thought", thought);
    if (thought.postToSocial) {
      this.emit("spontaneous_post", thought);
    }
  }
}
