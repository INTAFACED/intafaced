import { useEffect, useRef, useState } from 'react';
import { usePreferences } from '../../../shared/preferences';
import type { ProtocolApi, RepresentationStatus } from '../api';
import { isRegionBlocked } from '../region';
import { walletCopy } from './copy';
import { useWallet } from './WalletProvider';

export type RepresentationEnd = { kind: 'accepted' } | { kind: 'rejected' } | { kind: 'region' } | { kind: 'failed'; message: string };

export interface RepresentationAsk {
  /** The wallet address `status` was read for: its message names this address. */
  address: string;
  status: RepresentationStatus;
  api: ProtocolApi;
  onEnd: (end: RepresentationEnd) => void;
}

/**
 * Accepting the representation (D-developer-compliance-03): the tick, and the accept that signs the exact message the
 * service returned and has it recorded. Whatever draws the representation uses this, so every room asks the same way.
 */
export function useRepresentationAccept({ address, status, api, onEnd }: RepresentationAsk): {
  agreed: boolean;
  setAgreed: (agreed: boolean) => void;
  busy: boolean;
  accept: () => Promise<void>;
} {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const wallet = useWallet();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  // An edit to the form closes the panel; an accept still in flight then ends quietly instead of starting a signature.
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
      if (isRegionBlocked(stored.code)) return end({ kind: 'region' });
      if (stored.code === 'compliance.representation_version_stale') return end({ kind: 'failed', message: t('reprStale') });
      if (stored.code === 'compliance.representation_signature_not_owner') return end({ kind: 'failed', message: t('reprNotOwner') });
      end({ kind: 'failed', message: t('reprNotRecorded') });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return { agreed, setAgreed, busy, accept };
}
