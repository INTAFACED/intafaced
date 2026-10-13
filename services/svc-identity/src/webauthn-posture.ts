import { isProductionPosture } from '@intafaced/config';

/**
 * A real server must not run WebAuthn against the development relying party.
 *
 * `WEBAUTHN_RP_ID` defaults to `localhost` and `WEBAUTHN_ORIGIN` to `http://localhost:3000` so a laptop works with
 * no setup. A production host that forgot to set them would (a) register passkeys bound to `localhost`, which can
 * never sign in at the real domain, and (b) accept `clientDataJSON.origin` values from a local page. The production-posture
 * scan in `loadEnv` only sees variables that are SET, so it cannot see a default; this checks the parsed values.
 * Messages name the variable, never the value.
 */
export const WEBAUTHN_RP_UNPUBLISHED_CODE = 'identity.webauthn_rp_unpublished' as const;

const LOCAL = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0|[^.]+\.localhost)\.?$/i;

export function webauthnPostureIssues(
  parsed: { WEBAUTHN_ENABLED: boolean; WEBAUTHN_RP_ID: string; WEBAUTHN_ORIGIN: string },
  raw: Record<string, unknown> = process.env,
): string[] {
  if (!parsed.WEBAUTHN_ENABLED || !isProductionPosture(raw)) return [];
  const issues: string[] = [];
  if (LOCAL.test(parsed.WEBAUTHN_RP_ID.trim())) {
    issues.push('WEBAUTHN_RP_ID is the local development relying party (set the real registrable domain, or WEBAUTHN_ENABLED=off)');
  }
  for (const origin of parsed.WEBAUTHN_ORIGIN.split(',')) {
    let url: URL | null = null;
    try {
      url = new URL(origin.trim());
    } catch {
      url = null;
    }
    if (url === null || url.protocol !== 'https:' || LOCAL.test(url.hostname)) {
      issues.push('WEBAUTHN_ORIGIN must be an https origin on the real domain, not a local or non-https one');
      break;
    }
  }
  return issues;
}

export function assertWebauthnPosture(
  parsed: Parameters<typeof webauthnPostureIssues>[0],
  raw: Record<string, unknown> = process.env,
): void {
  const issues = webauthnPostureIssues(parsed, raw);
  if (issues.length > 0) throw new Error(`${WEBAUTHN_RP_UNPUBLISHED_CODE}: refusing to start.\n  - ${issues.join('\n  - ')}`);
}
