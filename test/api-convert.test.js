import assert from "node:assert/strict";
import test from "node:test";
import { acceptConvertQuote, internals } from "../src/api-convert.js";

test("validates API credentials without returning or persisting them", () => {
  const value = internals.cleanCredentials({ apiKey: "A".repeat(64), apiSecret: "B".repeat(64) });
  assert.equal(value.apiKey.length, 64);
  assert.equal(value.apiSecret.length, 64);
  assert.throws(() => internals.cleanCredentials({ apiKey: "short", apiSecret: "short" }), /格式无效/);
});

test("validates Convert inputs and identifiers", () => {
  assert.equal(internals.cleanAsset("usdt"), "USDT");
  assert.equal(internals.cleanAmount("1.25"), "1.25");
  assert.equal(internals.cleanId("quote_123-ABC", "报价编号"), "quote_123-ABC");
  assert.throws(() => internals.cleanId("bad id", "报价编号"), /无效/);
});

test("redacts credentials and signatures from CLI errors", () => {
  const auth = { apiKey: "A".repeat(64), apiSecret: "B".repeat(64) };
  const detail = internals.safeDetail(`request failed ${auth.apiKey} ${auth.apiSecret} signature=abcdef1234`, auth);
  assert.doesNotMatch(detail, /A{16}|B{16}|abcdef1234/);
  assert.match(detail, /\[redacted\]/);
});

test("requires read and spot trading permissions", () => {
  assert.equal(internals.validatePermissions({
    enableReading: true,
    enableSpotAndMarginTrading: true,
  }), true);
  assert.throws(() => internals.validatePermissions({
    enableReading: false,
    enableSpotAndMarginTrading: true,
  }), /读取权限/);
  assert.throws(() => internals.validatePermissions({
    enableReading: true,
    enableSpotAndMarginTrading: false,
  }), /现货与闪兑交易权限/);
  assert.throws(() => internals.validatePermissions({
    enableReading: true,
    enableSpotAndMarginTrading: true,
    enableWithdrawals: true,
  }), /关闭提现权限/);
});

test("reports a submitted conversion when status lookup fails after acceptance", async () => {
  const call = async (_product, command) => {
    if (command === "accept-quote") return { orderId: "order-1", orderStatus: "ACCEPT_SUCCESS" };
    throw new Error("status unavailable");
  };
  const result = await acceptConvertQuote("quote-1", call);
  assert.equal(result.submitted, true);
  assert.equal(result.statusPending, true);
  assert.equal(result.order.orderStatus, "ACCEPT_SUCCESS");
});

test("marks the result uncertain when acceptance and status lookup both fail", async () => {
  const call = async () => { throw new Error("network unavailable"); };
  await assert.rejects(
    acceptConvertQuote("quote-2", call),
    (error) => error.uncertain === true && /结果不确定/.test(error.message),
  );
});

test("treats canceled conversion orders as failed", async () => {
  const call = async (_product, command) => command === "accept-quote"
    ? { orderId: "order-2", orderStatus: "ACCEPT_SUCCESS" }
    : { orderId: "order-2", orderStatus: "CANCELED" };
  const result = await acceptConvertQuote("quote-3", call);
  assert.equal(result.submitted, false);
  assert.equal(result.statusPending, false);
});
