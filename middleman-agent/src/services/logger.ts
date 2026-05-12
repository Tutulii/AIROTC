export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatLog(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>
): string {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    service: "middleman-agent",
    message,
  };

  if (data) {
    entry.data = data;
  }

  return JSON.stringify(entry);
}

export function logDebug(
  message: string,
  data?: Record<string, unknown>
): void {
  if (shouldLog("debug")) {
    console.debug(formatLog("debug", message, data));
  }
}

export function logInfo(
  message: string,
  data?: Record<string, unknown>
): void {
  if (shouldLog("info")) {
    console.log(formatLog("info", message, data));
  }
}

export function logWarn(
  message: string,
  data?: Record<string, unknown>
): void {
  if (shouldLog("warn")) {
    console.warn(formatLog("warn", message, data));
  }
}

export function logError(message: string, error?: unknown): void {
  if (!shouldLog("error")) return;

  const data: Record<string, unknown> = {};

  if (error instanceof Error) {
    data.error = error.message;
    data.stack = error.stack;
    data.name = error.name;
  } else if (error !== undefined) {
    data.error = String(error);
  }

  console.error(formatLog("error", message, data));
}
