import { useState } from 'react';
import { SUPPORT_GUEST_REQUEST_PATH } from '@intafaced/contracts/support-guest';
import { Button, RefusalBox } from '@intafaced/ui/lit';
import { FlowTemplate, ServiceOffNotice } from '@intafaced/ui/lit/templates';
import { useDataEnv } from '../../data/hooks';
import { writeContract } from '../../shared/contract-call';
import { serviceOffCopy } from '../../shared/service-off';
import { guestCopy } from './support-guest-copy';
import { guestVerify } from './support-guest';
import { guestRefusalSentence, keptToken, refusalCode, type Refusal } from './support-guest-link';

/**
 * /support/guest/verify#token=… (SP-tickets-01), on the flow template: the page the emailed link opens. Opening it changes
 * nothing, so a mail scanner that fetches the link opens no request; the person presses Open. The token leaves the address
 * bar once read.
 */
export function GuestVerify() {
  const { t } = guestCopy.useCopy();
  const off = serviceOffCopy.useCopy();
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
    if (answer.ok) location.assign(`${SUPPORT_GUEST_REQUEST_PATH}#access=${answer.data.access}`);
    else setRefusal(answer);
  }

  const code = refusal ? refusalCode(refusal) : null;
  const dead = !token || code === 'support.guest_link_invalid' || code === 'support.guest_link_expired';
  return (
    <div data-testid="support-guest-verify">
      <FlowTemplate
        title={code === 'support.guest_link_expired' ? t('expiredTitle') : dead ? t('invalidTitle') : t('verifyTitle')}
        description={t('verifyEyebrow')}
        state={{ kind: 'ready' }}
        step={
          dead ? (
            <RefusalBox
              refusal={{
                variant: 'refused',
                title: code === 'support.guest_link_expired' ? t('expiredBody') : t('invalidBody'),
                body: '',
                ...(code ? { reference: code } : {}),
              }}
              role="alert"
              data-testid="support-guest-link-dead"
              data-code={code ?? undefined}
            />
          ) : (
            <>
              <p>{t('verifyIntro')}</p>
              <Button tone="primary" onClick={() => void open()} disabled={busy}>
                {busy ? t('verifying') : t('verifyButton')}
              </Button>
              {refusal && code === 'vendor.email' ? (
                <div role="alert" data-testid="support-guest-not-connected">
                  <ServiceOffNotice
                    code="vendor.email"
                    sentence={off.t('sentence', { action: t('verifyAction'), dependency: off.t('vendor.email') })}
                  />
                  <p>{t('pendingBody')}</p>
                </div>
              ) : refusal ? (
                <RefusalBox
                  refusal={{
                    variant: 'refused',
                    title: guestRefusalSentence(refusal, code, t),
                    body: '',
                    ...(code ? { reference: code } : {}),
                  }}
                  role="alert"
                  data-testid="support-guest-refusal"
                  data-code={code ?? undefined}
                />
              ) : null}
            </>
          )
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
