# Architecture

```text
Browser
  ├─ route configuration
  ├─ ranked route table
  └─ one-time Convert confirmation
         │
Local Node server
  ├─ Binance Agent OS public adapter
  │    ├─ symbol directory
  │    ├─ exchange rules
  │    ├─ order books
  │    └─ 24h tickers
  ├─ deterministic route engine
  │    ├─ depth walking
  │    ├─ fee and dust accounting
  │    └─ PASS / WARN / BLOCK controls
  └─ Official Binance CLI Agent skill
       ├─ in-memory API authentication
       ├─ Convert quote
       ├─ accept one confirmed quote
       └─ order status
```

The deterministic engine has no network or account dependency and is covered by unit tests. Public market reads and private Convert calls use the official `@binance/binance-cli`. API credentials are accepted only by the loopback application, kept in process memory, redacted from errors, and never returned to the browser or written to disk.
