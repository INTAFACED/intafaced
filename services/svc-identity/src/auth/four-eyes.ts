/**
 * Four-eyes / attribution (PTX-M01-R04 PTX-M01-R05 / CARD A19).
 * Policy change, key change, and high-risk transfer without dual-control refuse.
 * Session/API-key id survives onto order/fill/ledger or named refuse.
 * Do not invent approval thresholds. Hitch wraps AuthService without recutting router.ts.
 */
import { TRPCError } from '@intafaced/contracts/trpc';
import { AuthService } from './auth-service.js';

export const DUAL_CONTROL_MISSING = 'dual_control_missing' as const;
export const ATTRIBUTION_MISSING = 'attribution_missing' as const;

export const DUAL_CONTROL_MISSING_MESSAGE =
  'policy change, key change, and high-risk transfer require dual-control; identity does not invent a second approver';
export const ATTRIBUTION_MISSING_MESSAGE = 'session or API-key id is required on order/fill/ledger; identity does not invent attribution';

const FLAG = Symbol.for('intafaced.identity.four-eyes');
const ATTR_FLAG = Symbol.for('intafaced.identity.api-key-attribution');

export type DualControlCmd = {
  readonly actorId?: string | null;
  readonly confirmActorId?: string | null;
};

export type FourEyesKind = 'policy' | 'key' | 'high_risk_transfer';

export type FourEyesRefuse = {
  readonly accepted: false;
  readonly kind: FourEyesKind;
  readonly rejected: { readonly code: typeof DUAL_CONTROL_MISSING; readonly message: string };
};

export type FourEyesOk = {
  readonly accepted: true;
  readonly kind: FourEyesKind;
  readonly actorId: string;
  readonly confirmActorId: string;
};

export type AttributionStamp = {
  readonly sessionId: string | null;
  readonly apiKeyId: string | null;
};

export type AttributionOk = {
  readonly accepted: true;
  readonly stamp: AttributionStamp;
};

export type AttributionRefuse = {
  readonly accepted: false;
  readonly stamp: null;
  readonly rejected: { readonly code: typeof ATTRIBUTION_MISSING; readonly message: string };
};

function readRequired(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Owner approval thresholds stay unpublished. Never a default count. */
export function approvalThresholdsUnset(): boolean {
  return true;
}

export function dualControlRefuse(cmd: DualControlCmd): {
  readonly code: typeof DUAL_CONTROL_MISSING;
  readonly message: string;
} | null {
  const actorId = readRequired(cmd.actorId ?? null);
  const confirmActorId = readRequired(cmd.confirmActorId ?? null);
  if (actorId === null) {
    return { code: DUAL_CONTROL_MISSING, message: DUAL_CONTROL_MISSING_MESSAGE };
  }
  if (confirmActorId === null) {
    return { code: DUAL_CONTROL_MISSING, message: DUAL_CONTROL_MISSING_MESSAGE };
  }
  if (confirmActorId === actorId) {
    return { code: DUAL_CONTROL_MISSING, message: DUAL_CONTROL_MISSING_MESSAGE };
  }
  return null;
}

export function fourEyes(kind: FourEyesKind, cmd: DualControlCmd): FourEyesOk | FourEyesRefuse {
  const refused = dualControlRefuse(cmd);
  if (refused) {
    return { accepted: false, kind, rejected: refused };
  }
  return {
    accepted: true,
    kind,
    actorId: readRequired(cmd.actorId) as string,
    confirmActorId: readRequired(cmd.confirmActorId) as string,
  };
}

export function stampAttribution(input: {
  readonly sessionId?: string | null;
  readonly apiKeyId?: string | null;
}): AttributionOk | AttributionRefuse {
  const sessionId = readRequired(input.sessionId ?? null);
  const apiKeyId = readRequired(input.apiKeyId ?? null);
  if (sessionId === null && apiKeyId === null) {
    return {
      accepted: false,
      stamp: null,
      rejected: { code: ATTRIBUTION_MISSING, message: ATTRIBUTION_MISSING_MESSAGE },
    };
  }
  return { accepted: true, stamp: { sessionId, apiKeyId } };
}

export function attributionOnLedger(stamp: AttributionStamp): AttributionStamp {
  return { sessionId: stamp.sessionId, apiKeyId: stamp.apiKeyId };
}

export function attributionOnOrder(stamp: AttributionStamp): AttributionStamp {
  return { sessionId: stamp.sessionId, apiKeyId: stamp.apiKeyId };
}

export function attributionOnFill(stamp: AttributionStamp): AttributionStamp {
  return { sessionId: stamp.sessionId, apiKeyId: stamp.apiKeyId };
}

export class AttributionError extends Error {
  constructor(
    message: string,
    readonly code: typeof ATTRIBUTION_MISSING,
  ) {
    super(message);
    this.name = 'AttributionError';
  }
}

export type AttributedSurfaces = {
  readonly order: AttributionStamp;
  readonly fill: AttributionStamp;
  readonly ledger: AttributionStamp;
};

export function requireAttribution(input: { readonly sessionId?: string | null; readonly apiKeyId?: string | null }): AttributionStamp {
  const stamped = stampAttribution(input);
  if (!stamped.accepted) {
    throw new AttributionError(stamped.rejected.message, stamped.rejected.code);
  }
  return stamped.stamp;
}

export function attributedSurfaces(stamp: AttributionStamp): AttributedSurfaces {
  return {
    order: attributionOnOrder(stamp),
    fill: attributionOnFill(stamp),
    ledger: attributionOnLedger(stamp),
  };
}

function refuseMissingAttribution(input: { readonly sessionId?: string | null; readonly apiKeyId?: string | null }): AttributionStamp {
  try {
    return requireAttribution(input);
  } catch (err) {
    if (err instanceof AttributionError) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `${err.message} [${err.code}]`,
        cause: err,
      });
    }
    throw err;
  }
}

