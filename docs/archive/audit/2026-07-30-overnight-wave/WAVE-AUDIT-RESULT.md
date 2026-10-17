# Wave audit — overnight 2026-07-30 (post #206–#221)

**Tip at audit:** `2e0bb87` · **#220** bank shell loans · prior **#221** CI fix · **#219** O1+O2 law  
**Method:** [`docs/WAVE-AUDIT.md`](../../WAVE-AUDIT.md) · delta only (not full archaeology)  
**Class:** hygiene / N10

## Delta (merged since prior high water #216 era)

| PR   | Title class             | Money?            | Note                                    |
| ---- | ----------------------- | ----------------- | --------------------------------------- |
| #207 | notify multi-channel    | no                | honest refuse when channel unconfigured |
| #208 | academy lobbies         | no                | seats / rank host rights                |
| #209 | venue fabric            | spine             | gap withholds book                      |
| #210 | local EVM + CREATE2     | chain             | unlocks smart-account tests             |
| #211 | test DB isolation       | safety            | shared DB hazard closed                 |
| #213 | vendored exchange audit | docs              | dual-book ADR still open (owner)        |
| #214 | hosted checkout         | **money surface** | sandbox must not take stranger money    |
| #216 | blueprint share card    | product           | cascade ownership still incomplete      |
| #217 | token factory           | chain             | mint authority none; audited:false      |
| #218 | indexer read models     | chain             | DevVenue artefact track fix in #221     |
| #219 | O1+O2 overnight law     | docs              | Nitro                                   |
| #220 | bank shell loans UI     | Stream A read     | no money writes                         |
| #221 | CI invisible reds       | fix               | format + tracked artefact               |

## L0 machine (this fire)

| Gate                              | Result                                                        |
| --------------------------------- | ------------------------------------------------------------- |
| CI on tip `2e0bb87`               | **SUCCESS** (Actions run after #220)                          |
| Brand scan (Stream A WIP sibling) | clean when run                                                |
| Tracker honesty                   | bank.loans done via #219; blueprint.ownership honest residual |
| Format on tip                     | fixed by #221                                                 |

## Money / auth residuals (not closed this wave)

1. **`blueprint.ownership` cascade** — `blueprintDeleted` has no svc-identity subscriber (Denon #216 honesty).
2. **Balance-ownership ADR** — still In progress; dual-book docs cannot close. Owner/Denon.
3. **`pay.rails` live** — sandbox only; neither v1 rail moves real value.
4. **chain.mainnet** — provider decision; smart-accounts 27 unlocks need real RPC.
5. **Disclosed secrets rotation** — heapdump credential etc. Owner ops (not code).
6. **Identity KYC queue** — historical shared-DB poison risk; re-verify after #211 isolation.
7. **Vendor Java custody-scan gap** — custody-scan never reads Java (Denon audit #213).

## False-done check

- Tracker does **not** claim blueprint cascade done.
- Token factory scored ready not done (dev chain ≠ chain decision) — correct.
- Shell still must not invent balances / heights / factory addresses.

## Adversarial notes (delta)

- #217/#218 each nearly left main red in ways local green hid (#221 lesson).
- Hosted checkout paths that accept stranger money on sandbox remain a **CLASS M** never-auto-merge.
- Stream A PR sibling only wires **read** honesty for new spine — no money writes.

## Exit checklist

- [x] Tip SHA recorded
- [x] L0 CI stated
- [x] Money/auth residuals named
- [x] No fake green
- [ ] Peace scoreboard full rewrite — deferred (WAVE-AUDIT only; PEACE still PASS-WITH-RESIDUALS)

## Next

- Merge Stream A spine-surfaces PR when CI green (Class N).
- Keep O1 babysit; no Denon mountain invent.
- Owner: secrets rotation + dual-book ADR + EVM RPC if unlocking 27.
