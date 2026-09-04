# Stablecoin

Compare stablecoin conversion routes before using Binance Convert. The app reads live Binance market data, ranks eligible routes, and shows the expected output, cost, and liquidity checks.

Built for Binance Agent OS Track A.

## Run

```bash
npm install
npm test
npm start
```

Open `http://localhost:4747` in a browser.

For a read-only command-line scan:

```bash
npm run analyze -- USDT USDC 1000
```

## Use

1. Choose the source asset, destination asset, and amount.
2. Set the maximum cost and peg-deviation limits.
3. Scan the available spot and Convert routes.
4. Connect a Binance API key only when you want to execute the selected Convert route.

API credentials stay in server memory and are cleared on restart. Use read and spot-trading permissions only; never enable withdrawals.

Market reads use Binance Agent OS spot tools. Live conversion uses the official Binance Convert quote, accept, and order-status tools.
