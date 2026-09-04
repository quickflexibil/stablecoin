import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let authorizationVerified = false;
let inMemoryCredentials = null;
let credentialsCleared = false;

export class BinanceApiError extends Error {
  constructor(message, { uncertain = false } = {}) {
    super(message);
    this.name = "BinanceApiError";
    this.uncertain = uncertain;
  }
}

async function cliPath() {
  const configured = String(process.env.BINANCE_CLI || "").trim();
  const local = join(ROOT, "node_modules", ".bin", "binance-cli");
  for (const candidate of [configured, local]) {
    if (!candidate) continue;
    try { await access(candidate); return candidate; } catch {}
  }
  return "binance-cli";
}

function credentials() {
  if (credentialsCleared) return null;
  const apiKey = String(inMemoryCredentials?.apiKey || process.env.BINANCE_API_KEY || "").trim();
  const apiSecret = String(inMemoryCredentials?.apiSecret || process.env.BINANCE_SECRET_KEY || "");
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret };
}

function cleanCredentials(raw = {}) {
  const apiKey = String(raw.apiKey || "").trim();
  const apiSecret = String(raw.apiSecret || "");
  if (apiKey.length < 16 || apiKey.length > 256 || /\s/.test(apiKey)) throw new BinanceApiError("API Key 格式无效");
  if (apiSecret.length < 16 || apiSecret.length > 8192) throw new BinanceApiError("API Secret 格式无效");
  return { apiKey, apiSecret };
}

function cleanAsset(value) {
  const asset = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(asset)) throw new BinanceApiError("资产代码格式无效");
  return asset;
}

function cleanAmount(value, label = "兑换金额") {
  const amount = String(value || "").trim();
  if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) throw new BinanceApiError(`${label}无效`);
  return amount;
}

function cleanId(value, label) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new BinanceApiError(`${label}无效`);
  return id;
}

function permissionEnabled(value) {
  return value === true || String(value).toLowerCase() === "true";
}

function validatePermissions(value) {
  if (!permissionEnabled(value?.enableReading)) throw new BinanceApiError("API 未开启读取权限");
  if (!permissionEnabled(value?.enableSpotAndMarginTrading)) {
    throw new BinanceApiError("API 未开启现货与闪兑交易权限");
  }
  if (permissionEnabled(value?.enableWithdrawals)) throw new BinanceApiError("API 必须关闭提现权限");
  return true;
}

function parseJson(output) {
  try { return JSON.parse(String(output)); }
  catch { throw new BinanceApiError("Binance API 返回了无效响应"); }
}

function safeDetail(value, auth) {
  return String(value || "Binance API 调用失败")
    .replaceAll(auth.apiKey, "[redacted]")
    .replaceAll(auth.apiSecret, "[redacted]")
    .replace(/signature=[A-Fa-f0-9]+/g, "signature=[redacted]")
    .replace(/X-MBX-APIKEY\s*[:=]\s*\S+/gi, "X-MBX-APIKEY=[redacted]")
    .trim()
    .split("\n")
    .at(-1)
    ?.slice(0, 220) || "Binance API 调用失败";
}

async function runPrivateCli(product, command, arguments_ = {}, timeout = 20_000) {
  const auth = credentials();
  if (!auth) throw new BinanceApiError("未配置 Binance API Key");
  const argv = [product, command];
  for (const [key, raw] of Object.entries(arguments_)) {
    if (raw === undefined || raw === null || raw === "") continue;
    argv.push(`--${key}`, String(raw));
  }
  let stdout;
  try {
    ({ stdout } = await execute(await cliPath(), argv, {
      cwd: ROOT,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        BINANCE_API_KEY: auth.apiKey,
        BINANCE_SECRET_KEY: auth.apiSecret,
        BINANCE_API_ENV: "prod",
      },
    }));
  } catch (error) {
    authorizationVerified = false;
    throw new BinanceApiError(safeDetail(error?.stderr || error?.stdout || error?.message, auth));
  }
  try {
    const value = parseJson(stdout);
    authorizationVerified = true;
    return value;
  } catch {
    authorizationVerified = false;
    throw new BinanceApiError(safeDetail(stdout, auth));
  }
}

