# Security — when to do what (plain language)

**For Nitro + every agent.** Full tool detail lives in [`BULLETPROOF-ARSENAL-2026-07-29.md`](./BULLETPROOF-ARSENAL-2026-07-29.md). Strix only: [`STRIX-ASSESSMENT-2026-07-29.md`](./STRIX-ASSESSMENT-2026-07-29.md).  
**Post-audit status (Track A partial / product doors closed):** [`SECURITY-FLOOR-AFTER-AUDIT-2026-07-29.md`](./SECURITY-FLOOR-AFTER-AUDIT-2026-07-29.md) · product scoreboard: [`PEACE-OF-MIND-AUDIT-CURRENT.md`](./PEACE-OF-MIND-AUDIT-CURRENT.md).  
**Current threat model (D26-P3-02 — judgment, not pentest):** [`THREAT-MODEL-CURRENT.md`](./THREAT-MODEL-CURRENT.md). July 29 `audit/2026-07-29/05-THREAT-MODEL.md` is archive.

**One sentence:** We are **not** “only stress testing later.” We are building **layers of proof** that money cannot be stolen or broken — cheap automatic checks **now**, attack-style tests **when the product is running**, independent human check **before real customer money**.

---

## Words (gloss)

| Word            | Plain meaning                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Bulletproof** | Many different checks so one blind spot cannot lose money. Not one magic scanner.                                         |
| **Layer**       | One kind of check (e.g. “secret keys must not ship” vs “can a hacker break in”).                                          |
| **Law / gate**  | A check that **blocks shipping** if it fails (CI / `pnpm verify`). Must be boring and reliable.                           |
| **Campaign**    | A deliberate big security run (hours, costs AI money). Not every PR.                                                      |
| **Stress test** | Push the system hard (many actions at once) to see if money paths race or break. **One later layer**, not the whole plan. |
| **Pentest**     | Pretend to be a hacker (tools or humans) against a **running** app you own.                                               |
| **Staging**     | A safe copy of the product that is not real customers.                                                                    |
| **Strix**       | AI hacker team in a box — finds real break-ins with proof. **Later, non-prod only.**                                      |

---

## Are we only preparing for later?

**No.** Two tracks run in parallel:

| Track                    | What it is                                     | When                    |
| ------------------------ | ---------------------------------------------- | ----------------------- |
| **A · Everyday law**     | Automatic “don’t ship dangerous code”          | **Now and forever**     |
| **B · Attack readiness** | Tools and playbooks for when something is live | Map now · **run later** |

The long arsenal list is mostly **Track B**. Track A is smaller and should already be growing **before** Strix.

---

## NOW (post-audit 2026-07-29 — stack can run; not customer money)

**Product doors from the full audit are closed on main (#80/#81).** Everyday security _tooling_ is still only **partial** — see security floor.

**Do these kinds of things** (agents execute when you ask for security/money work or when audit/fix PRs say so):

1. **Keep existing law green** — brand scan, custody scan, `pnpm verify` on every ship. **Already real.**
2. **Grow “doctrine as machine checks”** — Semgrep-style + tighter custody/money greps. **Still to grow** — not waiting for Strix.
3. **Secret scanning** — gitleaks-class as always-on law. **On tip:** `.github/workflows/gitleaks.yml` + `.gitleaks.toml` (FH-SEC-02) beside `tooling/ci/secret-scan.mjs` assignment law.
4. **Stronger money tests** — invariants / property tests on ledger holds. Example regression tests exist; **property suite still thin.**
5. **Catch AI cheating** — on money fix PRs (WAVE-AUDIT process). **Not yet an automated gate.**
6. **After Denon merges:** run [`WAVE-AUDIT.md`](./WAVE-AUDIT.md) only — full A–E is **closed**.
7. **Keep the map current** — security floor + this file + arsenal + Strix assessment.

**Do _not_ do now:**

- Install/run **Strix** without Nitro’s explicit go + named **non-prod** target
- Attack **production** (hard ban without formal scoped engagement)
- Buy a stack of AI pentest SaaS products
- Re-open full-repo archaeology because a tool list exists
- Treat “we have a tool list” as “we are safe for real money”

---

## NEAR (eligible now — `platform:up` / local stack; still not customer money)

Routers **are** mounted on main. There is something to **hit** when you choose to run the stack.

1. **Simple automated attack-surface scan** (ZAP-class) against **local/staging** only.
2. **Concurrent smoke** — many withdraw/hold-style actions at once (this _is_ stress-style testing).
3. Optional: **one careful Strix run** (budget cap, no telemetry, written rules of engagement) if you want early signal — **still not default**.

---

## LATER (staging solid · before real customer money)

1. **Strix campaign** (deeper AI pentest) on **non-prod**
2. **Independent human pentest** (outside firm or Denon-led engagement with clear report)
3. Dependency/image scanning on what you actually ship
4. Formal “requirements checklist” (ASVS-style) so “done” is not vibes

**Production:** continuous boring gates only. No wild AI hacker agents against live customer money without a formal, scoped engagement.

---

## What agents must do

1. On security / “are we safe” / “bulletproof” questions: open **this file first**, then arsenal if depth needed.
2. **Never** invent “run Strix now” unless Nitro explicitly said go **and** a non-prod target exists.
3. Prefer **Track A** work (gates, tests, scans) over shopping for new tools.
4. When adding a tool: name the **risk class**, the **phase**, and whether it is **law** or **campaign**.
5. One home for detail: arsenal doc. Do not fork a second conflicting list.

---

## Nitro’s prep checklist (so future you doesn’t re-decide)

- [x] Strix assessed and parked — `STRIX-ASSESSMENT-2026-07-29.md`
- [x] Full arsenal mapped by phase — `BULLETPROOF-ARSENAL-2026-07-29.md`
- [x] Plain when-to — **this file**
- [x] Session prompt points agents here (see `NITRO-SESSION-PROMPT.md`)
- [ ] When first staging exists: schedule **one** campaign (ZAP or Strix), not ten tools

**Your standing decision (2026-07-29):**  
Strix = **later campaign tool**. Everyday safety = **gates + money tests + audits now**. Stress testing = **one slice of near/later**, not the whole strategy.
