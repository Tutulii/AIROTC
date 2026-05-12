/**
 * Logger — Structured colored console output for agent activity
 */

const COLORS: Record<string, string> = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

export function log(agent: string, message: string, color: string = "reset"): void {
  const timestamp = new Date().toISOString().split("T")[1]?.split(".")[0] || "";
  const c = COLORS[color] || COLORS.reset;
  const agentColor = agent.includes("Alpha") ? COLORS.cyan : COLORS.magenta;
  console.log(
    `${COLORS.dim}[${timestamp}]${COLORS.reset} ${agentColor}[${agent}]${COLORS.reset} ${c}${message}${COLORS.reset}`
  );
}

export function logPhase(phase: string): void {
  console.log(`\n${COLORS.bold}${COLORS.yellow}${"═".repeat(60)}${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.yellow}  ${phase}${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.yellow}${"═".repeat(60)}${COLORS.reset}\n`);
}

export function logSuccess(message: string): void {
  console.log(`\n${COLORS.bold}${COLORS.green}✅ ${message}${COLORS.reset}\n`);
}

export function logError(message: string): void {
  console.log(`\n${COLORS.bold}${COLORS.red}❌ ${message}${COLORS.reset}\n`);
}
