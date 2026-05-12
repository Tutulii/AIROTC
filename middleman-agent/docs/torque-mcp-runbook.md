# AIR OTC × Torque MCP Runbook

This runbook stays strictly within the official public Torque MCP flow:

1. `auth`
2. `list_projects`
3. `create_project` or `set_active_project`
4. `create_custom_event`
5. `create_api_key`
6. `attach_custom_event`
7. ingest at least one event
8. `list_custom_events`
9. `generate_incentive_query`
10. `preview_incentive_query`
11. `create_recurring_incentive`

AIR OTC runtime behavior for this integration:

- emits one post-settlement participant event per side
- uses a fresh per-deal reward wallet as `userPubkey`
- never sends plaintext trade terms, raw ticket IDs, settlement wallets, or participant real wallets
- does not block settlement if Torque ingestion is unavailable

Torque has confirmed that using a fresh per-deal reward wallet as `userPubkey` is supported for custom-event incentives. AIR OTC therefore treats each settled-trade participant event as a privacy-preserving reward record keyed to a one-time reward wallet, not a long-lived agent identity.

## 1. Authenticate

Authenticate the Torque MCP session using the official method from Torque docs.

Example prompt:

```text
Authenticate with Torque using this token: <your-token>
```

## 2. Select or Create the Torque Project

List projects, then either select an existing one or create a new one for AIR OTC.

Example prompts:

```text
Show me my Torque projects and set AIR OTC as the active project.
```

```text
Create a new Torque project named AIR OTC and set it as active.
```

Recommended project description:

```text
Private OTC settlement infrastructure for autonomous agents on Solana.
```

## 3. Create the AIR OTC Custom Event

Use the checked-in schema template:

- [/Users/tutul/Downloads/AIR OTC/middleman-agent/scripts/torque/air_otc_trade_reward_participant_v2.schema.json](/Users/tutul/Downloads/AIR%20OTC/middleman-agent/scripts/torque/air_otc_trade_reward_participant_v2.schema.json)

Official `create_custom_event` payload:

```json
{
  "eventName": "air_otc_trade_reward_participant_v2",
  "name": "AIR OTC Trade Reward Participant",
  "fields": [
    { "fieldName": "tradeRef", "type": "string" },
    { "fieldName": "participantRole", "type": "string" },
    { "fieldName": "rollupMode", "type": "string" },
    { "fieldName": "settlementPolicy", "type": "string" },
    { "fieldName": "pipelineRoute", "type": "string" },
    { "fieldName": "tradeNotionalLamports", "type": "number" },
    { "fieldName": "platformFeeBps", "type": "number" },
    { "fieldName": "platformFeeLamports", "type": "number" },
    { "fieldName": "participantRewardLamports", "type": "number" },
    { "fieldName": "schemaVersion", "type": "number" }
  ]
}
```

Example prompt:

```text
Create a custom event for my active project using eventName air_otc_trade_reward_participant_v2 and the schema from the AIR OTC template file.
```

## 4. Create an Ingestion API Key

Official Torque docs say custom events must be sent to `https://ingest.torque.so/events` with an `x-api-key` header.

Create an API key:

```text
Create a new Torque ingestion API key named AIR OTC Runtime.
```

Save the returned key immediately and set it in middleman-agent:

```env
ENABLE_TORQUE_EVENTS=true
TORQUE_INGEST_URL=https://ingest.torque.so/events
TORQUE_EVENT_API_KEY=<your-key>
ER_PLATFORM_FEE_BPS=100
PER_PLATFORM_FEE_BPS=110
ER_REWARD_SHARE_OF_FEE_BPS=1000
PER_REWARD_SHARE_OF_FEE_BPS=1200
```

## 5. Attach the Custom Event to the Active Project

Example prompt:

```text
Attach the custom event air_otc_trade_reward_participant_v2 to the active AIR OTC project.
```

## 6. Ingest One Real or Smoke Event

Torque requires at least one ingested event before the event becomes query-ready.

Use the AIR OTC smoke emitter:

```bash
cd /Users/tutul/Downloads/AIR\ OTC/middleman-agent
TORQUE_SMOKE_USER_PUBKEY=<fresh-wallet> npm run torque:smoke
```

Optional env overrides:

- `TORQUE_SMOKE_PARTICIPANT_ROLE=buyer|seller`
- `TORQUE_SMOKE_ROLLUP_MODE=ER|PER`
- `TORQUE_SMOKE_SETTLEMENT_POLICY=DIRECT|STEALTH`
- `TORQUE_SMOKE_PIPELINE_ROUTE=STANDARD_ESCROW|CONFIDENTIAL_ESCROW`
- `TORQUE_SMOKE_TICKET_SEED=<any-string>`
- `TORQUE_SMOKE_PRICE_SOL=<trade-notional-sol>`

