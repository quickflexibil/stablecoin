# Binance Stablecoin Route Agent

Binance Agent OS Track A 应用。输入稳定币、金额和风险限制后，应用实时读取 Binance 现货交易规则、订单簿与 24 小时行情，比较直达及双腿兑换路径，并加入 Binance Convert 实时报价。

## 功能

- 自动发现直达与中转路径
- 按订单簿逐档计算真实可成交量、均价和滑点
- 计入用户设置的现货费率与交易规则
- PASS / WARN / BLOCK 确定性判断
- Binance API 本地内存连接与清除
- 只读取并显示当前转出、转入资产的可用余额
- 扫描通过后可在页面点击“立即兑换”，刷新报价并生成短时效闪兑票据
- 执行前刷新全部数据；必须输入精确的 `CONFIRM`
- 接受 Convert 报价后查询真实订单状态

所有市场数据与实盘闪兑均通过 Binance 官方 Agent 工具链完成。API 配置功能随项目上传，但使用者填写的 API Key 和 Secret 只保存在本机服务进程内存，不写入浏览器存储、文件、日志或 GitHub。

## 运行

需要 Node.js 20+。

```bash
npm install
npm test
npm start
```

打开 `http://127.0.0.1:8811`。

点击页面右上角“配置 API”，填写使用者自己的 Binance API Key 与 Secret。建议仅开启读取与现货交易权限，并限制可信 IP；不要开启提现权限。服务重启后凭据自动清除。

命令行只读扫描：

```bash
npm run analyze -- USDT USDC 1000
```

## 数据链路

现货路径使用：

- `spot.ticker-price`
- `spot.exchange-info`
- `spot.depth`
- `spot.ticker24hr`

Convert 路径通过 Binance 官方 `@binance/binance-cli` Agent Skill 使用：

- `convert.sendQuoteRequest`
- `convert.acceptQuote`
- `convert.orderStatus`

## 安全边界

- 行情扫描不会创建订单。
- 应用不执行多腿现货交易，避免第一腿成交而第二腿失败。
- 只有合格且仍为最优的单笔 Binance Convert 才能生成票据。
- 用户确认后再次刷新报价与本地规则；任何变化超限都会取消。
- 每张票据只能使用一次，且三分钟后失效。
