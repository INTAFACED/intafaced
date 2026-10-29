import { useState } from 'react';
import { mergeTokenWatchlists } from '@intafaced/contracts/protocol-watch-preferences';
import { Button, Dialog } from '../../../shared/ui';
import { useAccountTokenWatchlist } from '../watch/account-lists';
import type { TokensTranslate } from './copy';
import { readWatchlist } from './storage';

const DISMISSED_KEY = 'intafaced.tokens.import-dismissed';

function dismissedFor(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}
function dismiss(signature: string): void {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, signature);
  } catch {
    // Without session storage the offer closes for this page view only.
  }
}

/**
 * After sign-in, the tokens this browser watched while signed out are offered for import into the account's list
 * (D-portfolio-wallet-07). Only tokens the account does not already watch are offered; "Not now" closes the offer for this
 * browser session, and the browser list itself is never deleted.
 */
export function ImportWatchlist({ t }: { t: TokensTranslate }) {
  const { list, change } = useAccountTokenWatchlist();
  const [closed, setClosed] = useState(false);
  const [state, setState] = useState<'idle' | 'saving' | 'failed'>('idle');
  if (list.status !== 'ready' || closed) return null;
  const browser = readWatchlist() ?? [];
  const missing = browser.filter((entry) => !list.items.includes(entry));
  const signature = missing.join(',');
  if (missing.length === 0 || dismissedFor() === signature) return null;
  const close = () => {
    dismiss(signature);
    setClosed(true);
  };
  return (
    <Dialog title={t('importTitle')} onClose={close}>
      <p>{t('importBody', { count: String(missing.length) })}</p>
      <ul className="tokens-import">
        {missing.map((entry) => (
          <li key={entry}>{entry}</li>
        ))}
      </ul>
      {state === 'failed' && <p role="alert">{t('importFailed')}</p>}
      <div className="actions">
        <Button
          disabled={state === 'saving'}
          onClick={async () => {
            setState('saving');
            const write = await change((items) => mergeTokenWatchlists(items, browser));
            if (write.ok) setClosed(true);
            else setState('failed');
          }}
        >
          {t('importConfirm')}
        </Button>
        <Button variant="secondary" onClick={close}>
          {t('importLater')}
        </Button>
      </div>
    </Dialog>
  );
}
