import test from "node:test";
import assert from "node:assert/strict";
import { cleanIntent, isLocalRequest, ticketMinimumOutput } from "../src/server.js";

test("normalizes a route request", () => {
  const result = cleanIntent({ fromAsset: "usdt", toAsset: "usdc", amount: "500" });
  assert.equal(result.fromAsset, "USDT");
  assert.equal(result.amount, 500);
  assert.equal(result.includeConvert, true);
});

test("rejects identical assets", () => {
  assert.throws(() => cleanIntent({ fromAsset: "USDT", toAsset: "USDT", amount: 10 }), /不能相同/);
});

test("rejects negative policies", () => {
  assert.throws(() => cleanIntent({ fromAsset: "USDT", toAsset: "USDC", amount: 10, maxCostBps: -1 }), /不能小于/);
});

test("ticket minimum never weakens configured cost or peg limits", () => {
  const intent = cleanIntent({ fromAsset: "USDT", toAsset: "USDC", amount: 1, maxCostBps: 100, maxPegBps: 50 });
  const floor = ticketMinimumOutput(intent, { selectedOutput: 0.9998 });
  assert.equal(floor, 0.995);
});

test("accepts only loopback browser requests", () => {
  assert.equal(isLocalRequest({ headers: { host: "127.0.0.1:4747" } }), true);
  assert.equal(isLocalRequest({
    headers: { host: "localhost:4747", origin: "http://localhost:4747" },
  }), true);
  assert.equal(isLocalRequest({
    headers: { host: "evil.example", origin: "https://evil.example" },
  }), false);
  assert.equal(isLocalRequest({
    headers: { host: "127.0.0.1:4747", origin: "https://evil.example" },
  }), false);
});
