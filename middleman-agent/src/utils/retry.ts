import { rpcManager } from "./rpcManager";
import { circuitBreaker } from "./circuitBreaker";
import { shutdownManager } from "./shutdownManager";
import { logger } from "./logger";

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isRetryableError(error: any): boolean {
  if (!error) return false;
  const msg = String(error.message || error).toLowerCase();

  // Non-retryable constraints (Anchor program errors, syntax, invalid accounts, constraints, already created)
  if (
    msg.includes("custom program error") ||
    msg.includes("constraint") ||
    msg.includes("invalid account") ||
    msg.includes("already initialized") ||
    msg.includes("account already exists") ||
    msg.includes("signature verification failed") ||
    msg.includes("privilege escalated") ||
    msg.includes("uninitialized account") ||
    msg.includes("duplicate") ||
    msg.includes("insufficient lamports")
  ) {
    return false; // Fast fail immediately
  }

  // Check for safe, intermittent network and RPC errors
  if (
    msg.includes("blockhash not found") ||
    msg.includes("node is behind") ||
    msg.includes("timeout") ||
    msg.includes("etimedout") ||
    msg.includes("fetch failed") ||
    msg.includes("fetch error") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("ehostunreach") ||
    msg.includes("enotfound") ||
    msg.includes("network error") ||
    msg.includes("unavailable") ||
    msg.includes("temporarily unavailable") ||
    msg.includes("no connection established") ||
    msg.includes("deadline exceeded") ||
    msg.includes("transaction was not confirmed") ||
    msg.includes("transactionexpiredtimeouterror") ||
    msg.includes("unknown if it succeeded or failed") ||
    msg.includes("server responded with status") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("502")
  ) {
    return true;
  }

  // Safer to explicitly deny unknown errors by default for idempotency
  return false;
}

const MAX_RETRY_TIME_PER_DEAL = 120_000; // 2 minutes hard cap per deal retry cycle

export async function withRetry<T>(
  fn: () => Promise<T>,
  context: { label: string; ticketId?: string; step?: string }
): Promise<T> {
  // Lowest-level Global Safe Disconnect Mutex Check (Rejects entirely BEFORE counting as execution)
  shutdownManager.startExecution();

  const retryStartTime = Date.now();

  try {
    if (!circuitBreaker.canExecute()) {
      throw new Error("Circuit breaker OPEN — execution paused");
    }

    const maxRetries = 3;
    const delays = [1000, 2000, 4000];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // GUARDRAIL 1: Hard time cap — no deal retries past 2 minutes
      const totalElapsedMs = Date.now() - retryStartTime;
      if (totalElapsedMs > MAX_RETRY_TIME_PER_DEAL) {
        logger.error("retry_budget_exhausted", {
          ticket_id: context.ticketId,
          label: context.label,
          elapsed_ms: totalElapsedMs,
          max_ms: MAX_RETRY_TIME_PER_DEAL,
        });
        circuitBreaker.recordFailure();
        throw new Error("SAFETY_HALT: Deal retry budget exhausted (2 min max)");
      }
      if (attempt > maxRetries) {
        circuitBreaker.recordFailure();
        throw new Error("Retry Budget Exceeded");
      }

      try {
        const startMs = Date.now();
        const result = await fn();
        const durationMs = Date.now() - startMs;

        // Complete success evaluated against performance margins. Live devnet
        // dependencies can be slow without being unsafe; demos may opt out of
        // counting slow-but-successful calls as circuit-breaker failures.
        const slowResponseMs = Number(process.env.CIRCUIT_BREAKER_SLOW_RESPONSE_MS || "5000");
        const countSlowResponses =
          process.env.CIRCUIT_BREAKER_COUNT_SLOW_RESPONSES !== "false";
        if (durationMs > slowResponseMs) {
          if (countSlowResponses) {
            circuitBreaker.recordFailure("slow_response");
          } else {
            circuitBreaker.recordSuccess();
          }
          logger.warn("retry_slow_response", {
            ticket_id: context.ticketId,
            label: context.label,
            duration_ms: durationMs,
            counted_as_circuit_failure: countSlowResponses,
          });
        } else {
          circuitBreaker.recordSuccess();
        }

        if (attempt > 0) {
          logger.info("retry_success", {
            ticket_id: context.ticketId,
            attempt,
            label: context.label,
            step: context.step,
          });
        }
        return result;
      } catch (error: any) {
        if (!isRetryableError(error)) {
          circuitBreaker.recordFailure();
          throw error;
        }

        if (rpcManager.markFailure(rpcManager.getCurrentIndex())) {
          rpcManager.switchEndpoint();
        }

        if (attempt >= maxRetries) {
          circuitBreaker.recordFailure();
          logger.error("retry_failed", {
            ticket_id: context.ticketId,
            label: context.label,
            step: context.step,
          }, error);
          throw error;
        }

        const baseDelay = delays[attempt];
        const jitter = Math.floor(Math.random() * 300);
        const delay = baseDelay + jitter;

        logger.warn("retry_attempt", {
          ticket_id: context.ticketId,
          rpc_index: rpcManager.getCurrentIndex(),
          attempt: attempt + 1,
          label: context.label,
          step: context.step,
          delay_ms: delay,
          error_message: String(error.message || error),
        });

        await sleep(delay);
      }
    }

    circuitBreaker.recordFailure();
    throw new Error("Retry loop exhausted unexpectedly.");

  } finally {
    // Guarantees termination drains regardless of logic / throws internally
    shutdownManager.endExecution();
  }
}
