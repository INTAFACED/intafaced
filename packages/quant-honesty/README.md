# @intafaced/quant-honesty

Refuse-first contracts for §29 Quant backtest surfaces.

This package deliberately does not contain a backtest engine, data lake, return
calculation, ranking engine, or UI. D-S-18 permits contracts and refusal paths
before §27 Connect exists; it forbids producing a performance claim before the
evidence that makes it true exists.

## Contract

`assessBacktestSurface(candidate)` returns a renderable surface only when:

- an out-of-sample verdict has a valid evaluation window and positive sample count;
- fee, slippage, and latency models each have an allowed model kind and source provenance;
- the positive integer count of tested strategy variants is present; and
- the run and strategy have non-blank source identities.

Incomplete candidates return a typed refusal. Callers must not turn a refusal
into a caveated chart.

`assessStrategyComparisonOrder(order)` permits stable non-performance ordering
only. Historical return is explicitly refused, so a truthful historical number
cannot become a curve-fit marketing leaderboard.

`buildPerformanceContextLabels()` gives live and simulated performance labels
the same visual weight when a future product surface shows both.

## Leverage

- Law: `docs/adr/2026-08-04-predict-quant-connect-law.md`
- Existing source boundary: §27 Connect and its future data lake provide model
  provenance; this package does not replace either.
- Product surface: none in this package. The vendored shell is the customer
  site served today. ADR `docs/adr/2026-10-02-redesign-may-replace-product-ui.md`
  may replace that UI later. This package does not own a front-end lane, and it
  does not freeze Vue as the permanent UI.

## Refusal examples

| Missing or invalid evidence | Result                                 |
| --------------------------- | -------------------------------------- |
| Out-of-sample verdict       | `missing_out_of_sample_verdict`        |
| Fee model                   | `missing_fee_model`                    |
| Slippage model              | `missing_slippage_model`               |
| Latency model               | `missing_latency_model`                |
| Strategy variant count      | `invalid_strategy_count`               |
| Historical-return ordering  | `returns_ranked_leaderboard_forbidden` |

## Verify

```text
pnpm --filter @intafaced/quant-honesty test
pnpm --filter @intafaced/quant-honesty typecheck
pnpm --filter @intafaced/quant-honesty build
```
