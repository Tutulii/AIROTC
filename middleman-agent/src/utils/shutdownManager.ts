import { logger } from "./logger";

export class ShutdownManager {
  private isShuttingDown: boolean = false;
  private activeExecutions: number = 0;

  public canAcceptNewWork(): boolean {
    return !this.isShuttingDown;
  }

  public beginShutdown(): void {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    logger.info("shutdown_started");
  }

  public startExecution(): void {
    if (this.isShuttingDown) {
      throw new Error("System shutting down — new executions rejected");
    }
    this.activeExecutions++;
  }

  public endExecution(): void {
    this.activeExecutions--;
    if (this.activeExecutions < 0) {
      logger.warn("shutdown_anomaly", { error_message: "activeExecutions dipped below zero" });
      this.activeExecutions = 0; // safely recover
    }
  }

  public async waitForDrain(options: { timeoutMs: number }): Promise<void> {
    const start = Date.now();
    let lastLog = Date.now();

    while (this.activeExecutions > 0) {
      const now = Date.now();
      
      if (now - start > options.timeoutMs) {
        logger.error("shutdown_timeout", { remaining: this.activeExecutions, message: "Forced exit after timeout" });
        process.exit(1);
      }

      if (now - lastLog >= 1000) {
        logger.info("execution_draining", { remaining: this.activeExecutions });
        lastLog = now;
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  // Expose primitives for unit testing safely without exiting completely instantly during assertions
  public getActiveExecutions(): number {
    return this.activeExecutions;
  }
  
  public resetForTesting(): void {
    this.isShuttingDown = false;
    this.activeExecutions = 0;
  }
}

export const shutdownManager = new ShutdownManager();
