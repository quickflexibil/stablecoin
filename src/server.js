import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyze } from "./engine.js";
import { AgentOsError, fetchSpotRoutes } from "./agent-os.js";
import {
  BinanceApiError,
  acceptConvertQuote,
  clearCredentials,
  configureCredentials,
  connectionStatus,
  getAssetBalances,
  requestConvertQuote,
} from "./api-convert.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.ROUTE_GUARD_PORT || 8811);
const HOST = process.env.ROUTE_GUARD_HOST || "127.0.0.1";
const MAX_BODY = 64 * 1024;
const TICKET_TTL_MS = 180_000;
const tickets = new Map();
const types = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
};

function number(value, label, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) throw new Error(`${label}不能小于 ${minimum}`);
  return parsed;
}

export function cleanIntent(raw = {}) {
  const fromAsset = String(raw.fromAsset || "USDT").trim().toUpperCase();
  const toAsset = String(raw.toAsset || "USDC").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(fromAsset) || !/^[A-Z0-9]{2,12}$/.test(toAsset)) throw new Error("资产代码格式无效");
  if (fromAsset === toAsset) throw new Error("转出和转入资产不能相同");
  return {
    fromAsset,
    toAsset,
    amount: number(raw.amount, "兑换金额", 0.00000001),
    maxCostBps: number(raw.maxCostBps ?? 20, "最大综合成本"),
    maxPegBps: number(raw.maxPegBps ?? 50, "最大偏离"),
    feeBps: number(raw.feeBps ?? 10, "现货费率"),
    allowVolatile: Boolean(raw.allowVolatile),
    includeConvert: raw.includeConvert !== false,
  };
}

async function buildReport(intent, { requireConvert = false, freshMarket = false, quoteAfterMarket = false } = {}) {
  const marketPromise = fetchSpotRoutes({ ...intent, fresh: freshMarket });
  const loadConvert = () => intent.includeConvert
    ? (async () => {
      const status = await connectionStatus();
      if (!status.configured || !status.enabled) throw new BinanceApiError("配置 Binance API 后可加入币安闪兑实时报价");
      return requestConvertQuote(intent.fromAsset, intent.toAsset, String(intent.amount));
    })()
    : Promise.resolve(null);
  const settleConvert = () => loadConvert().then(
      (quote) => ({ quote, error: null }),
      (error) => ({ quote: null, error }),
    );
  const [market, convertResult] = quoteAfterMarket
    ? [await marketPromise, await settleConvert()]
    : await Promise.all([marketPromise, settleConvert()]);
  if (requireConvert && convertResult.error) throw convertResult.error;

  const routes = [...market.routes];
  const convertQuote = convertResult.quote;
  const convertError = convertResult.error?.message || "";
  const agentOsVerified = Boolean(convertQuote);
  if (convertQuote) {
    routes.push({
      id: "binance-convert", label: "币安闪兑", kind: "CONVERT",
      assets: [intent.fromAsset, intent.toAsset], fixedOutput: convertQuote.toAmount,
      quoteValidTimestamp: convertQuote.validTimestamp,
    });
  }
  const report = analyze({ ...intent, ...market, routes });
  return { report, convertQuote, convertError, agentOsVerified };
}

function sweepTickets() {
  const now = Date.now();
  for (const [id, ticket] of tickets) if (now > ticket.expiresAt) tickets.delete(id);
}

export function ticketMinimumOutput(intent, report) {
  return Math.max(
    report.selectedOutput * (1 - intent.maxCostBps / 10_000),
    intent.amount * (1 - intent.maxCostBps / 10_000),
    intent.amount * (1 - intent.maxPegBps / 10_000),
  );
}

async function prepareTicket(intent) {
  const result = await buildReport(intent, {
    requireConvert: true,
    freshMarket: true,
    quoteAfterMarket: true,
  });
  if (result.report.decision !== "PASS") throw new Error(`当前结果为 ${result.report.decision}，不能生成兑换票据`);
  if (result.report.selectedKind !== "CONVERT") throw new Error("当前最优路线是现货路径；本应用只直接执行单笔币安闪兑，避免多腿部分成交风险");
  const ticketId = crypto.randomUUID();
  const ticket = {
    ticketId,
    fromAsset: intent.fromAsset,
    toAsset: intent.toAsset,
    fromAmount: String(intent.amount),
    minimumOutput: ticketMinimumOutput(intent, result.report),
    expiresAt: Date.now() + TICKET_TTL_MS,
    intent,
  };
  sweepTickets();
  tickets.clear();
  tickets.set(ticketId, ticket);
  return {
    report: result.report,
    ticket: {
      ticketId, fromAsset: ticket.fromAsset, toAsset: ticket.toAsset,
      fromAmount: ticket.fromAmount, minimumOutput: ticket.minimumOutput,
      expiresAt: ticket.expiresAt,
      tool: "convert.acceptQuote",
    },
  };
}

