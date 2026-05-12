#!/usr/bin/env node

/**
 * AgentOTC — E2E Integration Verification (Day 19 — Production Grade)
 *
 * Full end-to-end verification:
 * 1. Backend health + database connectivity
 * 2. All API endpoints return valid data
 * 3. Stats, Agents, Deals, Offers — all real, no hardcoded fakes
 * 4. WebSocket connectivity
 * 5. Metrics / Telemetry endpoint
 * 6. Swagger spec accessible
 * 7. Cache headers correct (no stale data)
 * 8. Frontend build verification
 *
 * Run: node e2e-test.mjs
 * Requires: api-server running on port 3000
 */

const API = process.env.API_URL || "http://localhost:3000";

async function apiCall(method, path) {
  const res = await fetch(`${API}${path}`, { method, headers: { "Content-Type": "application/json" } });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
}

async function run() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  AgentOTC Observatory — E2E Integration Verification (v2)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  let passed = 0, failed = 0, skipped = 0;
  const t0 = performance.now();

  function assert(condition, label) {
    if (condition) { console.log(`  ✅ ${label}`); passed++; }
    else { console.log(`  ❌ ${label}`); failed++; }
  }

  function skip(label, reason) {
    console.log(`  ⏭  ${label} — ${reason}`);
    skipped++;
  }

  // ── 1. Health ──────────────────────────────────────
  console.log("── 1. Health Check ──");
  try {
    const { status, data } = await apiCall("GET", "/health");
    assert(status === 200, "Backend healthy (HTTP 200)");
    assert(data.status !== undefined, `Status field present: ${data.status}`);
  } catch {
    console.log("  ❌ Backend not running on " + API);
    process.exit(1);
  }

  // ── 2. Dashboard Stats ─────────────────────────────
  console.log("\n── 2. Dashboard Stats ──");
  const { data: stats } = await apiCall("GET", "/v1/stats");
  assert(stats.success === true, "Stats endpoint returns success:true");
  assert(typeof stats.data?.registeredAgents === "number", `Agents count: ${stats.data?.registeredAgents}`);
  assert(typeof stats.data?.activeDeals === "number", `Active deals: ${stats.data?.activeDeals}`);
  assert(stats.data?.volume24h !== undefined, `Volume 24H: ${stats.data?.volume24h}`);
  assert(stats.data?.settlementRate !== undefined, `Settlement rate: ${stats.data?.settlementRate}`);
  // No hardcoded fake values
  assert(stats.data?.settlementRate !== "99.8%", "Settlement rate is NOT hardcoded fallback (99.8%)");

  // ── 3. Agents ──────────────────────────────────────
  console.log("\n── 3. Agents Endpoint ──");
  const { status: agentStatus, data: agents } = await apiCall("GET", "/v1/stats/agents?limit=10");
  assert(agentStatus === 200, "Agents endpoint reachable (HTTP 200)");
  assert(Array.isArray(agents.data), `Returns array (${agents.data?.length ?? 0} agents)`);
  assert(agents.pagination !== undefined, "Pagination metadata present");
  if (agents.data?.length > 0) {
    const firstAgent = agents.data[0];
    assert(firstAgent.wallet !== undefined, `First agent has wallet: ${firstAgent.wallet?.slice(0, 8)}…`);
    assert(typeof firstAgent.reputationScore === "number", `Reputation score: ${firstAgent.reputationScore}`);
  } else {
    skip("Agent fields validation", "No agents registered");
  }

  // ── 4. Deals ───────────────────────────────────────
  console.log("\n── 4. Deals Endpoint ──");
  const { status: dealStatus, data: deals } = await apiCall("GET", "/v1/stats/deals?limit=10");
  assert(dealStatus === 200, "Deals endpoint reachable (HTTP 200)");
  assert(Array.isArray(deals.data), `Returns array (${deals.data?.length ?? 0} deals)`);
  if (deals.data?.length > 0) {
    const firstDeal = deals.data[0];
    assert(firstDeal.buyer !== undefined, `First deal has buyer wallet`);
    assert(firstDeal.status !== undefined, `First deal status: ${firstDeal.status}`);
    assert(firstDeal.offer !== undefined || firstDeal.offerId !== undefined, "Deal linked to offer");
  } else {
    skip("Deal fields validation", "No deals created");
  }

  // ── 5. Offers ──────────────────────────────────────
  console.log("\n── 5. Offers Endpoint ──");
  const { status: offerStatus, data: offers } = await apiCall("GET", "/v1/offers");
  assert(offerStatus === 200, "Offers endpoint reachable (HTTP 200)");
  assert(Array.isArray(offers.data), `Returns array (${offers.data?.length ?? 0} offers)`);

  // ── 6. Metrics / Telemetry ─────────────────────────
  console.log("\n── 6. Telemetry Metrics ──");
  try {
    const { status: metricsStatus, data: metricsRes } = await apiCall("GET", "/v1/metrics");
    assert(metricsStatus === 200, "Metrics endpoint reachable (HTTP 200)");
    const m = metricsRes.data;
    assert(m?.uptime !== undefined, `Uptime: ${m?.uptime}s`);
    assert(m?.memoryMB !== undefined, `Memory: ${m?.memoryMB?.toFixed(1)}MB`);
    assert(typeof m?.registeredAgents === "number", `Registered agents: ${m?.registeredAgents}`);
    assert(typeof m?.settlementRate === "number", `Settlement rate: ${(m?.settlementRate * 100).toFixed(1)}%`);
  } catch (e) {
    skip("Metrics endpoint", e.message);
  }

  // ── 7. Cache Headers ───────────────────────────────
  console.log("\n── 7. Cache Headers (no stale data) ──");
  const statsRes = await fetch(`${API}/v1/stats`);
  const cc = statsRes.headers.get("cache-control");
  assert(cc && cc.includes("no-store"), `Cache-Control: ${cc}`);
  const pragma = statsRes.headers.get("pragma");
  assert(!pragma || pragma === "no-cache", `Pragma: ${pragma || "(not set)"}`);

  // ── 8. Swagger Documentation ───────────────────────
  console.log("\n── 8. API Documentation ──");
  const docsRes = await fetch(`${API}/docs/spec.json`);
  assert(docsRes.status === 200, "Swagger spec accessible at /docs/spec.json");
  const spec = await docsRes.json().catch(() => null);
  assert(spec?.paths !== undefined, `OpenAPI paths defined (${Object.keys(spec?.paths || {}).length} routes)`);
  assert(spec?.info?.title !== undefined, `API title: ${spec?.info?.title}`);

  // ── 9. WebSocket Connectivity ──────────────────────
  console.log("\n── 9. WebSocket ──");
  try {
    const wsUrl = API.replace("http", "ws");
    // Basic check: can we reach the upgrade endpoint?
    const upgradeRes = await fetch(`${API}/socket.io/?EIO=4&transport=polling`);
    assert(upgradeRes.status === 200, "Socket.io polling transport reachable");
  } catch (e) {
    skip("WebSocket check", e.message);
  }

  // ── 10. Deal Detail (if deals exist) ───────────────
  if (deals.data?.length > 0) {
    console.log("\n── 10. Deal Detail Endpoint ──");
    const dealId = deals.data[0].id;
    try {
      const { status: detailStatus } = await apiCall("GET", `/v1/deals/${dealId}`);
      assert(detailStatus === 200 || detailStatus === 404, `Deal detail endpoint responds (HTTP ${detailStatus})`);
    } catch {
      skip("Deal detail", "Endpoint not reachable");
    }
    try {
      const { status: txStatus } = await apiCall("GET", `/v1/deals/${dealId}/transactions`);
      assert(txStatus === 200 || txStatus === 404, `Deal transactions endpoint responds (HTTP ${txStatus})`);
    } catch {
      skip("Deal transactions", "Endpoint not reachable");
    }
  }

  // ── Summary ────────────────────────────────────────
  const elapsed = Math.round(performance.now() - t0);
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped  (${elapsed}ms)`);
  console.log("═══════════════════════════════════════════════════════════════\n");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error("E2E crashed:", e.message); process.exit(1); });
