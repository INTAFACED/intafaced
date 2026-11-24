// volt-room: /support/guest/verify
import { useState } from 'react';
import { SUPPORT_GUEST_REQUEST_PATH } from '@intafaced/contracts/support-guest';
import { Button } from '@intafaced/ui/lit';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { useDataEnv } from '../../data/hooks';
import { writeContract } from '../../shared/contract-call';
import type { ApiResult } from '../../shared/api';
import { ServiceOffNotice } from '../../shared/service-off';
import { leaveTo } from '../../app/location';
import { guestCopy } from './support-guest-copy';
import { guestRefusalWords, guestVerify, keptToken, refusalCode } from './support-guest';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;
type GuestT = ReturnType<typeof guestCopy.useCopy>['t'];

function GuestVerifyRefusal({ refusal, t }: { refusal: Refusal; t: GuestT }) {
  const words = guestRefusalWords(refusal);
  if (words.kind === 'not-connected')
    return (
      <div role="alert" data-testid="support-guest-not-connected">
        <ServiceOffNotice code="vendor.email" action={t('verifyAction')} />
        <p className="lt-muted">{t('pendingBody')}</p>
      </div>
    );
  const sentence = words.key === 'unset' ? t('unset', { setting: words.setting }) : t(words.key);
  return (
    <p role="alert" className="lt-refusal" data-testid="support-guest-refusal" data-code={words.code ?? undefined}>
      {sentence} {words.code ? <small lang="zxx">{words.code}</small> : null}
    </p>
  );
}

/**
 * /support/guest/verify#token=… (SP-tickets-01): the page the emailed link opens, on the flow template. Opening it
 * changes nothing, so a mail scanner that fetches the link opens no request; the person presses Open. The token leaves
 * the address bar once read.
 */
export function GuestVerify() {
  const { t } = guestCopy.useCopy();
  const { api } = useDataEnv();
  // Kept for this tab only, so a reload before Open still has it while the address bar holds no token.
  const [token] = useState(() => keptToken('token', 'support-guest-verify'));
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  async function open() {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    const answer = await writeContract(api, guestVerify, { token });
    setBusy(false);
    if (answer.ok) leaveTo(`${SUPPORT_GUEST_REQUEST_PATH}#access=${answer.data.access}`);
    else setRefusal(answer);
  }

  const code = refusal ? refusalCode(refusal) : null;
  const dead = !token || code === 'support.guest_link_invalid' || code === 'support.guest_link_expired';
  const title = code === 'support.guest_link_expired' ? t('expiredTitle') : dead ? t('invalidTitle') : t('verifyTitle');
  return (
    <div data-testid="support-guest-verify">
      <FlowTemplate
        title={title}
        description={t('verifyEyebrow')}
        state={{ kind: 'ready' }}
        step={
          <div className="lt-stack">
            {dead ? (
              <div className="lt-refusal" role="alert" data-testid="support-guest-link-dead" data-code={code ?? undefined}>
                <p className="lt-refusal-body">{code === 'support.guest_link_expired' ? t('expiredBody') : t('invalidBody')}</p>
                {code ? (
                  <small className="lt-ref" lang="zxx">
                    {code}
                  </small>
                ) : null}
              </div>
            ) : (
              <>
                <p className="lt-muted">{t('verifyIntro')}</p>
                <div className="lt-actions">
                  <Button tone="primary" onClick={() => void open()} disabled={busy}>
                    {busy ? t('verifying') : t('verifyButton')}
                  </Button>
                </div>
                {refusal ? <GuestVerifyRefusal refusal={refusal} t={t} /> : null}
              </>
            )}
          </div>
        }
        help={
          <p>
            <a className="lt-link" href="/support/new" data-testid="support-guest-back">
              {t('backToForm')}
            </a>
          </p>
        }
      />
    </div>
  );
}
