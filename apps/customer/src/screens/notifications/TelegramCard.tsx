import { useId, useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import { usePreferences } from '../../shared/preferences';
import { stamp } from '../money/time';
import { LoadFailed, Loading, StateTag } from './parts';
import { telegramCopy } from './telegram-copy';
import { useTelegram } from './telegram-source';

type Issued = { command: string; expiresAt: string };
type Note = 'unlinkedDone' | 'failed';

/**
 * Telegram on the preferences page (J-charts-desk-21 #1, #6): whether it is set up on the platform, linked (with the
 * chat's handle) or not, the one-time code to send to the bot, and Unlink. The bot only reads: nothing sent in the chat
 * can trade, cancel or move money.
 */
export function TelegramCard() {
  const copy = telegramCopy.useCopy();
  const id = useId();
  const { status, linkCode, unlink, refresh } = useTelegram();
  const { timeZone } = usePreferences();
  const when = (iso: string) => stamp(iso, timeZone);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(act: () => Promise<Note | null>) {
    setBusy(true);
    setNote(null);
    try {
      setNote(await act());
    } catch {
      // A call that throws (the network, not a refusal) is still a failure the person is told about.
      setNote('failed');
    } finally {
      setBusy(false);
      refresh();
    }
  }

  if (status.status === 'loading') return <Loading label={copy.t('title')} rows={2} />;
  if (status.status !== 'ready') return <LoadFailed title={copy.t('loadFailed')} retryLabel={copy.t('tryAgain')} onRetry={refresh} />;
  const s = status.data;
  const linked = s.state === 'linked';
  // A code once linked is spent: the page stops showing it.
  const code = s.state === 'unlinked' ? issued : null;

  return (
    <section aria-labelledby={`${id}-title`} data-testid="nf-telegram" data-state={s.state}>
      <h2 id={`${id}-title`}>{copy.t('title')}</h2>
      <p className="lt-hint">{copy.t('intro')}</p>
      <div className="lt-actions">
        <span className="lt-lines">
          <span data-testid="nf-telegram-state" aria-live="polite">
            {s.state === 'off'
              ? copy.t(s.reason === 'notify.out_of_app_off' ? 'offOutOfApp' : 'offToken')
              : s.state === 'linked'
                ? s.handle
                  ? copy.t('linked', { handle: s.handle, when: when(s.linkedAt) })
                  : copy.t('linkedNoHandle', { when: when(s.linkedAt) })
                : copy.t('unlinked')}
          </span>
          {s.state !== 'off' && s.test && <span className="lt-hint">{copy.t('testBot')}</span>}
        </span>
        {s.state !== 'off' && s.test && <StateTag>{copy.t('testTag')}</StateTag>}
        {s.state === 'off' ? (
          <Button tone="secondary" disabled aria-describedby={`${id}-off`}>
            {copy.t('connect')}
          </Button>
        ) : linked ? (
          <Button
            tone="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const out = await unlink();
                if (!out.ok) return 'failed';
                setIssued(null);
                return 'unlinkedDone';
              })
            }
          >
            {copy.t('unlink')}
          </Button>
        ) : (
          <Button
            tone="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const out = await linkCode();
                if (!out.ok) return 'failed';
                setIssued({ command: out.data.command, expiresAt: out.data.expiresAt });
                return null;
              })
            }
          >
            {copy.t(code ? 'newCode' : 'connect')}
          </Button>
        )}
      </div>
      {s.state === 'off' && (
        <p className="lt-hint" id={`${id}-off`}>
          {copy.t(s.reason === 'notify.out_of_app_off' ? 'offOutOfApp' : 'offToken')}
        </p>
      )}
      {code && s.state === 'unlinked' && (
        <div data-testid="nf-telegram-code">
          <p>{s.bot ? copy.t('sendThis', { bot: s.bot }) : copy.t('sendThisNoBot')}</p>
          <p>
            <code lang="zxx" data-testid="nf-telegram-command">
              {code.command}
            </code>
          </p>
          <p className="lt-hint" data-testid="nf-telegram-expiry" data-expires-at={code.expiresAt}>
            {copy.t('validFor', { when: when(code.expiresAt) })}
          </p>
          <p className="lt-hint">{copy.t('waiting')}</p>
        </div>
      )}
      {note && (
        <p className="lt-hint" role="status" data-testid="nf-telegram-note">
          {copy.t(note)}
        </p>
      )}
    </section>
  );
}
