import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the ticket close control cannot submit a conversion", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(html, /id="closeTicketButton"\s+type="button"/);
  assert.match(html, /id="ticketButton"[^>]*>立即兑换<\/button>/);
  assert.match(html, /<h2>确认闪兑<\/h2>/);
  assert.doesNotMatch(html, /id="ticketTo"/);
  assert.match(html, /<dt>票据有效<\/dt>/);
  assert.match(app, /closeTicketButton"\)\.addEventListener\("click", \(\) => dialog\.close\(\)\)/);
});

test("the API configuration stays out of browser storage and clears secret fields", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(html, /id="apiKey" type="password"/);
  assert.match(html, /id="apiSecret" type="password"/);
  assert.match(html, /id="fromBalance">可用 —<\/small>/);
  assert.match(html, /id="toBalance">可用 —<\/small>/);
  assert.match(app, /api\("\/api\/connect"/);
  assert.match(app, /\/api\/balances\?assets=/);
  assert.doesNotMatch(app, /localStorage\.setItem\([^)]*(?:apiKey|apiSecret)/i);
  assert.match(app, /\$\("#apiSecret"\)\.value = ""/);
});

test("Convert results are rendered in Chinese instead of raw exchange codes", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /return "兑换成功"/);
  assert.match(app, /return "兑换失败"/);
  assert.match(app, /return "兑换处理中"/);
  assert.match(app, /return "兑换已提交，状态待确认"/);
  assert.doesNotMatch(app, /兑换状态：\$\{status\}/);
});

test("scan and execution failures cannot reuse stale UI state", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const scan = app.slice(app.indexOf("async function scan("), app.indexOf("async function handleAuth("));
  const execute = app.slice(app.indexOf("async function executeTicket("), app.indexOf("form.addEventListener("));

  assert.match(app, /function invalidateReport\(\)[\s\S]*currentReport = null;\s*ticketButton\.hidden = true;[\s\S]*selectedRoute[\s\S]*routeRows/);
  assert.match(scan, /invalidateReport\(\);\s*const request = scanRequest;/);
  assert.match(scan, /if \(request !== scanRequest\) return false;/);
  assert.match(scan, /if \(request === scanRequest\) setBusy\(false\)/);
  assert.match(execute, /const confirmation = \$\("#confirmation"\)\.value;\s*\$\("#confirmation"\)\.value = "";/);
  assert.match(execute, /scan\(\{ showError: false \}\)/);
  assert.match(execute, /if \(error\.uncertain\) \{\s*dialog\.close\(\);/);
  assert.match(execute, /兑换结果待确认，请到币安闪兑记录核实/);
});