async function executeTicket(raw) {
  if (raw.confirmation !== "CONFIRM") throw new Error("请输入精确的 CONFIRM");
  const ticketId = String(raw.ticketId || "");
  const ticket = tickets.get(ticketId);
  if (!ticket) throw new Error("兑换票据不存在，请重新生成");
  if (Date.now() > ticket.expiresAt) {
    tickets.delete(ticketId);
    throw new Error("兑换票据已过期，请重新生成");
  }

  const refreshed = await buildReport(ticket.intent, {
    requireConvert: true,
    freshMarket: true,
    quoteAfterMarket: true,
  });
  if (refreshed.report.decision !== "PASS" || refreshed.report.selectedKind !== "CONVERT") {
    throw new Error("刷新后币安闪兑已不是合格的最优路线，交易已取消");
  }
  if (Number(refreshed.convertQuote.toAmount) < ticket.minimumOutput) {
    throw new Error("刷新后的到账金额低于票据限制，交易已取消");
  }
  if (refreshed.convertQuote.validTimestamp && refreshed.convertQuote.validTimestamp <= Date.now() + 1500) {
    throw new Error("币安闪兑报价剩余时间不足，交易已取消");
  }
  if (Date.now() > ticket.expiresAt) {
    tickets.delete(ticketId);
    throw new Error("刷新期间兑换票据已过期，请重新生成");
  }
  // The ticket remains retryable while all operations are read-only. Consume it
  // immediately before the first and only write so an uncertain write can never be retried.
  tickets.delete(ticketId);
  const execution = await acceptConvertQuote(refreshed.convertQuote.quoteId);
  return {
    report: refreshed.report,
    order: execution.order,
    submitted: execution.submitted,
    statusPending: execution.statusPending,
    checkedAt: new Date().toISOString(),
  };
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function loopbackHostname(value) {
  try {
    const hostname = new URL(`http://${value}`).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch { return false; }
}

export function isLocalRequest(req) {
  if (!loopbackHostname(req.headers.host || "")) return false;
  if (!req.headers.origin) return true;
  try {
    const origin = new URL(req.headers.origin);
    return loopbackHostname(origin.host);
  } catch { return false; }
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_BODY) throw new Error("请求内容过大");
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error("请求 JSON 无效"); }
}

async function serveStatic(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
  const relative = pathname === "/" ? "index.html" : normalize(pathname).replace(/^\/+/, "");
  if (relative.startsWith("..")) return res.writeHead(404).end("Not found");
  try {
    const content = await readFile(join(PUBLIC, relative));
    res.writeHead(200, { "content-type": types[extname(relative)] || "application/octet-stream" });
    res.end(content);
  } catch { res.writeHead(404).end("Not found"); }
}

export function createAppServer() {
  return createServer(async (req, res) => {
    try {
      if (!isLocalRequest(req)) return json(res, 403, { ok: false, error: "拒绝非本机请求" });
      const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const pathname = requestUrl.pathname;
      if (req.method === "GET" && pathname === "/api/health") return json(res, 200, { ok: true });
      if (req.method === "GET" && pathname === "/api/state") {
        return json(res, 200, { ok: true, agentOs: connectionStatus() });
      }
      if (req.method === "GET" && pathname === "/api/balances") {
        const assets = String(requestUrl.searchParams.get("assets") || "").split(",").filter(Boolean);
        return json(res, 200, { ok: true, balances: await getAssetBalances(assets) });
      }
      if (req.method === "POST" && pathname === "/api/connect") {
        return json(res, 200, { ok: true, agentOs: await configureCredentials(await body(req)) });
      }
      if (req.method === "POST" && pathname === "/api/disconnect") {
        return json(res, 200, { ok: true, agentOs: clearCredentials() });
      }
      if (req.method === "POST" && pathname === "/api/scan") {
        const intent = cleanIntent(await body(req));
        return json(res, 200, { ok: true, ...(await buildReport(intent)) });
      }
      if (req.method === "POST" && pathname === "/api/ticket") {
        const intent = cleanIntent(await body(req));
        return json(res, 200, { ok: true, ...(await prepareTicket(intent)) });
      }
      if (req.method === "POST" && pathname === "/api/execute") {
        return json(res, 200, { ok: true, ...(await executeTicket(await body(req))) });
      }
      if (req.method === "GET") return serveStatic(req, res);
      return json(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      const status = error instanceof AgentOsError || error instanceof BinanceApiError ? 502 : 400;
      return json(res, status, {
        ok: false,
        error: error.message || "请求失败",
        ...(error.uncertain ? { uncertain: true } : {}),
      });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createAppServer().listen(PORT, HOST, () => console.log(`Stablecoin Route Agent http://${HOST}:${PORT}`));
}
