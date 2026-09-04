# Binance Stablecoin Route Engine

A Binance Agent OS Track A application for comparing stablecoin conversion routes. Enter the source asset, destination asset, amount, and risk limits, and the application retrieves live Binance spot trading rules, order-book depth, 24-hour market data, and Binance Convert quotes to identify the best eligible route.

## Features

- Automatically discovers direct and two-leg stablecoin routes
- Walks the order book level by level to calculate executable size, average price, and slippage
- Applies user-defined spot fees and current Binance trading rules
- Produces deterministic `PASS`, `WARN`, or `BLOCK` decisions
- Connects to the Binance API with credentials held only in server memory
- Displays the available balances of the selected source and destination assets
- Refreshes live data and generates a short-lived conversion ticket after a route passes all checks
- Requires the exact confirmation phrase `CONFIRM` before a live conversion
- Queries the actual order status after accepting a Binance Convert quote

All market data and live conversions use the official Binance agent toolchain. The API configuration interface is included in the project, but user-supplied API keys and secrets remain only in the local server process. They are never written to browser storage, files, logs, or GitHub.

## Getting Started

### Requirements

- Node.js 20 or later
- A Binance API key with read and spot trading permissions
- Withdrawal permission disabled

Install dependencies, run the test suite, and start the application:

```bash
npm install
npm test
npm start
```

Open `http://localhost:4747` in a browser.

Select **Configure API** in the upper-right corner and enter your Binance API key and secret. Restrict the key to trusted IP addresses whenever possible. Credentials are automatically cleared when the server restarts.

To run a read-only route analysis from the command line:

```bash
npm run analyze -- USDT USDC 1000
```

## Data Pipeline

Spot routes use the following Binance Agent OS tools:

- `spot.ticker-price`
- `spot.exchange-info`
- `spot.depth`
- `spot.ticker24hr`

Binance Convert routes use the official `@binance/binance-cli` agent skill:

- `convert.sendQuoteRequest`
- `convert.acceptQuote`
- `convert.orderStatus`

## Safety Controls

- Route scanning never creates an order.
- Multi-leg spot orders are not executed, preventing partial completion between legs.
- Only an eligible Binance Convert route that remains optimal may generate a conversion ticket.
- Market data, quotes, and local rules are refreshed after user confirmation; execution is canceled if any limit is exceeded.
- Every ticket is single-use and expires after three minutes.
- API credentials are redacted from errors and are never persisted.

## License

MIT
