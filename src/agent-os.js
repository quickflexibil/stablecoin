import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STABLE_HUBS = ["USDT", "USDC", "FDUSD", "TUSD"];
const VOLATILE_HUBS = ["BTC", "BNB", "ETH"];
let directoryCache = null;
let directoryCacheAt = 0;
const rulesCache = new Map();

export class AgentOsError extends Error {}

async function cliPath() {
  const configured = String(process.env.BINANCE_CLI || "").trim();
  const local = join(ROOT, "node_modules", ".bin", "binance-cli");
  for (const candidate of [configured, local]) {
    if (!candidate) continue;
    try { await access(candidate); return candidate; } catch {}
  }
  return "binance-cli";
}

export async function runCli(product, command, arguments_ = {}, timeout = 40_000) {
  const argv = [product, command];
  for (const [key, raw] of Object.entries(arguments_)) {
    if (raw === undefined || raw === null || raw === "") continue;
    argv.push(`--${key}`, String(raw));
  }
  try {
    const { stdout } = await execute(await cliPath(), argv, {
      cwd: ROOT, timeout, maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const message = String(error?.stderr || error?.stdout || error?.message || "调用失败").trim();
    if (message.includes("Request failed after 3 retries")) throw new AgentOsError("Binance Agent OS 网络请求失败");
    if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new AgentOsError("Binance Agent OS 行情响应超过安全上限");
    if (error?.code === "ENOENT") throw new AgentOsError("Binance Agent OS CLI 未安装，请先运行 npm install");
    throw new AgentOsError(`Binance Agent OS ${product}.${command}：${message.split("\n").at(-1)?.slice(0, 180)}`);
  }
}

async function availableSymbols(fresh = false) {
  if (!fresh && directoryCache && Date.now() - directoryCacheAt < 60_000) {
    return { symbols: directoryCache, toolCalls: [] };
  }
  const payload = await runCli("spot", "ticker-price");
  if (!Array.isArray(payload)) throw new AgentOsError("Binance Agent OS 返回了无效交易对目录");
  directoryCache = new Set(payload.map((row) => row?.symbol).filter(Boolean));
  directoryCacheAt = Date.now();
  return { symbols: directoryCache, toolCalls: ["spot.ticker-price"] };
}

async function exchangeRows(symbols, fresh = false) {
  const missing = symbols.filter((symbol) => {
    if (fresh) return true;
    const cached = rulesCache.get(symbol);
    return !cached || Date.now() - cached.at >= 15 * 60_000;
  });
  await Promise.all(missing.map(async (symbol) => {
    const payload = await runCli("spot", "exchange-info", { symbol, "show-permission-sets": false });
    const row = payload?.symbols?.[0];
    if (!row) throw new AgentOsError(`Binance Agent OS 没有返回 ${symbol} 的交易规则`);
    rulesCache.set(symbol, { at: Date.now(), row });
  }));
  return {
    rows: symbols.map((symbol) => rulesCache.get(symbol)?.row).filter(Boolean),
    toolCalls: missing.map((symbol) => `spot.exchange-info(${symbol})`),
  };
}

function symbolIndex(payload) {
  return new Map(payload.symbols
    .filter((row) => row?.status === "TRADING" && row?.isSpotTradingAllowed !== false)
    .map((row) => [row.symbol, row]));
}

function rulesFor(row) {
  const filters = new Map((row.filters || []).map((value) => [value.filterType, value]));
  const lot = filters.get("MARKET_LOT_SIZE")?.minQty !== "0.00000000"
    ? filters.get("MARKET_LOT_SIZE")
    : filters.get("LOT_SIZE");
  const notional = filters.get("NOTIONAL") || filters.get("MIN_NOTIONAL") || {};
  return {
    minQty: String(lot?.minQty || "0"),
    maxQty: String(lot?.maxQty || "0"),
    stepSize: String(lot?.stepSize || "0"),
    minNotional: String(notional.minNotional || "0"),
  };
}

export function resolveLeg(index, fromAsset, toAsset) {
  const direct = index.get(`${fromAsset}${toAsset}`);
  if (direct) {
    return {
      symbol: direct.symbol, side: "SELL", fromAsset, toAsset,
      baseAsset: direct.baseAsset, quoteAsset: direct.quoteAsset, rules: rulesFor(direct),
    };
  }
  const inverse = index.get(`${toAsset}${fromAsset}`);
  if (inverse) {
    return {
      symbol: inverse.symbol, side: "BUY", fromAsset, toAsset,
      baseAsset: inverse.baseAsset, quoteAsset: inverse.quoteAsset, rules: rulesFor(inverse),
    };
  }
  return null;
}

export function discoverRoutes(index, fromAsset, toAsset, allowVolatile = false) {
  const hubs = [...STABLE_HUBS, ...(allowVolatile ? VOLATILE_HUBS : [])]
    .filter((asset) => asset !== fromAsset && asset !== toAsset);
  const candidates = [[fromAsset, toAsset], ...hubs.map((hub) => [fromAsset, hub, toAsset])];
  return candidates.flatMap((assets) => {
    const legs = [];
    for (let position = 0; position < assets.length - 1; position += 1) {
      const leg = resolveLeg(index, assets[position], assets[position + 1]);
      if (!leg) return [];
      legs.push(leg);
    }
    return [{
      id: assets.join("-"), label: assets.join(" → "), kind: "SPOT",
      assets, legs, volatile: assets.some((asset) => VOLATILE_HUBS.includes(asset)),
    }];
  });
}

function cleanAsset(value) {
  const asset = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(asset)) throw new Error("资产代码格式无效");
  return asset;
}

export async function fetchSpotRoutes({ fromAsset, toAsset, allowVolatile = false, fresh = false }) {
  const from = cleanAsset(fromAsset);
  const to = cleanAsset(toAsset);
  if (from === to) throw new Error("转出和转入资产不能相同");
  const directoryResult = await availableSymbols(fresh);
  const directory = directoryResult.symbols;
  const hubs = [...STABLE_HUBS, ...(allowVolatile ? VOLATILE_HUBS : [])]
    .filter((asset) => asset !== from && asset !== to);
  const paths = [[from, to], ...hubs.map((hub) => [from, hub, to])];
  const symbols = [...new Set(paths.flatMap((assets) => assets.slice(0, -1).flatMap((asset, position) => {
    const next = assets[position + 1];
    if (directory.has(`${asset}${next}`)) return [`${asset}${next}`];
    if (directory.has(`${next}${asset}`)) return [`${next}${asset}`];
    return [];
  })))];
  const exchangeResult = await exchangeRows(symbols, fresh);
  const payload = { symbols: exchangeResult.rows };
  const index = symbolIndex(payload);
  const routes = discoverRoutes(index, from, to, Boolean(allowVolatile));
  if (routes.length === 0) throw new AgentOsError(`${from} 与 ${to} 之间没有可用现货路线`);

  const routeSymbols = [...new Set(routes.flatMap((route) => route.legs.map((leg) => leg.symbol)))];
  const snapshots = new Map(await Promise.all(routeSymbols.map(async (symbol) => {
    const [depth, ticker] = await Promise.all([
      runCli("spot", "depth", { symbol, limit: 100 }),
      runCli("spot", "ticker24hr", { symbol }),
    ]);
    return [symbol, { depth, ticker }];
  })));

  const hydrated = routes.map((route) => ({
    ...route,
    legs: route.legs.map((leg) => {
      const snapshot = snapshots.get(leg.symbol);
      return {
        ...leg,
        bids: snapshot?.depth?.bids || [],
        asks: snapshot?.depth?.asks || [],
        quoteVolume24h: String(snapshot?.ticker?.quoteVolume || "0"),
      };
    }),
  }));

  return {
    fromAsset: from,
    toAsset: to,
    routes: hydrated,
    timestamp: new Date().toISOString(),
    source: {
      provider: "Binance Agent OS",
      adapter: "@binance/binance-cli",
      mode: "live",
      toolCalls: [
        ...directoryResult.toolCalls,
        ...exchangeResult.toolCalls,
        ...routeSymbols.flatMap((symbol) => [`spot.depth(${symbol})`, `spot.ticker24hr(${symbol})`]),
      ],
    },
  };
}

export const internals = { rulesFor, symbolIndex };
