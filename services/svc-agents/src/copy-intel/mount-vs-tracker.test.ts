import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTING_TABLE } from '../gateway/routing.js';
import { LIVE_TRADE_COPY_LEADER_PLANE_OPEN } from './live-leader-plane-refuse.js';
import {
  COPY_INTEL_BLOCKER_TRACKER_ID,
  COPY_INTEL_DECLARED_TASK,
  COPY_INTEL_MOUNTED_DOORS,
  COPY_INTEL_TRACKER_ID,
  HONEST_GAPS,
  copyIntelDeclaredTaskMatchesGuardrail,
  copyIntelDoorsInRouterSource,
  copyIntelMountMatrixComplete,
  copyIntelMountVsTrackerBoardCard,
  copyIntelMountVsTrackerExportHeader,
  copyIntelMountVsTrackerExportText,
  copyIntelMountVsTrackerStatusLineMatches,
  copyIntelTrackerBackendDoneBarMet,
  isDeclaredHonestGap,
  liveLeaderPlaneOpen,
  parseCopyIntelMountVsTrackerStatusLine,
} from './mount-vs-tracker.js';

const here = dirname(fileURLToPath(import.meta.url));
const routerSrc = () => readFileSync(join(here, '..', 'router.ts'), 'utf8');

describe('copy-intel mount vs tracker honest gaps (D26-P1-A5)', () => {
  it('names the tracker, blocker, and every honest gap code', () => {
    expect(COPY_INTEL_TRACKER_ID).toBe('agents.copy-intel');
    expect(COPY_INTEL_BLOCKER_TRACKER_ID).toBe('trade.copy');
    expect(HONEST_GAPS).toContain('gap.class_x_live_leaders');
    for (const gap of HONEST_GAPS) {
      expect(isDeclaredHonestGap(gap)).toBe(true);
    }
  });

  it('backend done bar met while live plane stays Class X sealed', () => {
    expect(LIVE_TRADE_COPY_LEADER_PLANE_OPEN).toBe(false);
    expect(liveLeaderPlaneOpen()).toBe(false);
    expect(copyIntelTrackerBackendDoneBarMet()).toBe(true);
  });

  it('guardrail declares copy_intel.stats and routing table carries the task', () => {
    expect(copyIntelDeclaredTaskMatchesGuardrail()).toBe(true);
    expect(DEFAULT_ROUTING_TABLE.routes.map((r) => r.task)).toContain(COPY_INTEL_DECLARED_TASK);
  });

  it('board card, status line, and export stay consistent', () => {
    const card = copyIntelMountVsTrackerBoardCard();
    expect(card.backendDoneBarMet).toBe(true);
    expect(copyIntelMountVsTrackerStatusLineMatches()).toBe(true);
    expect(parseCopyIntelMountVsTrackerStatusLine('bad')).toBeNull();
    expect(copyIntelMountVsTrackerExportText().startsWith(copyIntelMountVsTrackerExportHeader())).toBe(true);
  });
});

describe('copy-intel public doors are mounted on router.ts', () => {
  it('every declared door is present in the copyIntel namespace', () => {
    expect(Array.from(copyIntelDoorsInRouterSource()).sort()).toEqual(Array.from(COPY_INTEL_MOUNTED_DOORS).sort());
    expect(copyIntelMountMatrixComplete()).toBe(true);
  });

  it('runSession wires runCopyIntelStatsSession', () => {
    expect(routerSrc()).toMatch(/runCopyIntelStatsSession\(/);
  });
});
