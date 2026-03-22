# Nexus

Nexus is an autonomous treasury agent for Arbitrum built on Tether WDK. It monitors treasury state, applies policy bands for `USDt`, `XAUt`, and Aave yield, records structured receipts for each action, and exposes the same engine through a web dashboard, Telegram bot, and an OpenClaw-compatible workspace skill.

This repository is optimized for the DoraHacks WDK hackathon criteria:
- meaningful WDK usage for wallet and protocol operations
- OpenClaw-compatible agent integration
- real Tether asset usage (`USDt`, `XAUt`)
- a clear explanation of architecture, setup, and known limitations

## What Nexus Does

Nexus treats a wallet as a treasury, not just a balance viewer.

- Maintains a configurable `USDt` reserve floor
- Uses `XAUt` as a defensive allocation when market conditions move risk-off
- Deploys idle `USDt` to Aave within policy bounds
- Records structured receipts with policy, signal, and transaction context
- Supports bounded autonomous operational payments through x402
- Exposes a read-only demo surface so judges can inspect a live treasury state without funding a wallet

## Product Surfaces

- **Web dashboard**: primary product surface for sign-in, treasury state, policy editing, receipts, and demo mode
- **Telegram bot**: alerts, read actions, and command-driven interaction
- **OpenClaw skill**: workspace skill in [SKILL.md](/Users/apple/tether-hackathon/nexus/SKILL.md) for file-based agent integration
- **HTTP / WebSocket API**: read state, stream events, and send chat intents

## Execution Model

Nexus currently has two separate authorities:

1. **Wallet-signature login** proves that a user controls an external wallet address.
2. **WDK-managed strategy accounts** derived from `WDK_SEED` execute autonomous actions on-chain.

That means the current hackathon build is **not yet full delegated execution from a user-owned smart account**. The connected wallet is the user identity anchor. Autonomous execution currently happens from per-user WDK strategy accounts managed by the server runtime.

This is the most important known limitation in the project, and it is documented here intentionally rather than hidden.

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

Nexus uses WDK directly for wallet and protocol operations.

| Package | Role in Nexus |
|---|---|
| `@tetherto/wdk` | Core wallet lifecycle and protocol orchestration |
| `@tetherto/wdk-wallet-evm` | EVM account support |
| `@tetherto/wdk-wallet-evm-erc-4337` | Optional smart-account mode |
| `@tetherto/wdk-protocol-lending-aave-evm` | Aave V3 lending flows |
| `@tetherto/wdk-protocol-swap-velora-evm` | Velora swap flows |
| `@tetherto/wdk-protocol-bridge-usdt0-evm` | USDT0 bridge flows |
| `@tetherto/wdk-pricing-bitfinex-http` | Price feed input for valuation and execution checks |

WDK is used for:
- per-user account resolution
- token approvals
- transfers
- Aave lending actions
- swap execution
- bridge execution
- balance and portfolio reads

## OpenClaw Integration

The hackathon Builder Hub explicitly allows OpenClaw or any similar framework that supports file-based instructions or MCP.

Nexus ships:
- [SKILL.md](/Users/apple/tether-hackathon/nexus/SKILL.md) for file-based OpenClaw skill loading
- an MCP server via `npm run mcp`

This keeps Nexus aligned with the hackathon’s “OpenClaw or similar” requirement without making OpenClaw the main product surface.

## Treasury Policy

Each user has a persisted treasury policy.

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

Policy is visible and editable in the web dashboard for authenticated users.

## Signals and Regime Logic

Nexus uses multiple external signals to decide posture:

- Bitfinex price data for on-chain asset valuation inputs
- `Alternative.me` Crypto Fear & Greed Index
- gold spot feeds with `XAUt` fallback

High-level posture:
- **Risk-off**: protect reserve and increase `XAUt`
- **Neutral**: preserve reserve and avoid unnecessary churn
- **Risk-on**: trim defensive `XAUt` excess and deploy eligible idle `USDt` to Aave

## Security and Guardrails

- Autonomous treasury actions route through the coordinator/risk path
- `NexusGuard` supplies on-chain pause, limit, and cooldown inputs
- Central cooldown enforcement is applied in the risk layer
- x402 operational payments are capped, whitelist-only, and recorded in the same spend ledger
- Heartbeat state tracks autopilot freshness and source health

### Important distinction

Autonomous system actors require live guard data. If the on-chain guard is unavailable, autonomous treasury actions should be treated as blocked. Manual user-initiated flows still rely on app-side controls and the current execution model described above.

## Demo and Judge Experience

Nexus includes:
- **wallet-signature sign-in** for real user identity
- **read-only demo mode** via `GET /api/demo/state`
- **dashboard state** with policy, receipts, reasoning, and heartbeat

Recommended judge flow:
1. open the dashboard
2. inspect the demo treasury state
3. review policy bands, receipts, reasoning, and x402 activity
4. watch the demo video for funded end-to-end execution

## Recording The Demo

Use this flow to keep the demo simple and repeatable:

1. Start Nexus locally with a funded strategy environment.
2. Open the dashboard and switch to **Judge Demo** to verify the read-only surface is populated.
3. Reconnect your wallet and switch to **My Treasury** for the funded execution flow.
4. Show:
   - dashboard state
   - policy controls
   - health / heartbeat state
   - a treasury action and its resulting receipt
5. Sign out again and show that **Judge Demo** remains safe and inspectable without authentication.

The public demo surface is intentionally read-only. Operator-only demo mutation routes require a wallet-authenticated session or access token.

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
- `GET /api/policy`
- `PUT /api/policy`
- `GET /api/rules`
- `POST /api/rules`
- `DELETE /api/rules/:id`
- `GET /api/tx-log`
- `GET /api/premium/market-intel`
- `POST /api/demo` operator-only demo scenario trigger

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

See [.env.example](/Users/apple/tether-hackathon/nexus/.env.example) for the current full list.

## Testing

```bash
npm test
npm run build
```

The repository currently includes unit and service-level tests around:
- auth challenge / verify flow
- treasury policy support modules
- heartbeat degradation
- x402 autonomous payment validation
- bridge recipient validation
- cooldown helper behavior

It does **not** yet include a full live WDK integration test suite against funded accounts.

## Known Limitations

These limitations are current, intentional, and important:

1. **Execution authority**: wallet login authenticates the user, but autonomous execution still uses WDK-managed strategy accounts derived from the server seed.
2. **Public-surface hardening**: some demo and diagnostics routes are still more permissive than a production internet-facing deployment should be.
3. **Bridge scope**: bridge support is limited to the currently wired USDT0 path and supported EVM chains.
4. **Data dependency risk**: regime posture relies on external market data and degrades when those inputs are stale or unavailable.
5. **No full production test harness yet**: tests are meaningful, but capital deployment should still be treated cautiously until live funded integration coverage is expanded.

## Deployment Notes

- Persistent storage is required for SQLite state.
- The autopilot loop expects a continuously running process.
- A funded operator / strategy environment is required for autonomous execution.
- Lock down demo and diagnostic routes before public internet deployment.

## License

Apache-2.0
