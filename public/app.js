const $ = (selector) => document.querySelector(selector);
const form = $("#routeForm");
const scanButton = $("#scanButton");
const authButton = $("#authButton");
const ticketButton = $("#ticketButton");
const dialog = $("#ticketDialog");
const apiDialog = $("#apiDialog");
const toast = $("#toast");
let authStatus = "unknown";
let currentReport = null;
let currentTicket = null;
let expiryTimer = null;
let balanceRequest = 0;
let scanRequest = 0;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function formatNumber(value, digits = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(number);
}

function orderStatusText(value, submitted = false, statusPending = false) {
  if (statusPending) return "兑换已提交，状态待确认";
  const status = String(value || "").trim().toUpperCase();
  if (["SUCCESS", "COMPLETED", "FILLED"].includes(status)) return "兑换成功";
  if (["FAIL", "FAILED", "REJECT", "REJECTED", "EXPIRED", "CANCELED", "CANCELLED"].includes(status)) return "兑换失败";
  if (["PROCESS", "PROCESSING", "PENDING", "ACCEPT_SUCCESS"].includes(status)) return "兑换处理中";
  return submitted ? "兑换已提交" : "兑换失败";
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 5000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({ ok: false, error: "服务响应无效" }));
  if (!response.ok || !data.ok) {
    const error = new Error(data.error || "请求失败");
    error.uncertain = Boolean(data.uncertain);
    throw error;
  }
  return data;
}

function readIntent() {
  return {
    fromAsset: $("#fromAsset").value,
    toAsset: $("#toAsset").value,
    amount: $("#amount").value,
    maxCostBps: $("#maxCostBps").value,
    maxPegBps: $("#maxPegBps").value,
    feeBps: $("#feeBps").value,
    includeConvert: $("#includeConvert").checked,
    allowVolatile: $("#allowVolatile").checked,
  };
}

function saveIntent() {
  localStorage.setItem("stablecoin-route-intent", JSON.stringify(readIntent()));
}

function restoreIntent() {
  try {
    const saved = JSON.parse(localStorage.getItem("stablecoin-route-intent") || "null");
    if (!saved) return;
    for (const id of ["fromAsset", "toAsset", "amount", "maxCostBps", "maxPegBps", "feeBps"]) {
      if (saved[id] !== undefined && $(`#${id}`)) $(`#${id}`).value = saved[id];
    }
    $("#includeConvert").checked = saved.includeConvert !== false;
    $("#allowVolatile").checked = Boolean(saved.allowVolatile);
  } catch {}
}

function syncAssets() {
  $("#amountAsset").textContent = $("#fromAsset").value;
  $("#outputAsset").textContent = $("#toAsset").value;
}

function invalidateReport() {
  scanRequest += 1;
  currentReport = null;
  ticketButton.hidden = true;
  $("#decision").textContent = "待机";
  $("#decision").className = "decision ready";
  $("#timestamp").textContent = "尚未扫描";
  $("#selectedRoute").textContent = "—";
  $("#selectedOutput").textContent = "—";
  $("#savedAmount").textContent = "—";
  $("#costBps").textContent = "—";
  $("#slippageBps").textContent = "—";
  $("#routeLine").textContent = "等待实时行情";
  $("#routeRows").innerHTML = "<tr><td colspan=\"6\">扫描后显示全部可用路径</td></tr>";
  $("#source").textContent = "Binance Agent OS";
  $("#notice").hidden = true;
}

function renderAuth(status) {
  authStatus = status?.authStatus || "unavailable";
  const authorized = authStatus === "authorized";
  const configured = authorized || authStatus === "configured";
  $("#liveDot").classList.toggle("on", configured);
  $("#accountStatus").textContent = authorized ? "Binance API 已连接" : configured ? "Binance API 已配置" : "Binance API 未配置";
  authButton.textContent = configured ? "清除 API" : "配置 API";
  ticketButton.hidden = !(authorized && currentReport?.decision === "PASS" && currentReport?.selectedKind === "CONVERT");
  if (!configured) {
    $("#fromBalance").textContent = "可用 —";
    $("#toBalance").textContent = "可用 —";
  }
}

async function refreshAuth() {
  try {
    renderAuth((await api("/api/state")).agentOs);
    if (authStatus === "authorized" || authStatus === "configured") refreshBalances();
  }
  catch (error) { renderAuth({ authStatus: "unavailable" }); showToast(error.message); }
}

async function refreshBalances() {
  if (!(authStatus === "authorized" || authStatus === "configured")) return;
  const request = ++balanceRequest;
  const from = $("#fromAsset").value;
  const to = $("#toAsset").value;
  $("#fromBalance").textContent = "读取余额";
  $("#toBalance").textContent = "读取余额";
  try {
    const data = await api(`/api/balances?assets=${encodeURIComponent(`${from},${to}`)}`);
    if (request !== balanceRequest) return;
    const byAsset = new Map(data.balances.map((row) => [row.asset, row]));
    $("#fromBalance").textContent = `可用 ${formatNumber(byAsset.get(from)?.free || 0, 8)} ${from}`;
    $("#toBalance").textContent = `可用 ${formatNumber(byAsset.get(to)?.free || 0, 8)} ${to}`;
  } catch (error) {
    if (request !== balanceRequest) return;
    $("#fromBalance").textContent = "余额读取失败";
    $("#toBalance").textContent = "余额读取失败";
  }
}

