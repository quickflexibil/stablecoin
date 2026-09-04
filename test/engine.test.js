import test from "node:test";
import assert from "node:assert/strict";
import { analyze, fillBuy, fillSell } from "../src/engine.js";

const rules = { minNotional: "5", minQty: "0.01" };
const direct = {
  id: "USDT-USDC",
  label: "USDT → USDC",
  kind: "SPOT",
  assets: ["USDT", "USDC"],
  legs: [{
    symbol: "USDCUSDT", side: "BUY", fromAsset: "USDT", toAsset: "USDC",
    asks: [["1.0001", "600"], ["1.0002", "600"]], bids: [], rules,
  }],
};

test("walks multiple ask levels using quote amount", () => {
  const result = fillBuy(1000, [[1, 400], [1.001, 700]]);
  assert.equal(result.filled, true);
  assert.ok(result.averagePrice > 1);
  assert.ok(result.output > 998);
});

test("walks multiple bid levels using base amount", () => {
  const result = fillSell(1000, [[1, 400], [0.999, 700]]);
  assert.equal(result.filled, true);
  assert.ok(result.output > 999);
});

test("selects the highest-output eligible route", () => {
  const result = analyze({
    fromAsset: "USDT", toAsset: "USDC", amount: 1000,
    maxCostBps: 30, maxPegBps: 30, feeBps: 1,
    routes: [direct, { id: "convert", label: "Binance Convert", kind: "CONVERT", fixedOutput: "999.95" }],
  });
  assert.equal(result.decision, "PASS");
  assert.equal(result.selectedRouteId, "convert");
  assert.equal(result.selectedKind, "CONVERT");
});

test("blocks when order-book depth cannot fill", () => {
  const shallow = structuredClone(direct);
  shallow.legs[0].asks = [["1", "2"]];
  const result = analyze({
    fromAsset: "USDT", toAsset: "USDC", amount: 1000,
    maxCostBps: 30, maxPegBps: 30, feeBps: 1, routes: [shallow],
  });
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.routes[0].controls.completeFill, false);
});

test("blocks a route below exchange minimums", () => {
  const result = analyze({
    fromAsset: "USDT", toAsset: "USDC", amount: 1,
    maxCostBps: 100, maxPegBps: 100, feeBps: 0, routes: [direct],
  });
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.routes[0].controls.exchangeRules, false);
  assert.equal(result.routes[0].output, 0);
});

test("does not rank an intermediate asset as final output", () => {
  const twoLeg = {
    id: "two-leg", label: "USDT → FDUSD → USDC", kind: "SPOT",
    assets: ["USDT", "FDUSD", "USDC"],
    legs: [
      {
        symbol: "FDUSDUSDT", side: "BUY", fromAsset: "USDT", toAsset: "FDUSD",
        asks: [["1", "10"]], bids: [], rules: { minNotional: "0", minQty: "0", stepSize: "0" },
      },
      {
        symbol: "FDUSDUSDC", side: "SELL", fromAsset: "FDUSD", toAsset: "USDC",
        asks: [], bids: [["1", "10"]], rules: { minNotional: "0", minQty: "1", stepSize: "1" },
      },
    ],
  };
  const result = analyze({
    fromAsset: "USDT", toAsset: "USDC", amount: 0.5,
    maxCostBps: 100, maxPegBps: 100, feeBps: 0, routes: [twoLeg],
  });
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.routes[0].output, 0);
  assert.equal(result.routes[0].legs.length, 1);
});

test("blocks a route above the market maximum quantity", () => {
  const capped = structuredClone(direct);
  capped.legs[0].rules.maxQty = "5";
  const result = analyze({
    fromAsset: "USDT", toAsset: "USDC", amount: 10,
    maxCostBps: 100, maxPegBps: 100, feeBps: 0, routes: [capped],
  });
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.routes[0].controls.exchangeRules, false);
  assert.equal(result.routes[0].output, 0);
});

test("rejects invalid policies", () => {
  assert.throws(() => analyze({ amount: 0, routes: [] }), /兑换金额/);
});