/**
 * Mint / exchange / assert cannot succeed without a session or API-key id on
 * the stamp. Wraps the live AuthService methods — does not recut router.ts.
 */
export function installApiKeyAttribution(auth: AuthService): void {
  const tagged = auth as AuthService & { [ATTR_FLAG]?: true };
  if (tagged[ATTR_FLAG]) return;
  tagged[ATTR_FLAG] = true;

  const createApiKey = auth.createApiKey.bind(auth);
  auth.createApiKey = async (input) => {
    const result = await createApiKey(input);
    refuseMissingAttribution({ apiKeyId: result.id });
    return result;
  };

  const exchangeApiKey = auth.exchangeApiKey.bind(auth);
  auth.exchangeApiKey = async (key, requestOrigin) => {
    const result = await exchangeApiKey(key, requestOrigin);
    refuseMissingAttribution({ apiKeyId: result.keyId });
    return result;
  };

  const assertApiKeyLive = auth.assertApiKeyLive.bind(auth);
  auth.assertApiKeyLive = async (keyId) => {
    const result = await assertApiKeyLive(keyId);
    refuseMissingAttribution({ apiKeyId: result.id });
    return result;
  };
}

export function installFourEyes(ctor: typeof AuthService = AuthService): void {
  const proto = ctor.prototype as {
    changePolicy?: (cmd: DualControlCmd) => FourEyesOk | FourEyesRefuse;
    changeKey?: (cmd: DualControlCmd) => FourEyesOk | FourEyesRefuse;
    highRiskTransfer?: (cmd: DualControlCmd) => FourEyesOk | FourEyesRefuse;
    stampAttribution?: (input: {
      readonly sessionId?: string | null;
      readonly apiKeyId?: string | null;
    }) => AttributionOk | AttributionRefuse;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  proto.changePolicy = function (this: AuthService, cmd: DualControlCmd) {
    return fourEyes('policy', cmd);
  };
  proto.changeKey = function (this: AuthService, cmd: DualControlCmd) {
    return fourEyes('key', cmd);
  };
  proto.highRiskTransfer = function (this: AuthService, cmd: DualControlCmd) {
    return fourEyes('high_risk_transfer', cmd);
  };
  proto.stampAttribution = function (this: AuthService, input: { readonly sessionId?: string | null; readonly apiKeyId?: string | null }) {
    return stampAttribution(input);
  };
}

try {
  installFourEyes();
} catch {
  queueMicrotask(() => installFourEyes());
}