function setBusy(busy, label = "正在读取实时行情") {
  scanButton.disabled = busy;
  scanButton.querySelector("span").textContent = busy ? label : "扫描最优路径";
  if (busy) {
    $("#decision").textContent = "扫描中";
    $("#decision").className = "decision ready";
    $("#timestamp").textContent = "Binance Agent OS 正在工作";
  }
}

function renderRouteLine(route) {
  const assets = route?.assets || [];
  $("#routeLine").innerHTML = assets.map((asset, index) => {
    const leg = route.legs?.[index];
    const detail = leg ? `${leg.side === "BUY" ? "买入" : "卖出"} ${leg.symbol}` : route.kind === "CONVERT" && index === 0 ? "闪兑" : "";
    return `<div class="route-node"><span class="node-label">${escapeHtml(asset)}</span>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</div>`;
  }).join("");
}

function renderReport(report, convertError = "", agentOsVerified = false) {
  const reportAuthStatus = agentOsVerified ? "authorized" : authStatus;
  currentReport = report;
  const selected = report.routes.find((route) => route.id === report.selectedRouteId) || report.routes[0];
  const decision = $("#decision");
  decision.textContent = report.decision === "PASS" ? "通过" : report.decision === "WARN" ? "警告" : "拦截";
  decision.className = `decision ${report.decision.toLowerCase()}`;
  $("#selectedRoute").textContent = selected.label;
  $("#selectedOutput").textContent = formatNumber(selected.output, 8);
  $("#outputAsset").textContent = report.toAsset;
  $("#savedAmount").textContent = `${formatNumber(report.savedVsNextBest, 8)} ${report.toAsset}`;
  $("#costBps").textContent = `${formatNumber(selected.costBps, 2)} bps`;
  $("#slippageBps").textContent = selected.kind === "CONVERT" ? "已含报价" : `${formatNumber(selected.maxLegSlippageBps, 2)} bps`;
  $("#timestamp").textContent = new Date(report.timestamp).toLocaleString("zh-CN", { hour12: false });
  renderRouteLine(selected);

  $("#routeRows").innerHTML = report.routes.map((route, index) => `
    <tr class="${route.id === report.selectedRouteId ? "selected" : ""}">
      <td class="rank">${String(index + 1).padStart(2, "0")}</td>
      <td><b>${escapeHtml(route.label)}</b>${route.kind === "CONVERT" ? "" : `<span class="route-kind">${route.legs.length} 段</span>`}</td>
      <td>${formatNumber(route.output, 8)} ${escapeHtml(report.toAsset)}</td>
      <td>${formatNumber(route.costBps, 2)} bps</td>
      <td class="${route.filled ? "ok" : "bad"}">${route.filled ? "充足" : "不足"}</td>
      <td class="${route.rulesPassed ? "ok" : "bad"}">${route.rulesPassed ? "通过" : "不通过"}</td>
    </tr>`).join("");

  const calls = report.source?.toolCalls || [];
  $("#source").textContent = `Binance Agent OS 实时数据 · ${calls.length} 次工具调用`;
  $("#notice").hidden = !convertError;
  $("#notice").textContent = convertError;
  renderAuth({ authStatus: reportAuthStatus });
}

async function scan({ showError = true } = {}) {
  saveIntent();
  invalidateReport();
  const request = scanRequest;
  setBusy(true);
  try {
    const data = await api("/api/scan", { method: "POST", body: JSON.stringify(readIntent()) });
    if (request !== scanRequest) return;
    renderReport(data.report, data.convertError, data.agentOsVerified);
    refreshBalances();
  } catch (error) {
    if (request !== scanRequest) return false;
    $("#timestamp").textContent = "扫描失败";
    if (showError) showToast(error.message);
    return false;
  } finally {
    if (request === scanRequest) setBusy(false);
  }
  return true;
}

async function handleAuth() {
  if (authStatus === "authorized" || authStatus === "configured") {
    authButton.disabled = true;
    try { renderAuth((await api("/api/disconnect", { method: "POST", body: "{}" })).agentOs); }
    catch (error) { showToast(error.message); }
    finally { authButton.disabled = false; }
    return;
  }
  $("#apiKey").value = "";
  $("#apiSecret").value = "";
  apiDialog.showModal();
}

async function connectApi(event) {
  event.preventDefault();
  const button = $("#connectApiButton");
  button.disabled = true;
  button.textContent = "正在验证";
  try {
    const data = await api("/api/connect", {
      method: "POST",
      body: JSON.stringify({ apiKey: $("#apiKey").value, apiSecret: $("#apiSecret").value }),
    });
    $("#apiKey").value = "";
    $("#apiSecret").value = "";
    renderAuth(data.agentOs);
    apiDialog.close();
    showToast("Binance API 已连接");
    refreshBalances();
  } catch (error) {
    $("#apiSecret").value = "";
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "验证并连接";
  }
}

