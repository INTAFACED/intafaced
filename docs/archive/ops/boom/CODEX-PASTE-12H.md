# Codex paste — 12h look (do not load remaining-SOT)

LOOK only. Do not change session/money/authority/fixtures/lockfile/boot.
N4: near-black, square, no glass, accent `#FF6B00` in named slots only, green/red = market only.
No Tailwind. No second SPA. No fake balances/fills. No LWC restyle. No Advanced Charts.
Nitro is gone. One journey per PR. `pnpm wt` from Sovereign home off `origin/main`.
Proof: 1440×900 and 390×844 crops + worktree SHA. Fail-first golden must go green.

---

## PR 1 — pair drawer (do this first)

Route: `/exchange/btc_usdt`  
File: `vendor/upstream-exchange/05_Web_Front/src/pages/exchange/Exchange.vue` **style only**  
Do not edit the golden.

Red now:

```
cd vendor/upstream-exchange/05_Web_Front
node src/assets/js/exchange-market-drawer.golden.js
```

Fails: `@media (max-width: 520px)`, `@media (max-width: 1180px) and (min-width: 701px)`, `@media (max-width: 700px)` hide `.ix-markets` with `display:none !important` and never show `.ix-markets.is-open`.

Fix: in **each of those three blocks**, copy the 1500px open drawer (fixed, flex, z-index 80) as:

```css
.ix-markets.is-open {
  display: flex !important;
  /* same geometry as the 1500px .ix-markets.is-open rule */
}
```

Falsifier: golden still prints FAIL for those three headers, or 390 click on the pair does not show `#ix-market-drawer`.
Crops: 390 and 1440, drawer open, pair selected, URL updated.

---

## PR 2 — Money OS interiors

Route: `/uc/money`  
File: `vendor/upstream-exchange/05_Web_Front/src/components/uc/MoneyIndex.vue` (+ children it already mounts)  
IxWorkspace if stacked errors. Failed fetch ≠ `$0`. Dual-book labeled.
Falsifier: crop shows three gray error panels or a `$0` on a down wallet.
Crops: `/uc/money` 1440 + 390, APIs down.

---

## PR 3 — Bank OS interiors

Route: `/bank` only (not `/bank/business` in this PR)  
File: `vendor/upstream-exchange/05_Web_Front/src/pages/intafaced/Bank.vue`  
Already has IxWorkspace. Make it look like OS not mall. Honesty copy stays (never `$0` on error).
Falsifier: `/bank` looks like a marketing page or paints `$0` on error.
Crops: `/bank` 1440 + 390.

---

## PR 4 — Pay OS interiors

Route: `/pay` only (not checkout)  
File: `vendor/upstream-exchange/05_Web_Front/src/pages/intafaced/Pay.vue`  
Same as Bank. Keep acquirer honesty. Do not delete live-client copy.
Falsifier: `/pay` stacked errors or mall chrome.
Crops: `/pay` 1440 + 390.

---

Stop. Do not start a fifth PR. Do not restyle `intafaced.css` tokens globally.
