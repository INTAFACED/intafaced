/** Explicit legacy test adapters. Never imported by production boot. */
import { randomUUID } from 'node:crypto';
import type { Principal } from '@intafaced/auth';
import type { CommittedOperationAdmission } from '@intafaced/contracts';
import { TradeService as ProductionTradeService } from '../spot/trade-service.js';
import {
  PositionService as ProductionPositionService,
  type OpenPositionInput,
  type SetLeverageInput,
} from '../futures/position-service.js';
import { CopyService as ProductionCopyService } from '../copy/copy-service.js';
import { OtcDeskService as ProductionOtcDeskService } from '../otc/otc-service.js';
import { principalFor } from '../spot/testing.js';
import { canonicalPayload, type TradingAdmissionPort } from './trading-controls.js';
import { createHash } from 'node:crypto';

export function readyTestAdmission(): TradingAdmissionPort {
  const parents = new Map<string, { payload: unknown; admission: CommittedOperationAdmission; grantId: string }>();
  return {
    async admit(principal, kind, businessId, payload) {
      const admission: CommittedOperationAdmission = {
        operation: { service: 'svc-trade', kind, userId: principal.userId },
        businessId,
        payloadHash: 'sha256:' + createHash('sha256').update(canonicalPayload(payload)).digest('hex'),
        status: 'committed',
        admissionId: randomUUID(),
        admittedAt: new Date().toISOString(),
        identityVersion: '0',
        restrictionVersion: '0',
      };
      if (kind === 'strategy.start')
        parents.set(principal.userId + ':' + businessId, { payload, admission, grantId: admission.admissionId });
      return admission;
    },
    async admitStanding(userId, _instructionId, businessId, payload) {
      return this.admit(principalFor(userId), 'order.place', businessId, payload);
    },
    async original(userId, businessId) {
      return parents.get(userId + ':' + businessId) ?? null;
    },
    async resolve(userId, businessId) {
      return parents.get(userId + ':' + businessId) ?? null;
    },
  };
}
const bySql = new WeakMap<object, TradingAdmissionPort>();
function readyForSql(sql: object): TradingAdmissionPort {
  let port = bySql.get(sql);
  if (!port) {
    port = readyTestAdmission();
    bySql.set(sql, port);
  }
  return port;
}
export class TradeService extends ProductionTradeService {
  constructor(...args: ConstructorParameters<typeof ProductionTradeService>) {
    const [sql, ledger, matching, perks, bus, options = {}] = args;
    super(sql, ledger, matching, perks, bus, { ...options, accountAdmission: options.accountAdmission ?? readyForSql(sql) });
  }
}
export class PositionService extends ProductionPositionService {
  constructor(...args: ConstructorParameters<typeof ProductionPositionService>) {
    const [sql, ledger, deps] = args;
    super(sql, ledger, { ...deps, accountAdmission: deps.accountAdmission ?? readyForSql(sql) });
  }
  override open(input: OpenPositionInput, principal?: Principal, context?: { readonly region?: string | null }) {
    return super.open(input, principal ?? principalFor(input.userId), context);
  }
  override setLeverage(input: SetLeverageInput, principal?: Principal) {
    return super.setLeverage(input, principal ?? principalFor(input.userId));
  }
}
export class CopyService extends ProductionCopyService {
  constructor(...args: ConstructorParameters<typeof ProductionCopyService>) {
    const [ledger, options = {}] = args;
    super(ledger, {
      ...options,
      accountAdmission: options.accountAdmission ?? readyTestAdmission(),
      // Legacy mirror tests predate the disclosure gate. A published TEST law
      // lets them reach their own assertions. Production boot never uses this.
      disclosureLaw: options.disclosureLaw ?? { published: true, version: 'TEST', text: 'TEST' },
    });
  }

  override planMirrorForFollow(
    principal: Principal,
    input: Parameters<ProductionCopyService['planMirrorForFollow']>[1],
  ): ReturnType<ProductionCopyService['planMirrorForFollow']> {
    return this.withLegacyDisclosure(principal, () => super.planMirrorForFollow(principal, input));
  }

  override placeMirrorForFollow(
    principal: Principal,
    input: Parameters<ProductionCopyService['placeMirrorForFollow']>[1],
  ): ReturnType<ProductionCopyService['placeMirrorForFollow']> {
    return this.withLegacyDisclosure(principal, () => super.placeMirrorForFollow(principal, input));
  }

  private async withLegacyDisclosure<T>(principal: Principal, run: () => Promise<T>): Promise<T> {
    const view = await this.disclosure(principal);
    if (view.published && view.version && !view.accepted) {
      await this.acceptDisclosure(principal, { version: view.version, clientAcceptId: 'TEST-legacy-mirror' });
    }
    return run();
  }
}
export class OtcDeskService extends ProductionOtcDeskService {
  constructor(...args: ConstructorParameters<typeof ProductionOtcDeskService>) {
    const [ledger, stakes, options = {}] = args;
    super(ledger, stakes, { ...options, accountAdmission: options.accountAdmission ?? readyTestAdmission() });
  }
}
