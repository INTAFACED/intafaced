import { EffectiveSettings } from '@/components/effective-settings';
import { loadComplianceStatus } from '@/lib/compliance/server';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { readOperatorEnv } from '@/lib/operator-env';
import { flagOverrides, settingRows } from '@/lib/settings/effective';

/**
 * Platform settings (`/system/settings`, founder screen F75; OPS-admin-access-08): the settings this console runs with and
 * every blank one with the action it stops, svc-edge's own screening and network posture, and the flag overrides on this
 * process. Names and presence only: no secret value leaves the server, and nothing blank is filled in.
 */
export const dynamic = 'force-dynamic';

export default async function PlatformSettingsPage() {
  requireModulePage('merchants');
  await requireFounderPage();
  const deployment = readOperatorEnv();
  const edge = await loadComplianceStatus();
  const edgeAsOf = new Date().toISOString();
  return (
    <EffectiveSettings
      rows={settingRows(process.env)}
      deployment={{ appEnv: deployment.appEnv, drop: String(deployment.drop) }}
      edge={edge}
      edgeAsOf={edgeAsOf}
      flags={flagOverrides(process.env)}
    />
  );
}
