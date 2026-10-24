import { tgeScheduleSchema, type TgeNetwork, type TgeSchedule, type TgeView } from '@intafaced/contracts/campaigns-drops';
import { CampaignsError } from './codes.js';

/**
 * The token generation event (TGE) panel of the drop room (RC-campaigns-05, J-campaigns-20 #6).
 *
 * Nothing here posts, mints or signs. The order a claim is refused in:
 * - mainnet: `audit.external`. The protocol audit is external and not done, so no mainnet action runs. Never "audited".
 * - a blank owner schedule: `launch.schedule_unset`.
 * - a set schedule: `chain.go`. The vesting contract and its on-chain claim are not deployed.
 * The testnet path is labelled `Testnet` wherever it shows.
 */

/** Owner value. Blank is null (every claim refuses `launch.schedule_unset`); anything malformed throws at boot. */
export function parseTgeSchedule(raw: string | undefined): TgeSchedule | null {
  const value = raw?.trim();
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('CAMPAIGNS_TGE_SCHEDULE_JSON must be JSON: {"claimOpensAt":"<ISO time>"}');
  }
  const out = tgeScheduleSchema.strict().safeParse(parsed);
  if (!out.success) throw new Error('CAMPAIGNS_TGE_SCHEDULE_JSON must be {"claimOpensAt":"<ISO time with offset>"}');
  return out.data;
}

function blockerOf(network: TgeNetwork, schedule: TgeSchedule | null): TgeView['networks'][number]['blocker'] {
  if (network === 'mainnet') return 'audit.external';
  return schedule === null ? 'launch.schedule_unset' : 'chain.go';
}

export function tgeView(schedule: TgeSchedule | null): TgeView {
  return {
    schedule,
    networks: [
      { network: 'testnet', label: 'Testnet', blocker: blockerOf('testnet', schedule) },
      { network: 'mainnet', label: 'Mainnet', blocker: blockerOf('mainnet', schedule) },
    ],
  };
}

const MESSAGES = {
  'audit.external': 'A mainnet claim waits for the external security audit; nothing was posted',
  'launch.schedule_unset': 'The token schedule is not set, so there is nothing to claim; nothing was posted',
  'chain.go': 'The on-chain claim is not deployed; nothing was posted',
} as const;

/** Always refuses, by name, before anything is written. */
export function refuseTgeClaim(network: TgeNetwork, schedule: TgeSchedule | null): never {
  const code = blockerOf(network, schedule);
  throw new CampaignsError(code, MESSAGES[code]);
}
