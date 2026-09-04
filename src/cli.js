import { fetchSpotRoutes } from "./agent-os.js";
import { analyze } from "./engine.js";

const intent = {
  fromAsset: String(process.argv[2] || "USDT").toUpperCase(),
  toAsset: String(process.argv[3] || "USDC").toUpperCase(),
  amount: Number(process.argv[4] || 1000),
  maxCostBps: 20,
  maxPegBps: 50,
  feeBps: 10,
  allowVolatile: false,
};
const market = await fetchSpotRoutes(intent);
console.log(JSON.stringify(analyze({ ...intent, ...market }), null, 2));
