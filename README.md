# MethaTech CLI

Chat with MethaTech models from your terminal. Black + lime, Node.js + npm only.

## Install (local, not published yet)

```sh
npm install
npm run build
node dist/cli.js --help
# or: npm link   (then `metatech` works globally)
```

Requires Node.js 20+.

## Login

```sh
metatech login
```

1. The CLI prints the login URL (`https://console.methatech.eu.org/login`)
   and tries to open it in your browser. Sign in and pick your account.
2. Open the token page (`https://console.methatech.eu.org/panel/token`),
   copy an API key, and paste it into the CLI (input is masked).
3. The key is saved to `~/.config/metatech/credentials.json` (0600, dir 0700).

The panel does not have a device-code/polling endpoint yet, so this phase
uses manual key paste. A full browser login + polling flow is a separate
panel follow-up. You can also use the env var instead:

```sh
export METATECH_API_KEY="sk-..."
```

## Commands

| Command | What it does |
|---|---|
| `metatech` (no args) | Chat TUI with the default model |
| `metatech chat [--model <id>]` | Chat TUI |
| `metatech models` | Model list: FREE $0.00 section + paid prices in $/1M |
| `metatech account` | Spending limit, used, balance (all $) |
| `metatech keys` | How to manage API keys in the panel |
| `metatech topup` | Open the top-up page |
| `metatech logout` | Delete the saved key |

Chat keys: `Enter` send · `↑↓` change model · `/models` list · `/model <id>`
switch · `/clear` clear · `/help` help · `/exit` quit · `Ctrl+C` quit.

## Prices

All prices are in dollars. The model list is fetched live from the panel
(`/api/available_model`, $ = ratio × 2). If the server cannot be reached,
a compiled-in price table (2026-11-08) is used. The 10 FREE models are
always listed first at $0.00 — they run on your free credits.

## Config

- `~/.config/metatech/credentials.json` — API key + last used model
  (override dir with `METATECH_CONFIG_DIR`)
- `METATECH_API_KEY` — env var takes precedence over the file
- `METATECH_API_BASE` (default `https://api.methatech.eu.org`) and
  `METATECH_CONSOLE_BASE` (default `https://console.methatech.eu.org`)
  — override for local testing

## Not built yet (later phases)

- Agent coding mode (file tools, run commands, confirm before dangerous ones)
- Full browser login + polling (needs a panel device-code endpoint)
- npm publish (`@methatech-cli/cli`) — PUBLISHED live 2026-11-08 as v0.1.1, `npm install -g @methatech-cli/cli`