export async function configureCredentials(raw) {
  const next = cleanCredentials(raw);
  inMemoryCredentials = next;
  credentialsCleared = false;
  authorizationVerified = false;
  try {
    await runPrivateCli("wallet", "account-status", { "recv-window": 5000 });
    validatePermissions(await runPrivateCli("wallet", "get-api-key-permission", { "recv-window": 5000 }));
    return connectionStatus();
  } catch (error) {
    inMemoryCredentials = null;
    credentialsCleared = true;
    authorizationVerified = false;
    throw error;
  }
}

export function clearCredentials() {
  inMemoryCredentials = null;
  credentialsCleared = true;
  authorizationVerified = false;
  return connectionStatus();
}

export function connectionStatus() {
  const configured = Boolean(credentials());
  return {
    configured,
    enabled: configured,
    authStatus: authorizationVerified ? "authorized" : configured ? "configured" : "missing",
    adapter: "@binance/binance-cli",
  };
}

export async function requestConvertQuote(fromAsset, toAsset, fromAmount) {
  const from = cleanAsset(fromAsset);
  const to = cleanAsset(toAsset);
  const amount = cleanAmount(fromAmount);
  const value = await runPrivateCli("convert", "send-quote-request", {
    "from-asset": from,
    "to-asset": to,
    "from-amount": amount,
    "valid-time": "10s",
    "recv-window": 5000,
  });
  if (!value.quoteId || Number(value.toAmount) <= 0) throw new BinanceApiError("币安闪兑报价无效或可用余额不足");
  return {
    quoteId: cleanId(value.quoteId, "闪兑报价编号"),
    fromAsset: from,
    toAsset: to,
    fromAmount: String(value.fromAmount || amount),
    toAmount: cleanAmount(value.toAmount, "预计到账金额"),
    ratio: String(value.ratio || ""),
    validTimestamp: Number(value.validTimestamp || 0),
  };
}

export async function getAssetBalances(assets) {
  const unique = [...new Set((assets || []).map(cleanAsset))].slice(0, 4);
  if (unique.length === 0) throw new BinanceApiError("没有指定余额资产");
  const rows = await Promise.all(unique.map(async (asset) => {
    const payload = await runPrivateCli("wallet", "user-asset", {
      asset,
      "need-btc-valuation": false,
      "recv-window": 5000,
    });
    const row = Array.isArray(payload) ? payload.find((item) => String(item?.asset || "").toUpperCase() === asset) : null;
    return {
      asset,
      free: String(row?.free || "0"),
      locked: String(row?.locked || "0"),
    };
  }));
  return rows;
}

export async function acceptConvertQuote(quoteId, call = runPrivateCli) {
  const id = cleanId(quoteId, "闪兑报价编号");
  let accepted = null;
  let acceptError = null;
  try {
    accepted = await call("convert", "accept-quote", { "quote-id": id, "recv-window": 5000 });
  } catch (error) {
    acceptError = error;
  }

  let order;
  try {
    order = await call("convert", "order-status", { "quote-id": id, "recv-window": 5000 });
  } catch (statusError) {
    if (acceptError) {
      throw new BinanceApiError("兑换请求结果不确定，请到币安闪兑记录核实", { uncertain: true });
    }
    return {
      submitted: true,
      statusPending: true,
      order: { ...accepted, quoteId: id, orderStatus: accepted?.orderStatus || "UNKNOWN" },
      quoteId: id,
    };
  }
  const status = String(order.orderStatus || accepted?.orderStatus || "").toUpperCase();
  const failed = ["FAIL", "FAILED", "REJECT", "REJECTED", "EXPIRED", "CANCELED", "CANCELLED"].includes(status);
  const submitted = Boolean(order.orderId || accepted?.orderId) && !failed;
  if (!submitted && acceptError) throw acceptError;
  return { submitted, statusPending: false, order: { ...accepted, ...order, quoteId: id }, quoteId: id };
}

export const internals = {
  cleanAsset, cleanAmount, cleanId, cleanCredentials, parseJson, safeDetail, validatePermissions,
};
