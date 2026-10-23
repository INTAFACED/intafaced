import Link from 'next/link';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { KillSwitchBoard } from '@/components/kill-switch-board';
import { readKillSwitches } from '@/lib/control-plane-client';
import { readConsoleStatus } from '@/lib/console-status';
import { moduleKillBlockedReason } from '@/lib/desk/module-kill-model';
import { readOperatorEnv } from '@/lib/operator-env';

/**
 * Kill-switch home (§14.6 / A-P5-OPS).
 *
 * Server-loads the live control-plane snapshot so the first paint matches the edge. Flag overrides remain session
 * staging; module kills are two-founder requests the edge enforces, shown from what it returns. See the board and
 * `docs/OPS-KILL-SWITCH-RUNBOOK.md`.
 */
export default async function KillSwitchesPage() {
  requireModulePage('killswitches');
  const { session } = await requireFounderPage();
  const env = readOperatorEnv();
  const controlPlane = await readKillSwitches();
  return (
    <>
      <nav aria-label="Whole-platform views">
        <Link href="/health">Module health: volume, failures and the oldest waiting item per module</Link>
      </nav>
      <KillSwitchBoard
        drop={env.drop}
        flagEnv={env.flagEnv}
        initialControlPlane={controlPlane}
        moduleWritesBlocked={moduleKillBlockedReason(readConsoleStatus())}
        userId={session.userId}
      />
    </>
  );
}
