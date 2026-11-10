/**
 * The custody switch the journey stack runs svc-ledger and svc-bank with (`LEDGER_CUSTODY_LAYER`, OWNER 226 and 288: at
 * launch INTAFACED holds no customer money, and the custodial layer stays built but switched off). Read from this
 * command's own `LEDGER_CUSTODY_LAYER`, the same name and values the services and docker-compose.apps.yml use:
 *   - unset or empty: off, the launch build, as in compose;
 *   - `on`: the custodial layer runs, for the journeys marked `Later: custody`, which are its own proof;
 *   - anything else refuses, so a typo never picks a side.
 * Real-app journeys sets it per shard from the shard's journey files (tooling/scripts/journey-custody.mjs), and
 * tooling/scripts/journey-custody.mjs check fails the shard when a ledger or bank start ran another value.
 */
export function stackCustodyLayer(env = process.env) {
  const raw = env.LEDGER_CUSTODY_LAYER;
  if (raw === undefined || raw === '') return 'off';
  if (raw === 'on' || raw === 'off') return raw;
  throw new Error(`LEDGER_CUSTODY_LAYER is "${raw}"; leave it unset for off (the launch build), or set it to on or off.`);
}
