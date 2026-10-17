> **SUPERSEDED 2026-07-29** — audit closed on main (#80+#81). Do not paste as a new open job. Floor: `docs/PEACE-OF-MIND-AUDIT-CURRENT.md` · next: `docs/WAVE-AUDIT.md`.

# Paste this into a **new** chat — Audit V2 (residual + proof)

**Do not paste into an old compacted chat.** New session.  
**Wave-1 is done** (PR #80). This chat continues residual money + method upgrades only.

---

## PASTE FROM HERE

```
AUDIT V2 — residual money + proof upgrades (Nitro operator mode)

You have full autonomous control. I am non-technical. Do not hand me git homework
or technical multiple-choice. Escalate ONLY on the whitelist below.

READ FIRST (in order):
1. docs/PEACE-OF-MIND-AUDIT-CURRENT.md          ← floor scoreboard
2. docs/AUDIT-V2-RESIDUAL-AND-STRESS-2026-07-29.md  ← this wave’s law
3. docs/audit/2026-07-29/02-FINDINGS.md
4. docs/audit/2026-07-29/03-ADVERSARIAL-PASS.md     ← honesty of wave-1 methods
5. docs/PLAN-META-AUDIT-FULL-AUDIT-PROGRAM-2026-07-29.md  ← method upgrades
6. AGENTS.md · INTAFACED_DEFINITIVE_BUILD.md §0 · AGENT_PROTOCOL.md

WAVE-1 STATUS (do not re-do unless regression):
- Full A→E ran on baseline a19e337
- P0 open doors FIXED on PR https://github.com/Phantom-X-007/intafaced/pull/80
  (protocol /trpc mount, awardXp service-only, pay ownership IDOR, internal HMAC,
   dex ports, brand/format CI, tracker honesty)
- Residual P1 NOT fixed: L3-1 withdraw reverse atomicity; L3-2 token stake
  claim-before-post; L3-3 earn deposit claim-before-post
- Vendor quarantined (not product money)

GOAL THIS CHAT:
Track A: fix residual P1 money crash windows (L3-1, L3-2, L3-3) with real tests.
Track B: proof upgrades (L0 machine notes, money journey table, threat model,
  ≥1 property-test invariant, cheat-diff on every fix PR).
Track D optional: short concurrent smoke (k6/autocannon) only after fixes.
Update PEACE-OF-MIND residual when A lands.
Do NOT restart full monorepo archaeology. Do NOT rebuild services.

METHOD (mandatory — wave-1 was weaker here):
1. Worktree only — never main checkout. Prefer stack on main after #80 merges,
   or stack carefully if #80 still open (do not fight that PR’s scope).
2. Machine proof first: pnpm scan:brand, scan:custody, verify on fix branches.
3. Every money fix: crash-midway matrix + invariant/regression test that
   proves the bug class.
4. Maker-checker: critic is FRESH CONTEXT, READ-ONLY, assume broken; prefer
   CROSS-FAMILY model for P1; critic never implements the fix.
5. False-done check on every fix diff (assertion strip, empty catch,
   type-suppression on money files) — swarm-orchestrator style or home greps.
6. Prefer growing tooling/ci scanners over one-off LLM claims.
7. Durable docs with claim-tags; chat = decision altitude only.
8. Auto-decide technical forks; safer doctrine default.

ESCALATION WHITELIST ONLY:
- Vendor becomes product money path
- Live custody / go-live with real money
- Jurisdiction beyond doctrine
- Real spend / production credentials

DEFAULT AUTONOMY:
- Create worktrees, implement P1 fixes, open PRs, run verify, update scoreboard
- Park P2 with reason; do not ask me about worktrees or whether to run verify
- Silence toward Denon unless I ask

TOOLS YOU SHOULD USE (high ROI):
- Existing monorepo gates (verify, brand, custody, DoD)
- fast-check property tests on ledger/hold invariants
- Structural cheat-diff checks
- Optional Semgrep CE rules if greps insufficient
- Optional short k6/autocannon concurrent smoke AFTER claim-before-post fixes
- ShopPay-style business-logic checklist for prompts (do not vendor the repo in)

TOOLS YOU SHOULD NOT BOIL THE OCEAN WITH:
- Full vendor UI line audit
- Live pentest against production
- Whole-monorepo mutation testing
- 50 parallel agents on screenshots

DONE WHEN:
1. L3-1/2/3 fixed or blocked with written reason
2. Each has proof test + critic note + verify evidence
3. PEACE-OF-MIND residual queue updated (plain language)
4. docs/audit/2026-07-29/04-L0-MACHINE.md + 05-THREAT-MODEL.md + journey table
5. I open PEACE-OF-MIND and know: safe enough to keep building / not go-live yet

First actions this session:
1. git fetch; confirm PR #80 CI; worktree for residual
2. Re-read L3-1/2/3 evidence in source (fail closed if already fixed upstream)
3. Implement in severity order L3-1 → L3-2 → L3-3
4. Proof upgrades in parallel where independent
5. Update scoreboard; open PRs; report links + residual only
```

## END PASTE
