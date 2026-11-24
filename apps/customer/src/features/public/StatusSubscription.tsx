import { useState } from 'react';
import { useLinkToken } from './status-link-token';
import { useDataEnv } from '../../data/hooks';
import { writeContract } from '../../shared/contract-call';
import type { ApiResult } from '../../shared/api';
import { Button } from '../../shared/ui';
import { statusSubscriptionConfirm, statusUnsubscribe } from './status';
import { DEAD, ManageSubscription, StatusManageRoom, type View } from './StatusManage';
import { statusSubscribeCopy } from './status-subscribe-copy';
import '../../shared/public-pages.css';
import './status-page.css';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * /status/confirm, /status/manage and /status/unsubscribe (SP-status-04): the pages the links in status mail open. Opening
 * a page changes nothing, so a mail scanner that fetches the link spends nothing; the person presses the button. The
 * token leaves the address bar once read. The manage page is on its settings template (StatusManage.tsx).
 */
export function StatusSubscriptionPage({ mode }: { mode: 'confirm' | 'manage' | 'unsubscribe' }) {
  return mode === 'manage' ? <StatusManageRoom /> : <StatusLinkPage mode={mode} />;
}

/** /status/confirm and /status/unsubscribe: one button each; a confirmed link then shows the subscription to manage. */
function StatusLinkPage({ mode }: { mode: 'confirm' | 'unsubscribe' }) {
  const { t } = statusSubscribeCopy.useCopy();
  const { api } = useDataEnv();
  const token = useLinkToken();
  const [manageToken, setManageToken] = useState<string | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  async function act() {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    if (mode === 'confirm') {
      const answer = await writeContract(api, statusSubscriptionConfirm, { token });
      if (answer.ok) {
        const { manageToken: next, ...rest } = answer.data;
        setManageToken(next);
        setView(rest);
      } else setRefusal(answer);
    } else {
      const answer = await writeContract(api, statusUnsubscribe, { token });
      if (answer.ok) setView(answer.data);
      else setRefusal(answer);
    }
    setBusy(false);
  }

  const dead = !token || DEAD.has(refusal?.code ?? '');
  const title = dead
    ? t('deadTitle')
    : mode === 'unsubscribe'
      ? view
        ? t('leftTitle')
        : t('leaveTitle')
      : mode === 'confirm' && view
        ? t('confirmedTitle')
        : mode === 'confirm'
          ? t('confirmTitle')
          : t('manageTitle');
  return (
    <div className="pub-page" data-testid={`status-subscription-${mode}`}>
      <header className="pub-heading">
        <p className="eyebrow">{t('eyebrow')}</p>
        <h1>{title}</h1>
      </header>
      {dead ? (
        <div className="pub-notice" role="alert" data-testid="status-subscription-dead">
          <p>{t('deadBody')}</p>
          {refusal?.code ? <small lang="zxx">{refusal.code}</small> : null}
        </div>
      ) : mode === 'unsubscribe' && view ? (
        <p role="status" data-testid="status-subscription-left">
          {t('leftBody')}
        </p>
      ) : !view ? (
        <>
          <p className="lt-muted">{mode === 'confirm' ? t('confirmIntro') : t('leaveIntro')}</p>
          <Button variant={mode === 'unsubscribe' ? 'danger' : 'primary'} onClick={() => void act()} disabled={busy}>
            {mode === 'confirm' ? (busy ? t('confirming') : t('confirm')) : busy ? t('leaving') : t('leave')}
          </Button>
          {refusal ? (
            <p role="alert">
              {t('failed')} <small lang="zxx">{refusal.code}</small>
            </p>
          ) : null}
        </>
      ) : view && manageToken ? (
        <ManageSubscription token={manageToken} view={view} onChange={setView} t={t} />
      ) : (
        <p role="status">{t('manageLoading')}</p>
      )}
      <p>
        <a className="lt-link" href="/status">
          {t('toStatus')}
        </a>
      </p>
    </div>
  );
}
