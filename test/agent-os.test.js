import test from "node:test";
import assert from "node:assert/strict";
import { discoverRoutes, internals, resolveLeg } from "../src/agent-os.js";

function row(symbol, baseAsset, quoteAsset) {
  return {
    symbol, baseAsset, quoteAsset, status: "TRADING", isSpotTradingAllowed: true,
    filters: [
      { filterType: "LOT_SIZE", minQty: "1", maxQty: "100000", stepSize: "1" },
      { filterType: "NOTIONAL", minNotional: "5" },
    ],
  };
}

const index = internals.symbolIndex({ symbols: [
  row("USDCUSDT", "USDC", "USDT"),
  row("FDUSDUSDT", "FDUSD", "USDT"),
  row("FDUSDUSDC", "FDUSD", "USDC"),
] });

test("resolves an inverse symbol as a BUY leg", () => {
  const leg = resolveLeg(index, "USDT", "USDC");
  assert.equal(leg.symbol, "USDCUSDT");
  assert.equal(leg.side, "BUY");
  assert.equal(leg.rules.minNotional, "5");
});

test("discovers direct and stable two-leg routes", () => {
  const routes = discoverRoutes(index, "USDT", "USDC", false);
  assert.deepEqual(routes.map((route) => route.label), ["USDT → USDC", "USDT → FDUSD → USDC"]);
  assert.equal(routes.some((route) => route.volatile), false);
});
