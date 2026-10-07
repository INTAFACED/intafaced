/**
 * Copy-Intel Stage-2 — the metered `copy_intel.stats` RUN.
 *
 * Spec: docs/ops/trk/agents.copy-intel.md Stage 1–2
 * ("audited leader stats" / never invent PnL or fee share).
 *
 * Pure `stats.ts` already refuses dark planes and incomplete fixtures. This
 * module runs the same pure functions through `openSession → act → settle →
 * closeSession` so the declared toolset is enforced at call time and the run
 * settles through the one meter.
 *
 * ── What this module deliberately does NOT do ────────────────────────────────
 *
 * It does not invent fee share, profit-share bps, or follower counts. It does
 * not post ledger recipes. The only money verb is `runtime.settleSession`.
 * Stats are arithmetic over fixtures in input order only — never a
 * returns-ranked marketing board (D26-P1-A5). A clean run bills `0` honestly
 * (no engine completion).
 *
 * ── Why cheap refusals happen BEFORE the session opens ───────────────────────
 *
 * A dark copy plane is known before any tool is touched. Opening a metered
 * session to discover it would bill a user for the platform's own unreadiness.
 * A live plane without a sealed trade.copy leaders allowlist is the same class
 * of unreadiness (Class X) — refuse unbilled.
 */

import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { AgentError } from '../errors.js';
import { RefusedError, type AgentRuntime } from '../runtime.js';
import { isLiveLeaderPlaneAllowlisted, refuseLiveLeaderPlane } from './live-leader-plane-refuse.js';
import { readLiveLeaderFixtures, type CopyLeaderFixturesPort } from './live-leader-fixtures-port.js';
import { isForbiddenReturnsRankKey, refuseReturnsRankedMarketingBoard } from './returns-board-refuse.js';
import { buildLeaderStats, type AuditWrite, type CopyPlaneState, type LeaderPerformanceFixture, type LeaderStat } from './stats.js';

/** The agent id the copy-intel guardrail is registered under. */
export const COPY_INTEL_AGENT_ID = 'copy-intel';

/** Declared read — pull leader performance fixtures. */
export const COPY_INTEL_LEADERS_TOOL = 'trade.copy.leaders.read';

/**
 * Declared write — audited leader stats land through the runtime so
 * `agent_actions` records the write (provenance), not only an in-memory array.
 * Declared on the guardrail; must be invoked by the metered run.
 */
export const COPY_INTEL_STATS_WRITE_TOOL = 'trade.copy.stats.write';

export type CopyIntelRunSettlement = {
  readonly windowId: string;
  readonly amount: string;
  readonly chargeKey: string;
  readonly settled: boolean;
};

export type CopyIntelRunMetering = {
  readonly sessionId: string | null;
  readonly billedAmount: string;
  readonly assetId: string;
  readonly sessionClosed: boolean;
  readonly settlements: readonly CopyIntelRunSettlement[];
};

export type CopyIntelRunOk = {
  readonly status: 'ok';
  readonly stats: readonly LeaderStat[];
  /** Only rows that passed `trade.copy.stats.write` through the runtime. */
  readonly audit: readonly AuditWrite[];
  readonly skippedIncomplete: number;
  readonly fixturesAccepted: number;
  readonly fixturesRefusedByGuardrail: number;
  /** Built audit rows the write tool refused (budget / undeclared). */
  readonly writesRefusedByGuardrail: number;
  readonly metering: CopyIntelRunMetering;
};

export type CopyIntelRunEmpty = {
  readonly status: 'empty';
  readonly userMessageKey: 'agents.copy_intel.empty';
  readonly metering: CopyIntelRunMetering;
};

export type CopyIntelRunUnavailable = {
  readonly status: 'unavailable';
  readonly userMessageKey: 'agents.copy_intel.unavailable';
  readonly reason: 'no_data' | 'invalid_window' | 'copy_plane_dark';
  readonly metering: CopyIntelRunMetering;
};

export type CopyIntelRunRefuse = {
  readonly status: 'refuse';
  readonly reason: 'copy_plane_dark' | 'no_live_leaders' | 'writes_refused';
  readonly userMessageKey: 'agents.copy_intel.unavailable';
  readonly fixturesRefusedByGuardrail: number;
  readonly writesRefusedByGuardrail: number;
  readonly metering: CopyIntelRunMetering;
};

