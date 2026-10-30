/**
 * OTC liquidity-provider directory and selection (CB-otc-01).
 *
 * The owner publishes the provider list and the selection cap in
 * TRADE_OTC_MAKER_DIRECTORY. Blank is an honest empty state ("No providers
 * set") and every request that names providers refuses. The cap is never
 * defaulted: a published list without a cap is refused at boot.
 *
 * A provider routed outside the platform refuses by name through the maker
 * routing socket until the owner routes it; this module never invents a
 * maker book or a routing path.
 *
 * Each provider may carry its own spread (#5 of J-copy-bots-otc-24). A spread on
 * an outside provider is a LOCAL TEST value: the stack prices that provider's
 * quote at it against house inventory, labelled TEST. Outside APP_ENV dev or
 * test such a directory is refused at boot, so production never quotes a
 * provider it has no route to.
 */

import { isExplicitDevOrTestEnv } from '@intafaced/config';
import { OtcError } from './errors.js';
import { OTC_MAKER_ROUTING_RESIDUAL, OTC_MAKER_ROUTING_SOCKET } from './maker-routing.js';

export type OtcMakerRoute = 'platform' | 'outside';

export type OtcMakerEntry = {
  readonly id: string;
  readonly name: string;
  readonly route: OtcMakerRoute;
  /** The provider's own spread in bps, 0..5000. Left out: a platform provider prices at the desk law spread. */
  readonly spreadBps?: number;
};

export type OtcMakerDirectory =
  | { readonly published: false }
  | {
      readonly published: true;
      readonly makers: readonly OtcMakerEntry[];
      readonly selectCap: number;
      /** Set only under APP_ENV dev or test: outside providers are then priced at their LOCAL TEST spreads. */
      readonly localTest?: true;
    };

export const UNPUBLISHED_OTC_MAKER_DIRECTORY: OtcMakerDirectory = { published: false };

/** Customer text for the blank provider list. */
export const OTC_MAKERS_UNSET_RESIDUAL = 'No providers set';

/** Customer text for a provider whose spread is blank. */
export const OTC_PROVIDER_SPREAD_UNSET_RESIDUAL = "This provider's spread is not set, so it cannot quote.";

const MAKER_ID = /^[a-z0-9][a-z0-9._:-]{0,119}$/;

function refuseDirectory(message: string): never {
  throw new OtcError(message, 'trade.otc_makers_unset', OTC_MAKERS_UNSET_RESIDUAL);
}

/**
 * Parse TRADE_OTC_MAKER_DIRECTORY: `{"selectCap": <int>, "makers": [{"id","name","route","spreadBps"?}]}`.
 * Blank → unpublished (empty state). Anything ambiguous fails closed. `localTest` is true only under APP_ENV dev or
 * test; without it a spread on an outside provider is refused.
 */
export function parseOtcMakerDirectoryJson(raw: string | null | undefined, options: { localTest?: boolean } = {}): OtcMakerDirectory {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return UNPUBLISHED_OTC_MAKER_DIRECTORY;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    refuseDirectory('TRADE_OTC_MAKER_DIRECTORY is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    refuseDirectory('TRADE_OTC_MAKER_DIRECTORY must be an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).some((key) => key !== 'selectCap' && key !== 'makers')) {
    refuseDirectory('TRADE_OTC_MAKER_DIRECTORY contains unsupported fields');
  }
  const cap = obj.selectCap;
  if (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap < 1) {
    refuseDirectory('TRADE_OTC_MAKER_DIRECTORY.selectCap must be a positive integer; it is never defaulted');
  }
  if (!Array.isArray(obj.makers) || obj.makers.length === 0) {
    refuseDirectory('TRADE_OTC_MAKER_DIRECTORY.makers must be a non-empty list; leave the variable blank for no providers');
  }
  const seen = new Set<string>();
  const makers: OtcMakerEntry[] = [];
  for (const item of obj.makers as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) refuseDirectory('Each provider must be an object');
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some((key) => key !== 'id' && key !== 'name' && key !== 'route' && key !== 'spreadBps')) {
      refuseDirectory('A provider contains unsupported fields');
    }
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!MAKER_ID.test(id)) refuseDirectory('A provider id is blank or malformed');
    if (!name || name.length > 120) refuseDirectory(`Provider ${id} has a blank or overlong name`);
    if (row.route !== 'platform' && row.route !== 'outside') refuseDirectory(`Provider ${id} route must be platform|outside`);
    if (seen.has(id)) refuseDirectory(`Provider ${id} is listed twice`);
    seen.add(id);
    const spread = row.spreadBps;
    if (spread === undefined || spread === null) {
      makers.push({ id, name, route: row.route });
      continue;
    }
    if (typeof spread !== 'number' || !Number.isSafeInteger(spread) || spread < 0 || spread > 5000) {
      refuseDirectory(`Provider ${id} spreadBps must be an integer from 0 to 5000`);
    }
    if (row.route === 'outside' && options.localTest !== true) {
      refuseDirectory(`Provider ${id} is outside the platform; its spread is a LOCAL TEST value, refused outside APP_ENV dev or test`);
    }
    makers.push({ id, name, route: row.route, spreadBps: spread });
  }
  return options.localTest === true
    ? { published: true, makers, selectCap: cap, localTest: true }
    : { published: true, makers, selectCap: cap };
}

