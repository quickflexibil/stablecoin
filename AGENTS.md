# Binance Stablecoin Route Agent

Use Binance Agent OS to compare live stablecoin conversion routes and guard a single Binance Convert execution.

1. Read current Spot symbol availability, `exchangeInfo`, order-book depth, and 24-hour ticker data for every route leg.
2. Walk every order book deterministically, apply exchange minimums, configured fees, depth, cost, and peg-deviation controls.
3. Include authenticated Binance Convert quotes only through the official `@binance/binance-cli` Agent skill.
4. Accept API credentials only through the local configuration form or process environment. Keep them in process memory, never store, log, return, or commit them.
5. Never execute multi-leg Spot routes.
6. Only a PASS report whose selected route is Binance Convert may create a short-lived ticket.
7. Require the user to type exactly `CONFIRM` immediately before accepting the quote.
8. After confirmation, refresh all route data and the Convert quote through the deterministic local engine. Cancel if the decision, selected route, amount, or minimum output no longer matches.
9. Accept one quote once, query its status, and never retry an uncertain write.
