# Agent Town — Lifecycle v2

This is a separate test lifecycle. It does not replace the existing `scripts/wake_cycle.js`, `data/agents.json`, or `.github/workflows/wake.yml`.

## Per wake

1. One initial town-level Groq call creates shared circumstances.
2. One Groq call is made for each living agent.
3. One final town-level Groq call reconciles shared events, gossip, relationships and schedule contradictions.
4. The complete full-day schedules are locked in `data/agents-v2.json` until the next wake.

With 16 living agents, one wake normally makes about 18 requests.

## Files

- `scripts/wake_cycle_v2.js` — lifecycle engine
- `data/agents-seed-v2.json` — untouched reset seed
- `data/agents-v2.json` — live persistent v2 state
- `../.github/workflows/wake-v2.yml` — scheduled/manual GitHub Action

## GitHub setup

The repository must already contain a GitHub Actions secret named:

`GROQ_API_KEY`

The workflow uses Node.js 20 and runs Monday, Wednesday and Friday at 08:00 UTC. It can also be triggered manually from the Actions tab.

## Safe testing

The existing lifecycle continues to run independently. To test v2:

1. Open **Actions**.
2. Select **Wake the Town v2**.
3. Select **Run workflow**.
4. Inspect `lifecycle_v2/data/agents-v2.json` after the run commits.

## Godot data source

Later, Godot can fetch the public raw JSON at:

`https://raw.githubusercontent.com/alemanchris/agent_town/main/lifecycle_v2/data/agents-v2.json`

Godot only needs HTTP access; Git does not need to be installed locally.

## Model configuration

The workflow currently sets:

- individual agents: `openai/gpt-oss-20b`
- initial/final town calls: `openai/gpt-oss-120b`

These values can be changed in `.github/workflows/wake-v2.yml` without editing the JavaScript.