/**
 * Boot loader: a malformed directory must not stop all of svc-trade. It is
 * logged and the OTC provider routes stay in the refusing empty state.
 */
export function loadOtcMakerDirectory(
  raw: string | null | undefined,
  onInvalid: (message: string) => void,
  localTest: boolean = isExplicitDevOrTestEnv(),
): OtcMakerDirectory {
  try {
    return parseOtcMakerDirectoryJson(raw, { localTest });
  } catch (err) {
    if (!(err instanceof OtcError)) throw err;
    onInvalid(err.message);
    return UNPUBLISHED_OTC_MAKER_DIRECTORY;
  }
}

/** `trade.otc.makers.list`: blank list is an honest empty state, never a sample provider. */
export function listOtcMakers(directory: OtcMakerDirectory) {
  if (!directory.published) {
    return { published: false as const, makers: [] as OtcMakerEntry[], selectCap: null, emptyLabel: OTC_MAKERS_UNSET_RESIDUAL };
  }
  return { published: true as const, makers: [...directory.makers], selectCap: directory.selectCap, emptyLabel: null };
}

/**
 * Validate a multi-select of providers for one request.
 * Order of refusals: blank list, empty pick, over cap, duplicate, unknown, outside route. Under LOCAL TEST an outside
 * provider is not refused by its route on a platform desk (`pricesLocalTest`): it is priced at its TEST spread, and a
 * blank spread refuses it by name.
 */
export function selectOtcMakers(
  directory: OtcMakerDirectory,
  makerIds: readonly string[],
  { pricesLocalTest = true }: { pricesLocalTest?: boolean } = {},
): OtcMakerEntry[] {
  if (!directory.published) {
    throw new OtcError('No providers are set — the request refuses', 'trade.otc_makers_unset', OTC_MAKERS_UNSET_RESIDUAL);
  }
  const ids = makerIds.map((id) => id.trim());
  if (ids.length === 0 || ids.some((id) => id === '')) {
    throw new OtcError('Pick at least one provider; a blank provider is refused', 'trade.otc_provider_required');
  }
  if (ids.length > directory.selectCap) {
    throw new OtcError(
      `At most ${directory.selectCap} providers can be picked for one request (got ${ids.length})`,
      'trade.otc_provider_cap',
    );
  }
  if (new Set(ids).size !== ids.length) {
    throw new OtcError('A provider was picked twice', 'trade.otc_provider_required');
  }
  const byId = new Map(directory.makers.map((maker) => [maker.id, maker]));
  const picked: OtcMakerEntry[] = [];
  for (const id of ids) {
    const maker = byId.get(id);
    if (!maker) throw new OtcError(`Provider ${id} is not in the provider list`, 'trade.otc_provider_unknown');
    if (maker.route === 'outside' && directory.localTest === true && pricesLocalTest) {
      if (maker.spreadBps === undefined) {
        throw new OtcError(
          `The spread for provider ${id} is not set — the request refuses`,
          'trade.otc_provider_spread_unset',
          OTC_PROVIDER_SPREAD_UNSET_RESIDUAL,
        );
      }
    } else if (maker.route === 'outside') {
      // An outside provider is the NotConnected `feed.market` class from the allowlist, never a code of the desk's own.
      throw new OtcError(
        `Provider ${id} is outside the platform — ${OTC_MAKER_ROUTING_SOCKET} refuses until the owner routes it`,
        'feed.market',
        OTC_MAKER_ROUTING_RESIDUAL,
      );
    }
    picked.push(maker);
  }
  return picked;
}