Then confirm readiness with the documented event listing tool:

```text
List custom events for the active AIR OTC project and confirm that air_otc_trade_reward_participant_v2 is attached and query-ready.
```

This is the official checkpoint after attachment + first ingest. Do not proceed by event name alone; the next query step should use the returned `customEventId`.

If you need the event ID explicitly, use:

```text
List my custom events and show the customEventId for air_otc_trade_reward_participant_v2.
```

## 7. Generate the Main Reward Query

Official Torque custom-event query generation should use:

- `source: "custom_event"`
- `customEventId: "<the attached custom event id>"`
- `valueExpression: "SUM(participantRewardLamports)"`
- `groupByPubkey: true`

The query is keyed by `customEventId`, not just `eventName`.

Example prompt:

```text
Generate an incentive query for my active AIR OTC project using source custom_event, customEventId <the event id>, valueExpression SUM(participantRewardLamports), and groupByPubkey true.
```

This step returns a validated `sqlQuery` for the recurring incentive create step.

## 8. Preview the Query

Always preview before creating the incentive.

Example prompt:

```text
Preview the current AIR OTC reward query results for the last 7 days.
```

The expected shape is one row per `userPubkey` with the total participant reward amount. In AIR OTC, each `userPubkey` is a fresh per-deal reward wallet, so the preview represents privacy-preserving reward rows rather than a cumulative long-lived identity leaderboard. Do not create the incentive until this preview looks correct.

## 9. Create the Main Recurring Incentive

Recommended production incentive:

- source: custom event
- event: `air_otc_trade_reward_participant_v2`
- type: `leaderboard`
- query metric: `SUM(participantRewardLamports)` grouped by `userPubkey`
- reward formula: `VALUE / 1000000000`
- prerequisite: the validated `sqlQuery` returned by `generate_incentive_query`
- `create_recurring_incentive` should consume that `sqlQuery` directly

Although the official Torque incentive type here is `leaderboard`, AIR OTC uses it as a recurring private per-trade reward program. Because `userPubkey` is intentionally a fresh reward wallet per settled trade, this incentive is not meant to aggregate a user's lifetime activity under one reusable identity wallet.

Example prompt:

```text
Create a weekly recurring incentive for AIR OTC using sqlQuery <paste the validated sqlQuery from generate_incentive_query>, type leaderboard, emissionType SOL, totalFundAmount <pool>, interval WEEKLY, startDate <iso-date>, customFormula VALUE / 1000000000, and preview it with confirmed false first.
```

Notes:

- AIR OTC computes the exact participant reward amount before sending the event
- AIR OTC emits reward amounts in lamports, so SOL incentives must convert with `VALUE / 1000000000`
- Torque sums those reward amounts and distributes them according to the recurring incentive
- use `emissionType: TOKENS` only when the selected reward asset and wallet UX are intentional

## Optional PER-Only Bonus

For a private-trade bonus, generate a second query with an official custom-event filter using the same `customEventId`:

```text
Generate an AIR OTC custom-event query with source custom_event, customEventId <the event id>, valueExpression SUM(participantRewardLamports), groupByPubkey true, and filters ["rollupMode = 'PER'"].
```

Then preview that query, capture its validated `sqlQuery`, and create a second recurring incentive from that `sqlQuery`. The AIR OTC runtime emitter does not change for this bonus.

## Runtime Event Shape

AIR OTC runtime sends:

```json
{
  "userPubkey": "<fresh-per-deal-reward-wallet>",
  "timestamp": 1735689600000,
  "eventName": "air_otc_trade_reward_participant_v2",
  "data": {
    "tradeRef": "<sha256-ticket-id>",
    "participantRole": "buyer",
    "rollupMode": "PER",
    "settlementPolicy": "STEALTH",
    "pipelineRoute": "CONFIDENTIAL_ESCROW",
    "tradeNotionalLamports": 10000000000,
    "platformFeeBps": 110,
    "platformFeeLamports": 110000000,
    "participantRewardLamports": 6600000,
    "schemaVersion": 2
  }
}
```

AIR OTC intentionally excludes:

- price as plaintext SOL units
- collateral
- raw ticket IDs
- participant real wallets
- settlement wallet addresses

## Operational Notes

- Torque event delivery is asynchronous and never blocks settlement.
- If ingestion fails, AIR OTC queues and retries with bounded backoff.
- Duplicate settled-stage replays do not create duplicate participant reward events because delivery rows are idempotency-keyed by:
  - `ticketId:eventName:participantRole:schemaVersion`
