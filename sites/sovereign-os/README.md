# Sovereign OS — TV apply surface

Static marketing site for the TradingView Advanced Charts application path.

**Monorepo SoT:** this directory (`sites/sovereign-os/`).  
**Live interim HTTPS:** https://zenyoda3.github.io/intafaced-sovereign-os/  
**Apply pack:** `../../docs/TV-APPLY-PACK.md` (removed)  
**Scoreboard:** `../../docs/ops/TV-SITE-SCOREBOARD.md` (removed)

```bash
# local preview
python3 -m http.server 8765 --directory .
# open http://127.0.0.1:8765/
```

## Deploy

1. **Interim (live):** mirror or publish this folder to any static HTTPS host (current: GitHub Pages on the ZenYoda3 mirror).
2. **Custom domain (Nitro Class X):** CNAME `trade.intafaced.com` → host — see `../../docs/TV-DNS-HOST-RUNBOOK.md` (removed).
3. **Never** dual-write into `apps/customer` (HUMAN product shell; the old Vue shell under `vendor/**/05_Web_Front` was deleted 2026-10-19).

## Stack

See [`STACK-LOCK.md`](STACK-LOCK.md). Static HTML + CSS + JS only. No Advanced Charts binary. No framework build.
