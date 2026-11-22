import { useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Loading } from '../../shared/ui';
import { useSession } from '../session';
import { referralCodeCopy as copy } from './referral-code-copy';
import { IDENTITY_AFFILIATES_MY_CODE, IDENTITY_AFFILIATES_CREATE_CODE } from '@intafaced/contracts/identity-affiliates-procedures';
import { type ProcedureOutput } from '@intafaced/contracts/procedure';

// The person's short referral code beside the invitation link (CM-referral-01, J-campaigns-05 #1). The code is made on
// the first press and the same code comes back on every later one; a blank owner length refuses by name.
// hand-declared-ok: svc-identity's affiliates procedures have no browser-safe schema in packages/contracts yet

export function ReferralCode() {
  const { userId } = useSession();
  return userId ? <OwnerCode key={userId} /> : null;
}

function OwnerCode() {
  const { api } = useSession();
  const { t, Copy } = copy.useCopy();
  const { resource, reload } = useResource((signal) => api.call(IDENTITY_AFFILIATES_MY_CODE, undefined, { signal }), 'referral-code');
  const [made, setMade] = useState<ProcedureOutput<typeof IDENTITY_AFFILIATES_CREATE_CODE> | null>(null);
  const [refused, setRefused] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<'copied' | 'copyUnavailable' | null>(null);

  async function create() {
    setBusy(true);
    setRefused(null);
    // Repeating the press is safe: the service returns the same code once one exists.
    const answer = await api.call(IDENTITY_AFFILIATES_CREATE_CODE, undefined);
    setBusy(false);
    if (answer.ok) setMade(answer.data);
    else setRefused(answer);
  }
  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied('copied');
    } catch {
      setCopied('copyUnavailable');
    }
  }

  const shown = made ?? (resource.status === 'ready' ? resource.data : null);
  return (
    <section className="promotions__link" aria-label={t('title')}>
      <h2>
        <Copy k="title" />
      </h2>
      {resource.status === 'loading' && !made ? (
        <Loading />
      ) : resource.status === 'failed' && !made ? (
        <Failure result={resource.failure} retry={reload} />
      ) : shown ? (
        <>
          <p className="lt-muted">
            <Copy k="label" />
          </p>
          <p className="promotions__ref" lang="zxx" data-testid="referral-code">
            {shown.code}
          </p>
          <div className="promotions__actions">
            <Button onClick={() => void copyCode(shown.code)}>
              <Copy k="copy" />
            </Button>
          </div>
          {copied && (
            <p role="status">
              <Copy k={copied} />
            </p>
          )}
          <p className="promotions__caption">
            <Copy k="meaning" />
          </p>
        </>
      ) : (
        <>
          <h3>
            <Copy k="none" />
          </h3>
          <p className="lt-muted">
            <Copy k="noneBody" />
          </p>
          <Button disabled={busy} onClick={() => void create()}>
            <Copy k="create" />
          </Button>
        </>
      )}
      {refused && (
        <div role="alert">
          <p>
            <Copy k={refused.code === 'referral.code_length_unset' ? 'lengthUnset' : 'refused'} />
          </p>
          {refused.code && (
            <p lang="zxx">
              HTTP {refused.status} · {refused.code}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
