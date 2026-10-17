# 04-ADVERSARIAL — critic passes

| finding    | critic                           | verdict              | notes                                                       |
| ---------- | -------------------------------- | -------------------- | ----------------------------------------------------------- |
| M1 P0      | code-reviewer 019fb1a6-d361      | **ACCEPT**           | 0002 name-tracked; idempotent; down does not re-fleet-down  |
| R5 P1      | code-reviewer 019fb1a6-d362      | **ACCEPT**           | fail-closed correct vs incomplete S2S                       |
| R6 P1      | same                             | **ACCEPT-WITH-NITS** | buy ceiling cost; market sell still 0; ideal = Σ fill quote |
| BRAND-1 P0 | code-reviewer 019fb1a6-d362…3c12 | **ACCEPT**           | scrub real, not allowlist hide                              |
| WS-JWT P1  | same                             | **ACCEPT**           | compose + audience default match identity                   |
| FMT-1 P1   | mechanical                       | **ACCEPT**           | format:check exit 0 re-run                                  |

## False-done check on fix diffs

- No test weakened / skipped to pass
- New R6 unit test asserts cost ≠ "0"
- No empty catch on money
- No money as JS number on wire paths touched
- No invented candles/positions
- Brand scrub is content change not allowlist

## Residual after critics

- R6 market-sell cost still `"0"` without fills loaded — named residual
- Identity S2S ownership gate for sub-accounts — product follow-on (fail-closed until then)
- Edge bare-env JWT audience default `intafaced` vs identity `intafaced.api` — latent, out of WS-JWT scope
