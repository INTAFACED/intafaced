import {
  createEdgeContext,
  rawBodyOf,
  verifyServiceHeaders,
  SERVICE_HEADER,
  type EdgeContextOptions,
  type EdgeRequest,
} from '@intafaced/contracts';

type IdentityContextOptions = EdgeContextOptions & {
  operationAdmissionSecrets?: Partial<Record<'svc-trade' | 'svc-pay', string>>;
  privateAuthoritySecret?: string;
  edgeAuthoritySecret?: string;
};

type ReadSecretOptions = Pick<
  IdentityContextOptions,
  'internalSecret' | 'operationAdmissionSecrets' | 'privateAuthoritySecret' | 'edgeAuthoritySecret'
>;
export function identityAuthorityReadSecret(options: ReadSecretOptions, reader: 'svc-ws' | 'svc-edge'): string | null {
  const secret = reader === 'svc-ws' ? options.privateAuthoritySecret : options.edgeAuthoritySecret;
  const other = reader === 'svc-ws' ? options.edgeAuthoritySecret : options.privateAuthoritySecret;
  return secret &&
    secret.length >= 32 &&
    secret !== options.internalSecret &&
    secret !== other &&
    !Object.values(options.operationAdmissionSecrets ?? {}).includes(secret)
    ? secret
    : null;
}
export function identityWsAuthoritySecret(options: ReadSecretOptions): string | null {
  return identityAuthorityReadSecret(options, 'svc-ws');
}

function ownerSecret(options: IdentityContextOptions, owner: 'svc-trade' | 'svc-pay'): string | null {
  const secret = options.operationAdmissionSecrets?.[owner];
  const other = options.operationAdmissionSecrets?.[owner === 'svc-trade' ? 'svc-pay' : 'svc-trade'];
  return secret &&
    secret.length >= 32 &&
    secret !== options.internalSecret &&
    secret !== other &&
    secret !== options.privateAuthoritySecret &&
    secret !== options.edgeAuthoritySecret
    ? secret
    : null;
}

/** Configuration only; request authentication and database admission remain separate. */
export function configuredIdentityOperationOwners(options: IdentityContextOptions) {
  return {
    tradeKeyConfigured: ownerSecret(options, 'svc-trade') !== null,
    payKeyConfigured: ownerSecret(options, 'svc-pay') !== null,
    wsAuthorityKeyConfigured: identityWsAuthoritySecret(options) !== null,
    edgeAuthorityKeyConfigured: identityAuthorityReadSecret(options, 'svc-edge') !== null,
  };
}

/** Preserve exact bytes for delegated reads and owner operation decisions. */
export function createIdentityRequestContext(options: IdentityContextOptions) {
  const regular = createEdgeContext(options);
  return (req: EdgeRequest & { url: string; body?: unknown }) => {
    const context = regular(req);
    let procedures: string[];
    try {
      procedures =
        decodeURIComponent(req.url.split('?')[0] ?? '')
          .split('/')
          .at(-1)
          ?.split(',') ?? [];
    } catch {
      return { ...context, service: null };
    }
    const reader = req.headers[SERVICE_HEADER];
    if ((reader === 'svc-ws' || reader === 'svc-edge') && procedures.includes('accountControls.currentAuthority')) {
      if (procedures.some((name) => name !== 'accountControls.currentAuthority')) return { ...context, service: null };
      const secret = identityAuthorityReadSecret(options, reader);
      const rawBody = typeof req.body === 'string' ? { retained: true as const, bytes: Buffer.from(req.body, 'utf8') } : rawBodyOf(req);
      return { ...context, service: secret ? verifyServiceHeaders(req.headers, secret, { mode: 'require', rawBody }).service : null };
    }
    if (procedures.includes('operationAdmission.decide')) {
      // Owner keys authorize only this procedure, never a mixed service batch.
      if (procedures.some((name) => name !== 'operationAdmission.decide')) return { ...context, service: null };
      const owner = req.headers[SERVICE_HEADER];
      const secret = owner === 'svc-trade' || owner === 'svc-pay' ? ownerSecret(options, owner) : null;
      const rawBody = typeof req.body === 'string' ? { retained: true as const, bytes: Buffer.from(req.body, 'utf8') } : rawBodyOf(req);
      const service = secret ? verifyServiceHeaders(req.headers, secret, { mode: 'require', rawBody }).service : null;
      return { ...context, service };
    }
    const requiresBody = procedures.some(
      (name) => name === 'accountControls.operatorEntitlement' || name === 'accountControls.currentAuthority',
    );
    if (!requiresBody) return context;
    // The tRPC Fastify adapter replaces the shared JSON parser and preserves
    // incoming UTF-8 text in req.body. Bind that exact text, never reserialize
    // an already-parsed object. Other body shapes must have retained bytes.
    const rawBody = typeof req.body === 'string' ? { retained: true as const, bytes: Buffer.from(req.body, 'utf8') } : rawBodyOf(req);
    const service = options.internalSecret
      ? verifyServiceHeaders(req.headers, options.internalSecret, { mode: 'require', rawBody }).service
      : null;
    return { ...context, service };
  };
}
