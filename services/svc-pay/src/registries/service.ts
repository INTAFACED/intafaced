import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { requireDualControl } from '../dual-control.js';
import { consumePayApproval, payActionPayloadHash, type ActionApprovalConsumer } from '../action-approval-consume.js';
import { RegistryError } from './errors.js';
import { compareDecimal } from './decimal.js';
import {
  isNetworkRoutable,
  isVenueRoutable,
  isWalletRouteRoutable,
  networkDualReasons,
  networkMissing,
  normalizeNetwork,
  normalizeVenue,
  normalizeWalletRoute,
  venueDualReasons,
  venueMissing,
  walletRouteDualReasons,
  walletRouteMissing,
  type NetworkState,
  type VenueState,
  type WalletRouteState,
} from './policy.js';
import type {
  NetworkSaveInput,
  NetworkView,
  RegistryEventView,
  RegistryKind,
  RegistryPreviewInput,
  VenueHealthView,
  VenueSaveInput,
  VenueView,
  WalletRouteSaveInput,
  WalletRouteView,
} from './schemas.js';
import * as store from './store.js';

/**
 * Venue keys that exist in `@intafaced/venue-adapter` today
 * (`PUBLIC_MARKET_DATA_VENUE_IDS`). svc-pay does not depend on that package, so
 * this is a mirror, injectable via `knownVenueKeys`; a test pins it to the source
 * file's literal list so the two cannot drift silently.
 */
export const KNOWN_VENUE_KEYS: readonly string[] = ['binance-spot', 'bybit-spot', 'okx-spot'];

/** The action an identity approval must be issued for. */
export const REGISTRY_CHANGE_ACTION = 'pay.registry_change';

export interface RegistryServiceDeps {
  sql: Sql;
  /** Identity-bound second-founder approvals. An unwired consumer refuses every dual-control change. */
  approvals: ActionApprovalConsumer;
  knownVenueKeys?: readonly string[];
  /** Health passthrough from venue-adapter. Absent or null means "unknown", shown as such. */
  venueHealth?: (venueId: string) => VenueHealthView | null;
}

interface Plan<S> {
  registry: RegistryKind;
  key: string;
  before: store.Stamp | null;
  beforeState: S | null;
  after: S;
  reasons: string[];
  hashFields: Record<string, string>;
}

const iso = (d: Date) => d.toISOString();
const stampOf = (s: store.Stamp) => ({ version: s.version, updatedAt: iso(s.updatedAt), updatedBy: s.updatedBy });

export class RegistryService {
  private readonly sql: Sql;
  private readonly approvals: ActionApprovalConsumer;
  private readonly known: readonly string[];
  private readonly health: (venueId: string) => VenueHealthView | null;

  constructor(deps: RegistryServiceDeps) {
    this.sql = deps.sql;
    this.approvals = deps.approvals;
    this.known = deps.knownVenueKeys ?? KNOWN_VENUE_KEYS;
    this.health = deps.venueHealth ?? (() => null);
  }

  // ── reads (founder panel: everything, routable or not) ────────────────────
  async listVenues(): Promise<VenueView[]> {
    return (await store.listVenues(this.sql)).map((v) => this.venueView(v));
  }
  async listNetworks(): Promise<NetworkView[]> {
    return (await store.listNetworks(this.sql)).map(networkView);
  }
  async listWalletRoutes(): Promise<WalletRouteView[]> {
    return (await store.listWalletRoutes(this.sql)).map(walletRouteView);
  }
  async history(registry: RegistryKind, entryKey: string | undefined, limit: number): Promise<RegistryEventView[]> {
    const rows = await store.listEvents(this.sql, registry, entryKey, limit);
    return rows.map((r) => ({
      id: r.id,
      seq: String(r.seq),
      registry: r.registry,
      entryKey: r.entry_key,
      action: r.action,
      actorId: r.actor_id,
      approverId: r.approver_id,
      dualControl: r.dual_control,
      before: r.before,
      after: r.after,
      reason: r.reason,
      createdAt: iso(r.created_at),
    }));
  }

  // ── preview: what would this change need? ─────────────────────────────────
  async preview(
    input: RegistryPreviewInput,
  ): Promise<{ needsDualControl: boolean; reasons: string[]; actionType: string; payloadHash: string }> {
    const plan =
      input.registry === 'venue'
        ? await this.planVenue(input.change)
        : input.registry === 'network'
          ? await this.planNetwork(input.change)
          : await this.planWalletRoute(input.change);
    return {
      needsDualControl: plan.reasons.length > 0,
      reasons: plan.reasons,
      actionType: REGISTRY_CHANGE_ACTION,
      payloadHash: payActionPayloadHash(REGISTRY_CHANGE_ACTION, plan.hashFields),
    };
  }

