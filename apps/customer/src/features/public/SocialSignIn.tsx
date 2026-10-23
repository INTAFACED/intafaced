import { useRef, useState } from 'react';
import { z } from 'zod';
import { useSession } from '../session/session';
import type { ApiResult } from '../../shared/api';
import { Button, Failure } from '../../shared/ui';
import { socialSignInCopy } from './social-sign-in-copy';
import './social-sign-in.css';

// hand-declared-ok: svc-identity's auth.oauthStart answer has no browser-safe schema in packages/contracts yet
const startedSchema = z.object({ provider: z.string(), authorizationUrl: z.string().url(), expiresAt: z.string() });

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type Kind = 'social' | 'wallet';
const WORDED = ['idp.social', 'identity.social_provider_config_incomplete', 'identity.social_flow_ttl_unset'] as const;

/**
 * Social and wallet sign-in buttons (I-signin-sessions-21). Each press asks the service to start (`auth.oauthStart`);
 * with no provider registered the service answers `idp.social`, and the page says so with the code. A ready provider
 * would answer an https address to go to. The buttons never name an outside company.
 */
export function SocialSignIn() {
  const { t } = socialSignInCopy.useCopy();
  const { api } = useSession();
  const [busy, setBusy] = useState<Kind | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const running = useRef(false);

  async function start(kind: Kind) {
    if (running.current) return;
    running.current = true;
    setBusy(kind);
    setRefusal(null);
    const answer = await api.mutate('identity', 'auth.oauthStart', { provider: kind }, startedSchema);
    const target = answer.ok ? new URL(answer.data.authorizationUrl) : null;
    if (target?.protocol === 'https:') {
      // The buttons stay busy while the browser leaves, so a second press cannot start a second flow.
      location.assign(target.href);
      return;
    }
    running.current = false;
    setBusy(null);
    setRefusal(answer.ok ? { ok: false, reason: 'error', message: t('unsafe') } : answer);
  }

  const code = (WORDED as readonly string[]).includes(refusal?.code ?? '') ? (refusal!.code as (typeof WORDED)[number]) : undefined;
  return (
    <div className="public-auth-social">
      <p className="muted">{t('or')}</p>
      {(['social', 'wallet'] as const).map((kind) => (
        <Button key={kind} variant="secondary" disabled={busy !== null} onClick={() => void start(kind)}>
          {busy === kind ? t('starting') : t(kind)}
        </Button>
      ))}
      {code ? (
        <div className="pub-notice" role="alert">
          <p>{t(code)}</p>
          <small lang="zxx">{code}</small>
        </div>
      ) : (
        refusal && <Failure result={refusal} />
      )}
    </div>
  );
}
