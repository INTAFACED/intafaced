import { AdminSessionError, adminSessionErrorResponse, authorizeAdminRequest, founderEdgeCall } from '@/lib/founder-session';
import { NO_STORE, SECURITY_UPSTREAM } from './guard';

export const dynamic = 'force-dynamic';

interface Passkey {
  id: string;
  name?: string;
  createdAt?: string;
}

const isoOrNull = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))) return value;
  throw new AdminSessionError('admin.upstream_invalid', 502);
};

/** `webauthn.list` answers `[{credentialId, createdAt, transports?}]`. Anything else is refused rather than guessed at. */
function passkeys(raw: unknown): Passkey[] {
  if (!Array.isArray(raw) || raw.length > 200) throw new AdminSessionError('admin.upstream_invalid', 502);
  return raw.map((row: unknown) => {
    const item = row as { credentialId?: unknown; id?: unknown; name?: unknown; createdAt?: unknown } | null;
    const id = item?.credentialId ?? item?.id;
    if (typeof id !== 'string' || id.length < 1 || id.length > 1024) throw new AdminSessionError('admin.upstream_invalid', 502);
    return {
      id,
      ...(typeof item?.name === 'string' && item.name.length <= 100 ? { name: item.name } : {}),
      ...(typeof item?.createdAt === 'string' && item.createdAt.length <= 40 ? { createdAt: item.createdAt } : {}),
    };
  });
}

export async function GET(request: Request) {
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const [overview, list] = await Promise.all([
      founderEdgeCall(config, 'identity', 'auth.securityOverview', 'GET', {}, session.accessToken),
      // Passkeys may be switched off on the server. The other cards still work then, so a refusal here is reported, not fatal.
      founderEdgeCall(config, 'identity', 'webauthn.list', 'GET', { limit: 50 }, session.accessToken).then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const }),
      ),
    ]);
    const row = overview as {
      totpEnrolled?: unknown;
      totpEnrolledAt?: unknown;
      recoveryCodesRemaining?: unknown;
      passwordChangedAt?: unknown;
    } | null;
    if (
      !row ||
      typeof row.totpEnrolled !== 'boolean' ||
      typeof row.recoveryCodesRemaining !== 'number' ||
      !Number.isInteger(row.recoveryCodesRemaining) ||
      row.recoveryCodesRemaining < 0 ||
      row.recoveryCodesRemaining > 1000
    )
      throw new AdminSessionError('admin.upstream_invalid', 502);
    return Response.json(
      {
        totpEnrolled: row.totpEnrolled,
        totpEnrolledAt: isoOrNull(row.totpEnrolledAt ?? null),
        recoveryCodesRemaining: row.recoveryCodesRemaining,
        passkeys: list.ok ? passkeys(list.value) : [],
        passkeysAvailable: list.ok,
        passwordChangedAt: isoOrNull(row.passwordChangedAt ?? null),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    return adminSessionErrorResponse(error, SECURITY_UPSTREAM);
  }
}
