# Vendor money inventory — dual-book Option B

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Generated:** 2026-07-31
**Java files scanned:** 881
**Four DAO mutators:** increaseBalance, decreaseBalance, freezeBalance, thawBalance

## MemberWalletDao mutator definitions

- `vendor/<exchange>/00_framework/core/src/main/java/com/<vendor>/<module>/dao/MemberWalletDao.java:27` · **increaseBalance** — `int increaseBalance(@Param("walletId") long walletId, @Param("amount") BigDecimal amount);`
- `vendor/<exchange>/00_framework/core/src/main/java/com/<vendor>/<module>/dao/MemberWalletDao.java:33` · **decreaseBalance** — `int decreaseBalance(@Param("walletId") long walletId, @Param("amount") BigDecimal amount);`
- `vendor/<exchange>/00_framework/core/src/main/java/com/<vendor>/<module>/dao/MemberWalletDao.java:39` · **freezeBalance** — `int freezeBalance(@Param("walletId") long walletId, @Param("amount") BigDecimal amount);`
- `vendor/<exchange>/00_framework/core/src/main/java/com/<vendor>/<module>/dao/MemberWalletDao.java:45` · **thawBalance** — `int thawBalance(@Param("walletId") long walletId, @Param("amount") BigDecimal amount);`
- `vendor/<exchange>/00_framework/core/src/main/java/com/<vendor>/<module>/dao/MemberWalletDao.java:147` · **increaseBalance** — `int increaseBalanceForBHB(@Param("balance")BigDecimal mineAmount,@Param("memberId") Long memberId);`

## Controllers that call mutators (7 files)

### `vendor/<exchange>/00_framework/admin/src/main/java/com/<vendor>/<module>/controller/activity/ActivityController.java`

- L336 **thawBalance** — `memberWalletService.thawBalance(freezeWallet, order.getFreezeAmount());`
- L347 **increaseBalance** — `memberWalletService.increaseBalance(distributeWallet.getId(), disAmount);`
- L401 **increaseBalance** — `memberWalletService.increaseBalance(distributeWallet.getId(), disAmount);`

### `vendor/<exchange>/00_framework/admin/src/main/java/com/<vendor>/<module>/controller/ctc/AdminCtcOrderController.java`

- L182 **increaseBalance** — `memberWalletService.increaseBalance(mw.getId(), order.getAmount());`
- L327 **thawBalance** — `memberWalletService.thawBalance(memberWallet, order.getAmount());`

### `vendor/<exchange>/00_framework/admin/src/main/java/com/<vendor>/<module>/controller/otc/AdminAppealController.java`

- L231 **thawBalance** — `MessageResult result = memberWalletService.thawBalance(memberWallet,amount);`

### `vendor/<exchange>/00_framework/otc-api/src/main/java/com/<vendor>/<module>/controller/AdvertiseController.java`

- L225 **freezeBalance** — `MessageResult result = memberWalletService.freezeBalance(memberWallet, advertise.getNumber());`
- L252 **thawBalance** — `MessageResult result = memberWalletService.thawBalance(memberWallet, advertise.getRemainAmount());`

### `vendor/<exchange>/00_framework/otc-api/src/main/java/com/<vendor>/<module>/controller/OrderController.java`

- L367 **freezeBalance** — `if (!(memberWalletService.freezeBalance(wallet, amount).getCode() == 0)) {`
- L532 **thawBalance** — `MessageResult result = memberWalletService.thawBalance(memberWallet, order.getNumber());`
- L544 **thawBalance** — `MessageResult result = memberWalletService.thawBalance(memberWallet, add(order.getNumber(), order.getCommission()));`

### `vendor/<exchange>/00_framework/ucenter-api/src/main/java/com/<vendor>/<module>/controller/CtcController.java`

- L267 **freezeBalance** — `memberWalletService.freezeBalance(memberWallet, amount);`
- L396 **thawBalance** — `memberWalletService.thawBalance(memberWallet, order.getAmount());`

### `vendor/<exchange>/00_framework/ucenter-api/src/main/java/com/<vendor>/<module>/controller/WithdrawController.java`

- L257 **freezeBalance** — `MessageResult result = memberWalletService.freezeBalance(memberWallet, amount);`

## Other call sites (services/jobs/events) — 23 hits

- `vendor/<exchange>/00_framework/admin/src/main/java/com/<vendor>/<module>/job/CheckCtcOrderJob.java` (1): thawBalance
- `vendor/<exchange>/00_framework/admin/src/main/java/com/<vendor>/<module>/job/CheckRedEnvelopeJob.java` (2): thawBalance
- `vendor/<exchange>/00_framework/core/src/main/java/com/<vendor>/<module>/service/ActivityOrderService.java` (1): freezeBalance
- `vendor/<exchange>/00_framework/core/src/main/java/com/<vendor>/<module>/service/AdvertiseService.java` (1): thawBalance
- `vendor/<exchange>/00_framework/core/src/main/java/com/<vendor>/<module>/service/MemberWalletService.java` (8): freezeBalance, thawBalance, increaseBalance
- `vendor/<exchange>/00_framework/core/src/main/java/com/<vendor>/<module>/service/OrderService.java` (2): thawBalance
- `vendor/<exchange>/00_framework/exchange-core/src/main/java/com/<vendor>/<module>/service/ExchangeOrderService.java` (8): freezeBalance, increaseBalance, thawBalance

## Counts

| Metric                         | Count |
| ------------------------------ | ----: |
| Controllers with mutator calls |     7 |
| Controller call-site lines     |    14 |
| Non-controller call-site lines |    23 |
| DAO definition lines           |     5 |

## Enforcement path

1. This inventory (P2-1).
2. `pnpm scan:vendor-java-money` — live mutator SQL banned (P2-2/P2-3).
3. Runtime door-kill on money controllers (P2-4 Class M carve-out).