  // ── writes ────────────────────────────────────────────────────────────────
  async saveVenue(actorId: string, input: VenueSaveInput): Promise<VenueView> {
    const plan = await this.planVenue(input);
    const approverId = await this.secondFounder(actorId, input, plan);
    const saved = await this.commit(plan, actorId, approverId, input.reason, {
      get: (tx) => store.getVenue(tx, plan.key, true),
      insert: (tx) => store.insertVenue(tx, plan.after, actorId),
      update: (tx) => store.updateVenue(tx, plan.after, actorId),
    });
    return this.venueView(saved);
  }

  async saveNetwork(actorId: string, input: NetworkSaveInput): Promise<NetworkView> {
    const plan = await this.planNetwork(input);
    const approverId = await this.secondFounder(actorId, input, plan);
    const saved = await this.commit(plan, actorId, approverId, input.reason, {
      get: (tx) => store.getNetwork(tx, plan.key, true),
      insert: (tx) => store.insertNetwork(tx, plan.after, actorId),
      update: (tx) => store.updateNetwork(tx, plan.after, actorId),
    });
    return networkView(saved);
  }

  async saveWalletRoute(actorId: string, input: WalletRouteSaveInput): Promise<WalletRouteView> {
    const plan = await this.planWalletRoute(input);
    const approverId = await this.secondFounder(actorId, input, plan);
    const saved = await this.commit(plan, actorId, approverId, input.reason, {
      get: (tx) => store.getWalletRoute(tx, plan.after.assetCode, plan.after.networkId, true),
      insert: (tx) => store.insertWalletRoute(tx, plan.after, actorId),
      update: (tx) => store.updateWalletRoute(tx, plan.after, actorId),
    });
    return walletRouteView(saved);
  }

  // ── planning (pure of side effects: reads only) ───────────────────────────
  private async planVenue(input: VenueSaveInput): Promise<Plan<VenueState>> {
    // Live is refused before anything else, preview included: it needs a later explicit founder GO and a config flag.
    if (input.mode === 'live') {
      throw new RegistryError(
        'registries.live_mode_refused',
        'live mode is not available; venues are testnet-only until a founder GO and a config flag exist',
      );
    }
    if (!this.known.includes(input.venueId)) {
      throw new RegistryError('registries.venue_unknown', `"${input.venueId}" is not a venue-adapter venue key`);
    }
    if (input.enabled && input.mode !== 'testnet') {
      throw new RegistryError('registries.enabled_needs_testnet', 'only a testnet venue can be enabled');
    }
    if (input.minOrder !== null && input.maxOrder !== null && compareDecimal(input.minOrder, input.maxOrder) > 0) {
      throw new RegistryError('registries.limits_inverted', 'minOrder is above maxOrder');
    }
    const after = normalizeVenue({
      venueId: input.venueId,
      displayName: input.displayName,
      mode: input.mode,
      priority: input.priority,
      enabled: input.enabled,
      minOrder: input.minOrder,
      maxOrder: input.maxOrder,
      supportedPairs: input.supportedPairs,
    });
    const before = await store.getVenue(this.sql, input.venueId);
    this.checkVersion(before, input.expectedVersion);
    this.checkInertCreate(before, after.enabled);
    const beforeState = before && store.stateOf(before);
    return this.plan('venue', input.venueId, before, beforeState, after, input.expectedVersion, venueDualReasons(beforeState, after));
  }

  private async planNetwork(input: NetworkSaveInput): Promise<Plan<NetworkState>> {
    const after = normalizeNetwork({
      networkId: input.networkId,
      displayName: input.displayName,
      assetCodes: input.assetCodes,
      confirmationsRequired: input.confirmationsRequired,
      enabled: input.enabled,
      feeEstimateSource: input.feeEstimateSource,
      feeEstimateAmount: input.feeEstimateAmount,
    });
    const before = await store.getNetwork(this.sql, input.networkId);
    this.checkVersion(before, input.expectedVersion);
    this.checkInertCreate(before, after.enabled);
    const beforeState = before && store.stateOf(before);
    return this.plan('network', input.networkId, before, beforeState, after, input.expectedVersion, networkDualReasons(beforeState, after));
  }

  private async planWalletRoute(input: WalletRouteSaveInput): Promise<Plan<WalletRouteState>> {
    const network = await store.getNetwork(this.sql, input.networkId);
    if (network === null)
      throw new RegistryError('registries.network_unknown', `network "${input.networkId}" is not in the network registry`);
    if (!network.assetCodes.includes(input.assetCode)) {
      throw new RegistryError('registries.asset_not_on_network', `${input.assetCode} is not listed on network "${input.networkId}"`);
    }
    const after = normalizeWalletRoute({
      assetCode: input.assetCode,
      networkId: input.networkId,
      payoutAllowed: input.payoutAllowed,
      merchantAllow: input.merchantAllow,
      merchantDeny: input.merchantDeny,
      maxSinglePayout: input.maxSinglePayout,
    });
    const before = await store.getWalletRoute(this.sql, input.assetCode, input.networkId);
    this.checkVersion(before, input.expectedVersion);
    this.checkInertCreate(before, after.payoutAllowed);
    const beforeState = before && store.walletRouteState(before);
    return this.plan(
      'wallet_route',
      `${input.assetCode}:${input.networkId}`,
      before,
      beforeState,
      after,
      input.expectedVersion,
      walletRouteDualReasons(beforeState, after),
    );
  }