export type CopyIntelRunResult = CopyIntelRunOk | CopyIntelRunEmpty | CopyIntelRunUnavailable | CopyIntelRunRefuse;

function unmetered(assetId: string): CopyIntelRunMetering {
  return { sessionId: null, billedAmount: '0', assetId, sessionClosed: false, settlements: [] };
}

async function settleAndClose(
  runtime: AgentRuntime,
  sessionId: string,
  assetId: string,
  charge?: { recorded: boolean },
): Promise<CopyIntelRunMetering> {
  const results = await runtime.settleSession(sessionId);
  // The charge stands once settleSession returns. Mark it before closeSession
  // or formatAmount can throw, or the caller finally settles again and swallows that failure.
  if (charge) charge.recorded = true;
  const closed = await runtime.closeSession(sessionId);

  let total: Amount = 0n;
  for (const r of results) total += r.amount;

  return {
    sessionId,
    billedAmount: formatAmount(total),
    assetId,
    sessionClosed: closed.status === 'closed',
    settlements: results.map((r) => ({
      windowId: r.windowId,
      amount: formatAmount(r.amount),
      chargeKey: r.chargeKey,
      settled: r.settled,
    })),
  };
}

export type CopyIntelRunInput = {
  readonly runtime: AgentRuntime;
  readonly userId: string;
  readonly feeAssetId: string;
  readonly plane: CopyPlaneState;
  /**
   * Fixture/dark body rows. Ignored when `plane === 'live'` — live truth is
   * `copyLeaderFixturesPort` only.
   */
  readonly fixtures: readonly LeaderPerformanceFixture[];
  /** Required for live. Unset in production until Class X leader stats exist. */
  readonly copyLeaderFixturesPort?: CopyLeaderFixturesPort;
  readonly leaderAllowlist?: ReadonlySet<string> | readonly string[];
  readonly now?: Date;
  /**
   * D26-P1-A5 — any returns/PnL/winRate rank key is refused before the session
   * opens (never bill for a marketing board the platform forbids).
   */
  readonly rankBy?: string;
};

/**
 * Run `copy_intel.stats` as a metered, guardrailed session over pure stats.
 *
 * Each fixture is **read** through `runtime.act` on `trade.copy.leaders.read`,
 * then each audited stat is **written** through `trade.copy.stats.write`.
 * The mountain promise is "writes audited leader stats" — a pure in-memory
 * array without the write tool would leave the declared write dead on the
 * guardrail and no row in `agent_actions` for the write itself.
 * Never invents PnL for a refused or missing leader.
 */
