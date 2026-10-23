# Claim TRK-ops.notifications

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** merged
**owner:** cursor-swarm-notify
**slice:** residual-N
**proof:** #991 merged 2026-08-07 — persist mute prefs so restarts cannot silently unmute
**tip:** feat/ops-notifications-residual
**updated:** 2026-08-07 (claim closed against merged main)

Mute API existed on MemoryMuteStore only — prefs vanished on restart. Shipped: persist channel mutes; prove muted refusal vs critical bypass. No gateway credentials.

> Closed by the claim-board honesty pass. The code merged; the claim was never closed, so
> `swarm:freeze` kept reporting this mountain as owned by a session that no longer exists.
> Residual noted above (if any) is unchanged and still real — closing the claim closes the
> SLICE, not the mountain. Mountain state lives in `tooling/tracker/features.mjs`.