  private plan<S extends object>(
    registry: RegistryKind,
    key: string,
    before: store.Stamp | null,
    beforeState: S | null,
    after: S,
    expectedVersion: number | null,
    reasons: string[],
  ): Plan<S> {
    return {
      registry,
      key,
      before,
      beforeState,
      after,
      reasons,
      hashFields: { registry, key, expectedVersion: String(expectedVersion), after: JSON.stringify(after) },
    };
  }

  private checkVersion(current: store.Stamp | null, expected: number | null): void {
    if (expected === null) {
      if (current !== null) throw new RegistryError('registries.already_exists', 'the entry exists; send its current version to edit it');
      return;
    }
    if (current === null) throw new RegistryError('registries.not_found', 'no such entry to edit');
    if (current.version !== expected)
      throw new RegistryError('registries.version_conflict', 'the entry changed since you loaded it; reload and retry');
  }

  /** A new entry starts switched off. Switching it on is an edit, and edits that switch things on need a second founder. */
  private checkInertCreate(current: unknown, switchedOn: boolean): void {
    if (current === null && switchedOn) {
      throw new RegistryError(
        'registries.create_must_be_inert',
        'create the entry switched off, then enable it as a separate, dual-controlled change',
      );
    }
  }

  /** Dual control: a distinct, identity-verified approver bound to this exact change. Returns the approver id, or null when none is needed. */
  private async secondFounder(
    actorId: string,
    approval: { approvalId?: string | null | undefined; operationId?: string | null | undefined },
    plan: Plan<object>,
  ): Promise<string | null> {
    if (plan.reasons.length === 0) return null;
    const approver = await consumePayApproval(this.approvals, approval, REGISTRY_CHANGE_ACTION, plan.hashFields);
    return requireDualControl(actorId.toLowerCase(), approver.trim().toLowerCase());
  }

  private async commit<S extends object, R extends S & store.Stamp>(
    plan: Plan<S>,
    actorId: string,
    approverId: string | null,
    reason: string,
    ops: {
      get: (tx: Sql) => Promise<store.Stamp | null>;
      insert: (tx: Sql) => Promise<R>;
      update: (tx: Sql) => Promise<R>;
    },
  ): Promise<R> {
    try {
      return await transaction(this.sql, async (tx) => {
        const current = await ops.get(tx);
        if (plan.before === null ? current !== null : current === null || current.version !== plan.before.version) {
          throw new RegistryError('registries.version_conflict', 'the entry changed while the change was being approved; reload and retry');
        }
        const saved = plan.before === null ? await ops.insert(tx) : await ops.update(tx);
        await store.appendEvent(tx, {
          registry: plan.registry,
          entryKey: plan.key,
          action: plan.before === null ? 'create' : 'update',
          actorId,
          approverId,
          before: plan.beforeState,
          after: plan.after,
          reason,
        });
        return saved;
      });
    } catch (error) {
      if ((error as { code?: string } | null)?.code === '23505') {
        throw new RegistryError('registries.already_exists', 'the entry was created by someone else first');
      }
      throw error;
    }
  }

  private venueView(v: store.Stored<VenueState>): VenueView {
    const missing = venueMissing(v);
    return {
      venueId: v.venueId,
      displayName: v.displayName,
      mode: v.mode,
      priority: v.priority,
      enabled: v.enabled,
      minOrder: v.minOrder,
      maxOrder: v.maxOrder,
      supportedPairs: v.supportedPairs,
      health: this.health(v.venueId),
      routable: isVenueRoutable(v),
      missing,
      ...stampOf(v),
    };
  }
}

function networkView(n: store.Stored<NetworkState>): NetworkView {
  return {
    networkId: n.networkId,
    displayName: n.displayName,
    assetCodes: n.assetCodes,
    confirmationsRequired: n.confirmationsRequired,
    enabled: n.enabled,
    feeEstimateSource: n.feeEstimateSource,
    feeEstimateAmount: n.feeEstimateAmount,
    routable: isNetworkRoutable(n),
    missing: networkMissing(n),
    ...stampOf(n),
  };
}

function walletRouteView(w: store.StoredWalletRoute): WalletRouteView {
  return {
    routeId: w.routeId,
    assetCode: w.assetCode,
    networkId: w.networkId,
    payoutAllowed: w.payoutAllowed,
    merchantAllow: w.merchantAllow,
    merchantDeny: w.merchantDeny,
    maxSinglePayout: w.maxSinglePayout,
    routable: isWalletRouteRoutable(w),
    missing: walletRouteMissing(w),
    ...stampOf(w),
  };
}