export async function runCopyIntelStatsSession(input: CopyIntelRunInput): Promise<CopyIntelRunResult> {
  const now = input.now ?? new Date();

  // Cheap refuse — never open a metered session to build a marketing board.
  if (input.rankBy !== undefined && isForbiddenReturnsRankKey(input.rankBy)) {
    return refuseReturnsRankedMarketingBoard(input.rankBy);
  }

  if (input.plane === 'dark') {
    return {
      status: 'refuse',
      reason: 'copy_plane_dark',
      userMessageKey: 'agents.copy_intel.unavailable',
      fixturesRefusedByGuardrail: 0,
      writesRefusedByGuardrail: 0,
      metering: unmetered(input.feeAssetId),
    };
  }

  let fixtures = input.fixtures;

  if (input.plane === 'live') {
    const live = await readLiveLeaderFixtures(input.copyLeaderFixturesPort);
    if (!live.ok) {
      return {
        ...refuseLiveLeaderPlane(),
        fixturesRefusedByGuardrail: 0,
        writesRefusedByGuardrail: 0,
        metering: unmetered(input.feeAssetId),
      };
    }
    fixtures = live.fixtures;
    if (!isLiveLeaderPlaneAllowlisted(input.leaderAllowlist)) {
      return {
        ...refuseLiveLeaderPlane(),
        fixturesRefusedByGuardrail: 0,
        writesRefusedByGuardrail: 0,
        metering: unmetered(input.feeAssetId),
      };
    }
  } else if (fixtures.length === 0) {
    return {
      status: 'empty',
      userMessageKey: 'agents.copy_intel.empty',
      metering: unmetered(input.feeAssetId),
    };
  }

  const session = await input.runtime.openSession({ userId: input.userId, agentId: COPY_INTEL_AGENT_ID });

  const charge = { recorded: false };
  let metering: CopyIntelRunMetering | null = null;
  try {
    const accepted: LeaderPerformanceFixture[] = [];
    let fixturesRefusedByGuardrail = 0;

    for (const fixture of fixtures) {
      try {
        const act = await input.runtime.act({
          sessionId: session.id,
          tool: COPY_INTEL_LEADERS_TOOL,
          execute: async () => fixture,
        });
        accepted.push(act.result as LeaderPerformanceFixture);
      } catch (err) {
        if (err instanceof RefusedError) {
          fixturesRefusedByGuardrail += 1;
          continue;
        }
        throw err;
      }
    }

    if (accepted.length === 0) {
      metering = await settleAndClose(input.runtime, session.id, input.feeAssetId, charge);
      return {
        status: 'refuse',
        reason: 'no_live_leaders',
        userMessageKey: 'agents.copy_intel.unavailable',
        fixturesRefusedByGuardrail,
        writesRefusedByGuardrail: 0,
        metering,
      };
    }

    const built = buildLeaderStats(accepted, {
      now,
      copyPlane: input.plane,
      ...(input.leaderAllowlist === undefined ? {} : { leaderAllowlist: input.leaderAllowlist }),
    });

    if (built.status !== 'ok') {
      metering = await settleAndClose(input.runtime, session.id, input.feeAssetId, charge);
      if (built.status === 'empty') {
        return { status: 'empty', userMessageKey: built.userMessageKey, metering };
      }
      return {
        status: 'unavailable',
        userMessageKey: built.userMessageKey,
        reason: built.reason,
        metering,
      };
    }

    // Audited write path — each built row goes through the declared write tool.
    // Stats returned to the caller are only those that actually wrote.
    const written: AuditWrite[] = [];
    let writesRefusedByGuardrail = 0;
    for (const row of built.audit) {
      try {
        const act = await input.runtime.act({
          sessionId: session.id,
          tool: COPY_INTEL_STATS_WRITE_TOOL,
          execute: async () => row,
        });
        written.push(act.result as AuditWrite);
      } catch (err) {
        if (err instanceof RefusedError) {
          writesRefusedByGuardrail += 1;
          continue;
        }
        throw err;
      }
    }

    metering = await settleAndClose(input.runtime, session.id, input.feeAssetId, charge);

    if (written.length === 0) {
      // Built stats but could not write any — never ship unwritten "audit".
      return {
        status: 'refuse',
        reason: 'writes_refused',
        userMessageKey: 'agents.copy_intel.unavailable',
        fixturesRefusedByGuardrail,
        writesRefusedByGuardrail,
        metering,
      };
    }

    const writtenLeaderIds = new Set(written.map((w) => w.leaderId));
    return {
      status: 'ok',
      stats: built.stats.filter((s) => writtenLeaderIds.has(s.leaderId)),
      audit: written,
      skippedIncomplete: built.skippedIncomplete,
      fixturesAccepted: accepted.length,
      fixturesRefusedByGuardrail,
      writesRefusedByGuardrail,
      metering,
    };
  } finally {
    if (metering === null && !charge.recorded) {
      await settleAndClose(input.runtime, session.id, input.feeAssetId).catch(() => {
        // Original error wins.
      });
    }
  }
}

export async function registerCopyIntelAgent(runtime: AgentRuntime, guardrail: unknown): Promise<{ agentId: string; version: number }> {
  const registered = await runtime.registerAgent(guardrail);
  if (registered.agentId !== COPY_INTEL_AGENT_ID) {
    throw new AgentError(
      `Refusing to register copy-intel guardrail under agent id "${registered.agentId}"`,
      'agents.agent_not_found',
      'agents.error.route_not_found',
      { task: registered.agentId },
    );
  }
  return { agentId: registered.agentId, version: registered.version };
}
