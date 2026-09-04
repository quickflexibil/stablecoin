const EPSILON = 1e-12;

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label}必须大于 0`);
  return number;
}

function nonNegativeNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label}不能小于 0`);
  return number;
}

function normalizeLevels(levels) {
  if (!Array.isArray(levels)) return [];
  return levels
    .map(([price, quantity]) => [Number(price), Number(quantity)])
    .filter(([price, quantity]) => Number.isFinite(price) && price > 0 && Number.isFinite(quantity) && quantity > 0);
}

function floorToStep(value, step) {
  const size = Number(step);
  if (!Number.isFinite(size) || size <= 0) return value;
  return Math.floor((value + EPSILON) / size) * size;
}

export function fillBuy(quoteAmount, asks) {
  let quoteLeft = positiveNumber(quoteAmount, "买入金额");
  let baseOutput = 0;
  let quoteSpent = 0;
  const normalized = normalizeLevels(asks);
  for (const [price, quantity] of normalized) {
    const spend = Math.min(quoteLeft, price * quantity);
    baseOutput += spend / price;
    quoteSpent += spend;
    quoteLeft -= spend;
    if (quoteLeft <= EPSILON) break;
  }
  const bestPrice = normalized[0]?.[0] ?? 0;
  const averagePrice = baseOutput > 0 ? quoteSpent / baseOutput : 0;
  return {
    output: baseOutput,
    filled: quoteLeft <= EPSILON,
    consumed: quoteSpent,
    averagePrice,
    bestPrice,
    slippageBps: bestPrice > 0 ? ((averagePrice / bestPrice) - 1) * 10_000 : Infinity,
  };
}

export function fillSell(baseAmount, bids) {
  let baseLeft = positiveNumber(baseAmount, "卖出数量");
  let quoteOutput = 0;
  let baseSold = 0;
  const normalized = normalizeLevels(bids);
  for (const [price, quantity] of normalized) {
    const sold = Math.min(baseLeft, quantity);
    quoteOutput += sold * price;
    baseSold += sold;
    baseLeft -= sold;
    if (baseLeft <= EPSILON) break;
  }
  const bestPrice = normalized[0]?.[0] ?? 0;
  const averagePrice = baseSold > 0 ? quoteOutput / baseSold : 0;
  return {
    output: quoteOutput,
    filled: baseLeft <= EPSILON,
    consumed: baseSold,
    averagePrice,
    bestPrice,
    slippageBps: bestPrice > 0 ? (1 - (averagePrice / bestPrice)) * 10_000 : Infinity,
  };
}

function simulateSpotRoute(amount, route, feeBps) {
  let value = amount;
  let filled = true;
  let rulesPassed = true;
  const legs = [];

  for (const leg of route.legs) {
    const input = value;
    const executableInput = leg.side === "SELL" ? floorToStep(input, leg.rules?.stepSize) : input;
    if (executableInput <= EPSILON) {
      filled = false;
      rulesPassed = false;
      value = 0;
      break;
    }
    const fill = leg.side === "BUY" ? fillBuy(executableInput, leg.asks) : fillSell(executableInput, leg.bids);
    const outputBeforeFee = fill.output;
    const fee = outputBeforeFee * feeBps / 10_000;
    value = outputBeforeFee - fee;
    const notional = leg.side === "BUY" ? fill.consumed : outputBeforeFee;
    const minimumNotional = Number(leg.rules?.minNotional ?? 0);
    const minimumQuantity = Number(leg.rules?.minQty ?? 0);
    const maximumQuantity = Number(leg.rules?.maxQty ?? 0);
    const quantity = leg.side === "BUY" ? outputBeforeFee : fill.consumed;
    const legRulesPassed = notional + EPSILON >= minimumNotional
      && quantity + EPSILON >= minimumQuantity
      && (maximumQuantity <= 0 || quantity <= maximumQuantity + EPSILON);
    filled &&= fill.filled;
    rulesPassed &&= legRulesPassed;
    legs.push({
      symbol: leg.symbol,
      side: leg.side,
      fromAsset: leg.fromAsset,
      toAsset: leg.toAsset,
      input,
      executableInput,
      sourceDust: input - executableInput,
      output: value,
      outputBeforeFee,
      fee,
      averagePrice: fill.averagePrice,
      bestPrice: fill.bestPrice,
      slippageBps: fill.slippageBps,
      filled: fill.filled,
      rulesPassed: legRulesPassed,
      minimumNotional,
      minimumQuantity,
      maximumQuantity,
      quoteVolume24h: Number(leg.quoteVolume24h ?? 0),
    });
    if (!fill.filled || !legRulesPassed) {
      value = 0;
      break;
    }
  }

  return { ...route, output: value, filled, rulesPassed, legs };
}

function simulateRoute(amount, route, feeBps) {
  if (route.kind === "CONVERT") {
    const output = positiveNumber(route.fixedOutput, "币安闪兑报价");
    return { ...route, output, filled: true, rulesPassed: true, legs: [] };
  }
  if (!Array.isArray(route.legs) || route.legs.length === 0) throw new Error("现货路线缺少交易步骤");
  return simulateSpotRoute(amount, route, feeBps);
}

export function analyze(input) {
  const amount = positiveNumber(input.amount, "兑换金额");
  const maxCostBps = nonNegativeNumber(input.maxCostBps, "最大综合成本");
  const maxPegBps = nonNegativeNumber(input.maxPegBps, "最大偏离");
  const feeBps = nonNegativeNumber(input.feeBps ?? 10, "现货费率");
  if (!Array.isArray(input.routes) || input.routes.length === 0) throw new Error("没有发现可用兑换路线");

  const routes = input.routes.map((route) => {
    const simulated = simulateRoute(amount, route, feeBps);
    const costBps = ((amount - simulated.output) / amount) * 10_000;
    const deviationBps = Math.abs(simulated.output / amount - 1) * 10_000;
    const maxLegSlippageBps = simulated.legs.reduce((value, leg) => Math.max(value, leg.slippageBps), 0);
    const controls = {
      completeFill: simulated.filled,
      exchangeRules: simulated.rulesPassed,
      routeCost: costBps <= maxCostBps,
      pegDeviation: deviationBps <= maxPegBps,
    };
    return {
      ...simulated,
      costBps,
      deviationBps,
      maxLegSlippageBps,
      controls,
      eligible: Object.values(controls).every(Boolean),
    };
  }).sort((left, right) => Number(right.eligible) - Number(left.eligible) || right.output - left.output);

  const selected = routes.find((route) => route.eligible) ?? routes[0];
  const nextBest = routes.find((route) => route.id !== selected.id);
  const hardFailure = !selected.filled || !selected.rulesPassed || !selected.controls.pegDeviation;
  return {
    decision: selected.eligible ? "PASS" : hardFailure ? "BLOCK" : "WARN",
    fromAsset: String(input.fromAsset || "").toUpperCase(),
    toAsset: String(input.toAsset || "").toUpperCase(),
    amount,
    selectedRouteId: selected.id,
    selectedKind: selected.kind,
    expectedOutput: amount,
    selectedOutput: selected.output,
    savedVsNextBest: nextBest ? Math.max(0, selected.output - nextBest.output) : 0,
    routes,
    policy: { maxCostBps, maxPegBps, feeBps },
    timestamp: input.timestamp ?? new Date().toISOString(),
    source: input.source ?? null,
  };
}
