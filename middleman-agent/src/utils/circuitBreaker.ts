import { logger } from "./logger";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN" | "DEGRADED";

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private successes: number[] = [];
  private failures: { timestamp: number; reason?: string }[] = [];
  private lastStateChange: number = Date.now();

  private readonly FAILURE_THRESHOLD = 0.5;
  private readonly MIN_SAMPLE_SIZE = 10;
  private readonly COOLDOWN_MS = 30000;
  private readonly WINDOW_MS = 60000;
  private readonly MAX_RESETS = 5; // After 5 resets → permanent DEGRADED

  private halfOpenRequestInProgress: boolean = false;
  private resetCount: number = 0; // Track how many times we've recovered

  public isOpen(): boolean {
    return this.state === "OPEN" || this.state === "DEGRADED";
  }

  public getStatus() {
    this.pruneOldEvents();
    return {
      state: this.state,
      failureRate: this.getFailureRate(),
      totalRequests: this.successes.length + this.failures.length,
      lastFailureTime: this.failures.length > 0 ? this.failures[this.failures.length - 1].timestamp : 0,
      resetCount: this.resetCount,
      maxResets: this.MAX_RESETS,
    };
  }

  private pruneOldEvents(): void {
    const now = Date.now();
    this.successes = this.successes.filter(t => now - t <= this.WINDOW_MS);
    this.failures = this.failures.filter(f => now - f.timestamp <= this.WINDOW_MS);
  }

  public canExecute(): boolean {
    const now = Date.now();

    // LEVEL 5: Permanent DEGRADED mode — no recovery possible
    if (this.state === "DEGRADED") {
      logger.debug("circuit_breaker_block", { state: "DEGRADED", message: "Permanent degraded mode" });
      return false;
    }

    if (this.state === "CLOSED") {
      return true;
    }

    if (this.state === "OPEN") {
      if (now - this.lastStateChange > this.COOLDOWN_MS) {
        this.transitionTo("HALF_OPEN");
      } else {
        logger.debug("circuit_breaker_block", { state: "OPEN" });
        return false;
      }
    }

    if (this.state === "HALF_OPEN") {
      if (this.halfOpenRequestInProgress) {
        logger.debug("circuit_breaker_block", { state: "HALF_OPEN", message: "Awaiting recovery probe" });
        return false; // Block flood during recovery
      }
      this.halfOpenRequestInProgress = true;
      return true;
    }

    return true;
  }

  public recordSuccess(): void {
    this.pruneOldEvents();

    if (this.state === "HALF_OPEN") {
      this.resetCount++;
      // LEVEL 5: Check if we've exceeded the max resets
      if (this.resetCount >= this.MAX_RESETS) {
        logger.error("circuit_breaker_permanent_degraded", {
          resetCount: this.resetCount,
          maxResets: this.MAX_RESETS,
          message: "Too many recovery cycles — entering permanent DEGRADED mode",
        });
        this.transitionTo("DEGRADED");
        return;
      }
      this.reset();
      this.transitionTo("CLOSED");
    } else if (this.state === "CLOSED") {
      this.successes.push(Date.now());
    }
  }

  public recordFailure(reason?: string): void {
    this.pruneOldEvents();
    this.failures.push({ timestamp: Date.now(), reason });

    if (this.state === "HALF_OPEN") {
      // Re-trigger global circuit pause on immediate recovery pipeline failure
      this.transitionTo("OPEN");
    } else if (this.state === "CLOSED") {
      const totalExecutions = this.successes.length + this.failures.length;
      if (totalExecutions >= this.MIN_SAMPLE_SIZE) {
        const failureRate = this.getFailureRate();
        if (failureRate > this.FAILURE_THRESHOLD) {
          this.transitionTo("OPEN");
        }
      }
    }
  }

  public getFailureRate(): number {
    const total = this.successes.length + this.failures.length;
    return total === 0 ? 0 : this.failures.length / total;
  }

  public reset(): void {
    this.successes = [];
    this.failures = [];
    this.state = "CLOSED";
    this.halfOpenRequestInProgress = false;
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;

    const oldState = this.state;
    this.state = newState;
    this.lastStateChange = Date.now();

    if (newState !== "HALF_OPEN") {
      this.halfOpenRequestInProgress = false;
    }

    const eventName = newState === "CLOSED" ? "circuit_closed" :
      newState === "HALF_OPEN" ? "circuit_half_open" : "circuit_opened";

    const context: Record<string, any> = {
      old_state: oldState,
      new_state: newState,
    };

    if (newState === "OPEN") {
      context.failure_rate = this.getFailureRate();
      context.total_requests = this.successes.length + this.failures.length;
    }

    logger.warn(eventName, context);
  }
}

export const circuitBreaker = new CircuitBreaker();
