import { useEffect, useRef, useState } from 'react';
import { Button, Panel } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import type { ProtocolApi, RepresentationStatus } from '../api';
import { REGION_BLOCKED_CODE } from '../region';
import { walletCopy } from './copy';
import { useWallet } from './WalletProvider';

export type RepresentationEnd = { kind: 'accepted' } | { kind: 'rejected' } | { kind: 'region' } | { kind: 'failed'; message: string };

/**
 * The representation a wallet accepts once per version before its first signing action (D-developer-compliance-03). The
 * person reads the published text, ticks the box and signs the exact message the service returned; the service records
 * it with its version and time only after it checks that this address signed it. Nothing else is offered until then.
 */
export function RepresentationPanel({
  address,
  status,
  api,
  onEnd,
}: {
  /** The wallet address `status` was read for: its message names this address. */
  address: string;
  status: RepresentationStatus;
  api: ProtocolApi;
  onEnd: (end: RepresentationEnd) => void;
}) {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const wallet = useWallet();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  // An edit to the form closes this panel; an accept still in flight then ends quietly instead of starting a signature.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const end = (result: RepresentationEnd) => {
    if (mounted.current) onEnd(result);
  };

  const accept = async () => {
    // The message names the address it was read for; a wallet switched to another account since cannot sign it.
    if (!wallet.address || wallet.address.toLowerCase() !== address.toLowerCase())
      return end({ kind: 'failed', message: t('reprWalletChanged') });
    setBusy(true);
    try {
      const signed = await wallet.sign({ kind: 'message', message: status.message });
      if (signed.status === 'rejected') return end({ kind: 'rejected' });
      if (signed.status !== 'signed')
        return end({ kind: 'failed', message: signed.status === 'failed' ? signed.message : t('reprFailed') });
      const stored = await api.representationAccept({ address, version: status.version, signature: signed.signature });
      if (stored.ok) return end({ kind: 'accepted' });
      if (stored.code === REGION_BLOCKED_CODE) return end({ kind: 'region' });
      if (stored.code === 'compliance.representation_version_stale') return end({ kind: 'failed', message: t('reprStale') });
      if (stored.code === 'compliance.representation_signature_not_owner') return end({ kind: 'failed', message: t('reprNotOwner') });
      end({ kind: 'failed', message: t('reprNotRecorded') });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <Panel title={t('reprTitle')}>
      <div data-panel="representation" data-version={status.version}>
        <p className="muted">{t('reprNote')}</p>
        <blockquote data-representation-text>{status.text}</blockquote>
        <p className="muted">{t('reprVersion', { version: status.version })}</p>
        <label className="field field--inline">
          <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
          <span>{t('reprAgree')}</span>
        </label>
        <Button disabled={!agreed || busy} onClick={() => void accept()}>
          {t('reprAccept')}
        </Button>
      </div>
    </Panel>
  );
}