function startExpiry(expiresAt) {
  clearInterval(expiryTimer);
  const tick = () => {
    const seconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    $("#ticketExpiry").textContent = `${seconds} 秒`;
    if (seconds === 0) clearInterval(expiryTimer);
  };
  tick();
  expiryTimer = setInterval(tick, 1000);
}

async function prepareTicket() {
  ticketButton.disabled = true;
  ticketButton.textContent = "正在刷新报价";
  try {
    const data = await api("/api/ticket", { method: "POST", body: JSON.stringify(readIntent()) });
    renderReport(data.report, "", true);
    currentTicket = data.ticket;
    $("#ticketFrom").textContent = `${formatNumber(currentTicket.fromAmount, 8)} ${currentTicket.fromAsset}`;
    $("#ticketMinimum").textContent = `${formatNumber(currentTicket.minimumOutput, 8)} ${currentTicket.toAsset}`;
    $("#confirmation").value = "";
    startExpiry(currentTicket.expiresAt);
    if (!dialog.open) dialog.showModal();
  } catch (error) { showToast(error.message); }
  finally { ticketButton.disabled = false; ticketButton.textContent = "立即兑换"; }
}

async function executeTicket(event) {
  event.preventDefault();
  if (!currentTicket) return;
  const button = $("#executeButton");
  const confirmation = $("#confirmation").value;
  $("#confirmation").value = "";
  button.disabled = true;
  button.textContent = "正在刷新并提交";
  try {
    const data = await api("/api/execute", {
      method: "POST",
      body: JSON.stringify({ ticketId: currentTicket.ticketId, confirmation }),
    });
    dialog.close();
    currentTicket = null;
    const resultMessage = orderStatusText(data.order?.orderStatus, data.submitted, data.statusPending);
    showToast(resultMessage);
    await scan({ showError: false });
    showToast(resultMessage);
  } catch (error) {
    if (error.uncertain) {
      dialog.close();
      currentTicket = null;
      showToast("兑换结果待确认，请到币安闪兑记录核实");
      refreshBalances();
    } else if (/兑换票据.*(?:不存在|已过期)/.test(error.message)) {
      currentTicket = null;
      showToast("兑换票据已失效，正在重新生成");
      await prepareTicket();
    } else showToast("兑换失败");
  }
  finally { button.disabled = false; button.textContent = "确认并兑换"; }
}

form.addEventListener("submit", (event) => { event.preventDefault(); scan(); });
form.addEventListener("input", invalidateReport);
authButton.addEventListener("click", handleAuth);
$("#apiForm").addEventListener("submit", connectApi);
$("#closeApiButton").addEventListener("click", () => apiDialog.close());
apiDialog.addEventListener("close", () => {
  $("#apiKey").value = "";
  $("#apiSecret").value = "";
});
ticketButton.addEventListener("click", prepareTicket);
$("#ticketForm").addEventListener("submit", executeTicket);
$("#closeTicketButton").addEventListener("click", () => dialog.close());
$("#swapAssets").addEventListener("click", () => {
  const from = $("#fromAsset").value;
  $("#fromAsset").value = $("#toAsset").value;
  $("#toAsset").value = from;
  invalidateReport();
  syncAssets();
  refreshBalances();
});
$("#fromAsset").addEventListener("change", () => { syncAssets(); refreshBalances(); });
$("#toAsset").addEventListener("change", () => { syncAssets(); refreshBalances(); });
dialog.addEventListener("close", () => {
  clearInterval(expiryTimer);
  currentTicket = null;
});

function registerWebMcp() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  try {
    Promise.resolve(context.registerTool({
      name: "scan_stablecoin_routes",
      title: "扫描稳定币兑换路径",
      description: "使用 Binance Agent OS 实时订单簿比较稳定币现货与币安闪兑路径，不执行交易。",
      inputSchema: {
        type: "object",
        properties: {
          fromAsset: { type: "string" }, toAsset: { type: "string" }, amount: { type: "number", exclusiveMinimum: 0 },
          maxCostBps: { type: "number", minimum: 0 }, maxPegBps: { type: "number", minimum: 0 },
          feeBps: { type: "number", minimum: 0 }, includeConvert: { type: "boolean" }, allowVolatile: { type: "boolean" },
        },
        required: ["fromAsset", "toAsset", "amount"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      async execute(input) {
        const request = {
          maxCostBps: 20, maxPegBps: 50, feeBps: 10, includeConvert: true, allowVolatile: false,
          ...input,
        };
        const data = await api("/api/scan", { method: "POST", body: JSON.stringify(request) });
        renderReport(data.report, data.convertError, data.agentOsVerified);
        return {
          decision: data.report.decision,
          selectedRoute: data.report.selectedRouteId,
          selectedOutput: data.report.selectedOutput,
          toAsset: data.report.toAsset,
          timestamp: data.report.timestamp,
        };
      },
    }, { signal: lifecycle.signal })).catch(() => {});
  } catch {}
}

restoreIntent();
syncAssets();
refreshAuth();
registerWebMcp();
