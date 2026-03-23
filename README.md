# Nexus

**Track: Autonomous DeFi Agent**

Most DeFi agents execute what you tell them. Nexus decides *when and why* to act. It monitors a funded `USDt` treasury on Arbitrum, reads market regime signals, applies per-user policy bands, and autonomously rebalances across `USDt`, `XAUt`, and Aave — all through Tether WDK, with structured receipts for every decision.

[Live deployment](https://nexus-defi-agent.fly.dev) · [Demo video](https://www.youtube.com/watch?v=PLACEHOLDER)

## What Nexus Does

Nexus treats a wallet as a treasury system, not just a balance viewer.

- Maintains a configurable `USDt` reserve floor
- Uses `XAUt` as a defensive allocation when market conditions move risk-off (driven by Fear & Greed and gold signals)
- Deploys idle `USDt` to Aave within policy bounds when conditions are not risk-off
- Routes every autonomous action through a central risk gate with on-chain guardrails
- Records structured receipts with policy, signal, and transaction context for auditability
- Supports bounded autonomous operational payments through x402

## Product Surfaces

- **Web dashboard**: treasury state, policy editing, receipts, public demo access, and private operator controls
- **Telegram bot**: alerts, read actions, and command-driven interaction
- **OpenClaw skill**: workspace skill in [SKILL.md](./SKILL.md) for file-based agent integration
- **HTTP / WebSocket API**: read state, stream events, and send chat intents

## Autonomous Decision Engine

Nexus is not a chatbot with wallet bindings. The core loop runs autonomously on a 5-minute cycle:

1. **Regime detection** — Fear & Greed Index, gold spot / `XAUt` price, and Bitfinex on-chain pricing are polled and cached. Nexus classifies posture as risk-off (F&G ≤ 40 or gold 24h > 1.5%), neutral, or risk-on (F&G ≥ 65 and gold 24h ≤ 0.5%).
2. **Policy evaluation** — each user's treasury policy (reserve floor, `XAUt` target/max, yield ceiling, action sizes, cooldowns) is evaluated against current balances and regime posture. The engine produces a prioritized action: restore reserve → increase `XAUt` defense → trim `XAUt` excess → deploy idle `USDt` to Aave → hold.
3. **Risk gating** — every action passes through a central risk gate that scores risk 1–10, enforces on-chain `NexusGuard` limits (pause, caps, cooldowns), validates CEX-DEX price coherence, checks spend budgets, and blocks autonomous actors entirely when guard data is unavailable (fail-closed).
4. **WDK execution** — approved actions execute through Tether WDK: Velora swaps, Aave V3 supply/withdraw, USDT0 bridging, and direct transfers.
5. **Receipt and audit** — every decision produces a structured receipt containing the regime snapshot, policy state, risk score, reasoning trace, and transaction hash.

The human never needs to be in the loop. Nexus decides *when* based on regime signals and policy thresholds, and *why* based on the prioritized evaluation logic — and records both for full auditability.

## Architecture

```text
src/
├── agents/
│   ├── autopilot.ts       Background treasury cycle and user policy execution
│   ├── coordinator.ts     Intent routing, confirmations, unified execution path
│   ├── treasury.ts        Balances, transfers, addresses
│   ├── market.ts          Portfolio valuation, prices, regime inputs
│   ├── swap.ts            Velora swap quoting and execution
│   ├── yield.ts           Aave supply / withdraw / borrow / repay
│   ├── bridge.ts          USDT0 bridge quoting and execution
│   └── risk.ts            Risk gating, cooldowns, spend tracking
├── core/
│   ├── wdk-setup.ts       WDK wallet / protocol registration and account access
│   ├── account-context.ts Per-user account mapping
│   ├── treasury-policy.ts Policy model and validation
│   ├── regime-signals.ts  Fear & Greed + gold / XAUt signal inputs
│   ├── guard.ts           NexusGuard contract reads
│   ├── heartbeat.ts       Autopilot and source liveness
│   ├── rules.ts           Natural-language rule storage and evaluation
│   ├── x402-client.ts     Bounded autonomous micropayment flow
│   └── db.ts              SQLite schema and persistence
├── reasoning/
│   ├── llm.ts             LLM wrapper
│   ├── logger.ts          Per-user reasoning log
│   └── memory.ts          Conversation memory
├── chat/
│   └── telegram.ts        Telegram integration
├── mcp/
│   └── server.ts          MCP server
└── web/
    ├── auth.ts            Wallet challenge / response auth
    ├── server.ts          Express API, SSE, WebSocket
    └── public/index.html  Treasury dashboard
```

### Core Flow

1. Nexus resolves the current user and account context.
2. The coordinator or autopilot produces a treasury intent.
3. Risk and treasury policy validate the action.
4. WDK executes the wallet / protocol action.
5. Nexus stores receipts, reasoning, and heartbeat state.
6. The dashboard and streams expose the result.

## WDK Usage

WDK is the core wallet and protocol runtime in Nexus.

| Package | Role in Nexus |
|---|---|
| `@tetherto/wdk` | Core wallet lifecycle and protocol orchestration |
| `@tetherto/wdk-wallet-evm` | EVM account support |
| `@tetherto/wdk-wallet-evm-erc-4337` | Optional smart-account mode |
| `@tetherto/wdk-protocol-lending-aave-evm` | Aave V3 lending flows |
| `@tetherto/wdk-protocol-swap-velora-evm` | Velora swap flows |
| `@tetherto/wdk-protocol-bridge-usdt0-evm` | USDT0 bridge flows |
| `@tetherto/wdk-pricing-bitfinex-http` | Price feed input for valuation and execution checks |

In Nexus, WDK is used for:
- per-user account resolution
- token approvals
- transfers
- Aave lending actions
- swap execution
- bridge execution
- balance and portfolio reads

## OpenClaw and Agent Framework Integration

Nexus exposes its treasury capabilities to external agent frameworks through two interfaces:

- **[SKILL.md](./SKILL.md)** — a declarative skill manifest that any OpenClaw-compatible agent can load from the workspace. Covers treasury reads, policy queries, swap/yield/bridge intents, and regime inspection.
- **MCP server** (`npm run mcp`) — a Model Context Protocol server that exposes the same capabilities as structured tools for LLM-native agent orchestration.

Both interfaces route through the same coordinator and risk gate as the web dashboard, so external agents inherit the same policy bounds, cooldowns, and audit trail. This makes Nexus composable: it can act as a standalone autonomous treasury, or as a skill that a higher-level agent orchestrator delegates to.

## Treasury Policy

Each user has a persisted treasury policy that controls how the engine is allowed to act.

Current controls:
- reserve floor
- `XAUt` target percentage
- `XAUt` max percentage
- max yield allocation
- max action size
- cooldown seconds
- minimum rebalance threshold
- minimum Aave deploy threshold
- automation enabled / paused

For authenticated users, policy is visible and editable in the web dashboard.

## Signals and Regime Logic

Nexus fuses multiple external signals into a single regime posture that drives all autonomous decisions:

| Signal | Source | Role |
|---|---|---|
| Crypto Fear & Greed | Alternative.me | Sentiment regime input |
| Gold spot (XAU/USD) | gold-api.com | Macro risk barometer |
| `XAUt` price | Bitfinex (WDK pricing) | On-chain gold proxy and fallback |
| Token prices | Bitfinex + CoinGecko | Portfolio valuation and CEX-DEX coherence checks |

All signals are cached with a 5-minute TTL and report health to the heartbeat system. When a source degrades or becomes unavailable, the regime engine falls back gracefully and the heartbeat dashboard reflects the degradation.

Posture mapping:
- **Risk-off** (F&G ≤ 40 or gold 24h > 1.5%): protect reserve floor, rotate idle `USDt` into `XAUt`
- **Neutral**: preserve allocations, avoid unnecessary churn
- **Risk-on** (F&G ≥ 65 and gold 24h ≤ 0.5%): trim excess `XAUt` back toward target, deploy eligible idle `USDt` to Aave for yield

## Security and Guardrails

Every autonomous action passes through layered safety controls before reaching the chain:

| Layer | Mechanism |
|---|---|
| **Policy bounds** | Per-user reserve floor, allocation caps, action size limits, and cooldown timers |
| **Risk scoring** | Central 1–10 risk score; actions above threshold require manual confirmation or are blocked |
| **On-chain guard** | `NexusGuard` contract provides emergency pause, per-action caps, and cooldown enforcement on Arbitrum |
| **Fail-closed autonomy** | If `NexusGuard` data is unavailable, all autonomous actions are blocked — only manual user-initiated flows proceed |
| **CEX-DEX coherence** | Swap execution compares Bitfinex mid-price against Velora quote to reject excessive slippage |
| **Spend tracking** | Rolling spend ledger enforces daily and per-action budgets across treasury actions and x402 micropayments |
| **x402 payment caps** | Autonomous operational payments are capped at $2/payment and $10/day, whitelist-only, and recorded in the same spend ledger |
| **Heartbeat monitoring** | Autopilot cycle freshness and source health are tracked and surfaced in the dashboard |

## Access Modes

Nexus ships with three distinct access lanes:

1. **Public Demo** (`Judge Demo` in the UI)
   - the default landing experience
   - read-only inspection of the funded server treasury
   - two sealed real actions:
     - `swap 1 USDT to XAUT`
     - `supply 1 USDT to Aave`
2. **Wallet View**
   - unlocked through wallet-signature sign-in
   - uses the mapped wallet-linked WDK account context
3. **Operator Mode**
   - private
   - unlocked by opening the app with `?token=<WEB_ACCESS_TOKEN>`
   - targets the funded server treasury directly

Across all three modes, the dashboard exposes the same treasury state, policy, receipts, reasoning, and heartbeat surface.

## API Overview

### Auth

- `POST /api/auth/challenge`
- `POST /api/auth/verify`
- `GET /api/auth/me`
- `POST /api/auth/logout`

### Dashboard and State

- `GET /health`
- `GET /api/dashboard/state`
- `GET /api/demo/state`
- `POST /api/demo/action`
- `GET /api/policy`
- `PUT /api/policy`
- `GET /api/rules`
- `POST /api/rules`
- `DELETE /api/rules/:id`
- `GET /api/tx-log`
- `GET /api/premium/market-intel`
- `POST /api/demo` operator-only scenario trigger

### Interaction

- `POST /api/chat`
- `POST /api/chat/confirm`
- `GET /api/stream`
- `WS /ws`

## Local Setup

### Prerequisites

- Node.js 22+
- npm
- Arbitrum RPC URL
- OpenAI API key
- BIP-39 seed phrase for the WDK runtime

### Install

```bash
git clone https://github.com/Cassxbt/Nexusagent.git
cd Nexusagent/nexus
npm install
cp .env.example .env
```

Fill the required environment variables, then:

```bash
npm run build
npm start
```

For development:

```bash
npm run dev
```

The web dashboard runs on `http://localhost:3000` by default.

Production deployment:

```text
https://nexus-defi-agent.fly.dev
```

## Important Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | Yes | Routing and reasoning models |
| `WDK_SEED` | Yes | WDK wallet / strategy account seed |
| `ETH_RPC_URL` | Strongly recommended | Arbitrum RPC endpoint |
| `WDK_INDEXER_API_KEY` | Optional | WDK indexer support |
| `WDK_USE_ERC4337` | Optional | Enable ERC-4337 account mode |
| `WDK_BUNDLER_URL` | Optional | ERC-4337 bundler URL |
| `NEXUS_GUARD_ADDRESS` | Recommended | On-chain guard contract |
| `TELEGRAM_BOT_TOKEN` | Optional | Telegram bot |
| `TELEGRAM_ALLOWED_USERS` | Optional | Telegram allowlist |
| `WEB_PORT` | Optional | Web port, default `3000` |
| `WEB_ACCESS_TOKEN` | Optional | Extra web terminal token gate |
| `DATA_DIR` | Optional | SQLite storage directory |
| `PREMIUM_SERVICE_ADDRESS` | Optional | x402 premium market-intel recipient |

See [.env.example](./.env.example) for the current full list.

## Testing

```bash
npm test
npm run build
```

The repository currently includes unit and service-level coverage for:
- auth challenge / verify flow
- treasury policy support modules
- heartbeat degradation
- x402 autonomous payment validation
- bridge recipient validation
- cooldown helper behavior
- coordinator fallback routing
- autopilot alert dedupe
- public access and auth boundaries

Manual end-to-end validation is still required for live funds. Recommended manual checks:
- Public Demo loads the funded server treasury
- sealed demo actions execute and record receipts
- Operator Mode unlocks only with `?token=<WEB_ACCESS_TOKEN>`
- wallet sign-in still resolves Wallet View separately
- Telegram alerts, dashboard receipts, and `/health` stay in sync

Nexus does **not** yet include a full live WDK integration test suite against funded accounts.

## Known Limitations

These limitations are current and important:

1. **Execution authority**: wallet-signature login authenticates the user, but autonomous execution uses WDK-managed strategy accounts derived from the server seed — not yet full delegated execution from a user-owned smart account. ERC-4337 smart-account mode is wired but optional.
2. **Public demo exposure**: the public demo intentionally mirrors the funded server treasury. It is restricted to read-only inspection plus two sealed 1 USDT actions. For a stricter production deployment, expose a separate showcase account or tighten visibility further.
3. **Bridge scope**: bridge support is limited to the currently wired USDT0 path and supported EVM chains.
4. **Data dependency risk**: regime posture relies on external market data and degrades when those inputs are stale or unavailable.
5. **No full production test harness yet**: tests are meaningful, but larger capital deployment should still be treated cautiously until live funded integration coverage is expanded.

## Deployment Notes

- Persistent storage is required for SQLite state.
- The autopilot loop expects a continuously running process.
- A funded operator / strategy environment is required for autonomous execution.
- Lock down or separate public demo and diagnostic routes further before broader public deployment.

## License

Apache-2.0

Built with love by [Cassxbt](https://x.com/cassxbt).
