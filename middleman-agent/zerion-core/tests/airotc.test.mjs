import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "../cli/zerion.js");
const TEST_HOME = "/tmp/zerion-airotc-test";
const TEST_WALLET = "11111111111111111111111111111111";
const TEST_SIG = "1111111111111111111111111111111111111111111111111111111111111111";

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      "node",
      [BIN, ...args],
      { env: { ...process.env, HOME: TEST_HOME, ZERION_API_KEY: "", ...env } },
      (error, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stdout, stderr });
      }
    );
  });
}

function parseJSON(str) {
  return JSON.parse(str);
}

describe("AIR OTC Zerion CLI commands", () => {
  it("creates deterministic policy proof JSON", async () => {
    const { code, stdout } = await run([
      "airotc",
      "policy-check",
      "--wallet",
      TEST_WALLET,
      "--role",
      "seller",
      "--chain",
      "solana",
      "--max-spend-usd",
      "1",
      "--expires-at",
      "2099-01-01T00:00:00.000Z",
    ]);
    assert.equal(code, 0);
    const json = parseJSON(stdout);
    assert.equal(json.airotc.type, "ZERION_POLICY_CHECK");
    assert.equal(json.airotc.status, "approved");
    assert.match(json.airotc.policyHash, /^[a-f0-9]{64}$/);
  });

  it("fails closed for wallet verification without Zerion access", async () => {
    const { code, stderr } = await run([
      "airotc",
      "verify-seller",
      "--wallet",
      TEST_WALLET,
      "--asset",
      "SOL",
      "--min-amount",
      "0.1",
      "--chain",
      "solana",
    ]);
    assert.equal(code, 1);
    const json = parseJSON(stderr);
    assert.equal(json.error.code, "missing_zerion_access");
  });

  it("fails closed for online checks without Zerion access", async () => {
    const { code, stderr } = await run([
      "airotc",
      "online-check",
      "--wallet",
      TEST_WALLET,
      "--chain",
      "solana",
    ]);
    assert.equal(code, 1);
    const json = parseJSON(stderr);
    assert.equal(json.error.code, "missing_zerion_access");
  });

  it("allows offline online-check only when explicitly requested", async () => {
    const { code, stdout } = await run([
      "airotc",
      "online-check",
      "--wallet",
      TEST_WALLET,
      "--chain",
      "solana",
      "--mode",
      "light",
      "--allow-offline",
    ]);
    assert.equal(code, 0);
    const json = parseJSON(stdout);
    assert.equal(json.airotc.type, "ZERION_ONLINE_CHECK");
    assert.equal(json.airotc.online, false);
    assert.equal(json.airotc.status, "offline_allowed_for_tests");
    assert.equal(json.airotc.snapshot.mode, "light");
  });

  it("rejects unknown online-check modes", async () => {
    const { code, stderr } = await run([
      "airotc",
      "online-check",
      "--wallet",
      TEST_WALLET,
      "--chain",
      "solana",
      "--mode",
      "deep",
      "--allow-offline",
    ]);
    assert.equal(code, 1);
    const json = parseJSON(stderr);
    assert.equal(json.error.code, "invalid_online_check_mode");
  });

  it("allows offline verification only when explicitly requested", async () => {
    const { code, stdout } = await run([
      "airotc",
      "verify-seller",
      "--wallet",
      TEST_WALLET,
      "--asset",
      "SOL",
      "--min-amount",
      "0.1",
      "--chain",
      "solana",
      "--allow-offline",
    ]);
    assert.equal(code, 0);
    const json = parseJSON(stdout);
    assert.equal(json.airotc.status, "offline_allowed_for_tests");
    assert.equal(json.airotc.verified, false);
  });

  it("accepts explicit real transaction evidence", async () => {
    const { code, stdout } = await run([
      "airotc",
      "execute-demo-tx",
      "--external-tx",
      TEST_SIG,
    ]);
    assert.equal(code, 0);
    const json = parseJSON(stdout);
    assert.equal(json.airotc.type, "ZERION_REAL_TX_EVIDENCE");
    assert.equal(json.airotc.executed, true);
    assert.equal(json.airotc.txHash, TEST_SIG);
  });
});
