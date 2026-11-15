import 'server-only';
import type { ActionApproval } from '@intafaced/contracts';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import { parseApproval } from './approvals-parse';
import type { Outcome } from './outcome';
import {
  MM_SEED_ACTION_TYPE,
  MM_SEED_POLICY_VERSION,
  MM_SEED_TARGET_SERVICE,
  parseSeedConfigRow,
  parseSeedConfigs,
  seedConfigPayloadHash,
  type SeedConfigBody,
  type SeedConfigRow,
} from './seeding-model';

/** svc-trade admin.marketMaker.seedConfigs: every market's latest seeding version. */
export function readSeedConfigs(ctx: TradeCtx): Promise<Outcome<readonly SeedConfigRow[]>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.marketMaker.seedConfigs', 'query', undefined, parseSeedConfigs));
}

/** identity actionApproval.propose, bound to the hash of exactly this configuration for this market and version. */
export function proposeSeedConfig(ctx: TradeCtx, body: SeedConfigBody): Promise<Outcome<ActionApproval>> {
  return edgeCall(
    ctx,
    trpcSpec(
      'identity',
      'actionApproval.propose',
      'mutation',
      {
        actionType: MM_SEED_ACTION_TYPE,
        targetService: MM_SEED_TARGET_SERVICE,
        targetId: body.market,
        expectedVersion: body.expectedVersion,
        payloadHash: seedConfigPayloadHash(body),
        policyVersion: MM_SEED_POLICY_VERSION,
      },
      parseApproval,
    ),
  );
}

/** svc-trade admin.marketMaker.setSeedConfig: consumes the approval under its own operation id and writes the version. */
export function writeSeedConfig(
  ctx: TradeCtx,
  body: SeedConfigBody & { readonly approvalId: string; readonly clientRequestId: string },
): Promise<Outcome<SeedConfigRow>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.marketMaker.setSeedConfig', 'mutation', body, parseSeedConfigRow));
}
