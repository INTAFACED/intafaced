import { requireFounderPage } from '@/lib/founder-page';
import { KillSwitchBoard } from '@/components/kill-switch-board';
import { readKillSwitches } from '@/lib/control-plane-client';
import { readOperatorEnv } from '@/lib/operator-env';

/**
 * Kill-switch home (§14.6 / A-P5-OPS).
 *
 * Server-loads the live control-plane snapshot so the first paint matches the
 * edge. Flag overrides remain session staging; module kills are live when the
 * plane is reachable — see the board and `docs/OPS-KILL-SWITCH-RUNBOOK.md`.
 */
export default async function KillSwitchesPage() {
  await requireFounderPage();
  const env = readOperatorEnv();
  const controlPlane = await readKillSwitches();
  return <KillSwitchBoard drop={env.drop} flagEnv={env.flagEnv} initialControlPlane={controlPlane} />;
}
