# Torque MCP Runbook

Official docs-locked flow:

1. `auth`
2. `get_project`
3. `create_custom_event`
4. `emit_custom_event`
5. `create_campaign`
6. `preview_rewards`
7. `query_rewards`
8. `list_custom_events`

Ingest endpoint:

`https://ingest.torque.so/events`

Authentication header:

`x-api-key`

AIR OTC reward event:

`air_otc_trade_reward_participant_v2`

Required event field:

`customEventId`

Reward analytics query fields:

```sql
SUM(participantRewardLamports)
VALUE / 1000000000
```

MCP query key:

`sqlQuery`

Campaign confirmation state:

`confirmed false`
