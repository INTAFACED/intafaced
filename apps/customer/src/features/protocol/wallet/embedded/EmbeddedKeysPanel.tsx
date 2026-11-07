import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { EMBEDDED_EXPORT_SPENT, embeddedExportMessage } from '@intafaced/contracts/protocol-embedded';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { Button, Dialog, Field, Panel } from '../../../../shared/ui';
import { usePreferences } from '../../../../shared/preferences';
import { useApi } from '../../../session/session';
import { createProtocolApi } from '../../api';
import { APP_CHAIN_ID } from '../eip1193';
import { embeddedCopy } from './embedded-copy';
import { createVault, markSpent, readVault, unwrapOnce, VaultRefusedError, type VaultRecord } from './vault';

/** How long a shown key stays on screen. */
const SHOW_MS = 60_000;
type Problem = 'storageBlocked' | 'prfUnsupported' | 'passkeyCancelled' | 'spent' | 'statusFailed' | 'recordFailed' | 'phraseWrong';

const problemOf = (err: unknown): Problem =>
  err instanceof VaultRefusedError
    ? err.code === 'wallet.storage_blocked'
      ? 'storageBlocked'
      : err.code === 'wallet.passkey_prf_unsupported'
        ? 'prfUnsupported'
        : err.code === 'wallet.export_spent'
          ? 'spent'
          : 'passkeyCancelled'
    : 'passkeyCancelled';

/**
 * /wallet/embedded (RC-dex-protocol-05): the embedded login made and kept on this device, and its key shown once. Export
 * needs the typed phrase and a fresh passkey check, asks the service first whether the key was already shown on any
 * device (`wallet.export_spent`), then shows the key with copy and a 60-second hide, and records the fact: on this device,
 * and with the service through a message the key signs. The key is cleared from the page on hide or when the tab loses
 * focus. It never leaves the browser.
 */
export function EmbeddedKeysPanel() {
  const { language } = usePreferences();
  const { t } = embeddedCopy.forLocale(language);
  const transport = useApi();
  const api = useMemo(() => createProtocolApi(transport), [transport]);
  const [record, setRecord] = useState<VaultRecord | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [key, setKey] = useState<Hex | null>(null);
  const [hidden, setHidden] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setKey((shown) => {
      if (shown) setHidden(true);
      return null;
    });
  }, []);

  useEffect(() => {
    let live = true;
    readVault()
      .then(async (found) => {
        if (!live) return;
        setRecord(found);
        // A record of the export that did not reach the service is sent again with the same signature.
        if (found?.spent && found.exportSignature)
          await api.embeddedMarkExported({ account: found.address, signature: found.exportSignature });
      })
      .catch((err) => {
        if (!live) return;
        setRecord(null);
        setProblem(problemOf(err));
      });
    return () => {
      live = false;
    };
  }, [api]);

  useEffect(() => {
    window.addEventListener('blur', hide);
    document.addEventListener('visibilitychange', hide);
    return () => {
      window.removeEventListener('blur', hide);
      document.removeEventListener('visibilitychange', hide);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [hide]);

  async function create() {
    setProblem(null);
    setBusy(true);
    try {
      setRecord(await createVault('INTAFACED'));
    } catch (err) {
      setProblem(problemOf(err));
    } finally {
      setBusy(false);
    }
  }

  function openExport() {
    setProblem(null);
    // A key this device already showed is refused at once, with no passkey check.
    if (record?.spent) return setProblem('spent');
    setConfirming(true);
  }

  async function exportOnce(phrase: string) {
    if (!record) return;
    if (phrase.trim() !== t('phrase')) return setProblem('phraseWrong');
    setProblem(null);
    setBusy(true);
    try {
      const status = await api.embeddedStatus(record.address);
      if (!status.ok) return setProblem('statusFailed');
      if (status.data.exported) {
        setRecord(await markSpent(record));
        setConfirming(false);
        return setProblem('spent');
      }
      const shown = await unwrapOnce(record);
      const signature = await privateKeyToAccount(shown).signMessage({ message: embeddedExportMessage(record.address, APP_CHAIN_ID) });
      const spent = await markSpent(record, signature);
      setRecord(spent);
      setConfirming(false);
      setHidden(false);
      setKey(shown);
      timer.current = setTimeout(hide, SHOW_MS);
      const marked = await api.embeddedMarkExported({ account: record.address, signature });
      if (!marked.ok) setProblem('recordFailed');
    } catch (err) {
      setProblem(problemOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title={t('title')}>
      <p className="muted">{t('note')}</p>
      <p className="muted">{t('connectedNote')}</p>
      {record === null && (
        <>
          <p>{t('none')}</p>
          <Button disabled={busy} onClick={() => void create()}>
            {busy ? t('creating') : t('create')}
          </Button>
        </>
      )}
      {record && (
        <>
          <dl className="protocol-facts">
            <div>
              <dt>{t('owner')}</dt>
              <dd className="numeric" data-testid="embedded-owner">
                {record.address}
              </dd>
            </div>
          </dl>
          <p className="muted">{t('exportNote')}</p>
          <Button variant="secondary" disabled={busy || key !== null} onClick={openExport}>
            {t('export')}
          </Button>
        </>
      )}
      {key && (
        <section aria-label={t('keyTitle')}>
          <p role="note">
            <strong>{t('warning')}</strong> {t('keyNote')}
          </p>
          <pre className="numeric" data-testid="exported-key">
            {key}
          </pre>
          <Button
            variant="secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(key).then(() => setCopied(true));
            }}
          >
            {t('copy')}
          </Button>{' '}
          <Button variant="secondary" onClick={hide}>
            {t('hide')}
          </Button>
          {copied && <span role="status">{t('copied')}</span>}
        </section>
      )}
      {hidden && !key && <p role="status">{t('hidden')}</p>}
      {problem && !confirming && (
        <p role="alert" data-code={problem === 'spent' ? EMBEDDED_EXPORT_SPENT : undefined}>
          {t(problem)}
        </p>
      )}
      {confirming && (
        <ConfirmDialog
          busy={busy}
          problem={problem}
          onClose={() => {
            setConfirming(false);
            setProblem(null);
          }}
          onConfirm={(phrase) => void exportOnce(phrase)}
        />
      )}
    </Panel>
  );
}

function ConfirmDialog({
  busy,
  problem,
  onClose,
  onConfirm,
}: {
  busy: boolean;
  problem: Problem | null;
  onClose: () => void;
  onConfirm: (phrase: string) => void;
}) {
  const { language } = usePreferences();
  const { t } = embeddedCopy.forLocale(language);
  const [phrase, setPhrase] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onConfirm(phrase);
  };
  return (
    <Dialog title={t('confirmTitle')} onClose={onClose}>
      <form className="protocol-quote" onSubmit={submit}>
        <p role="note">
          <strong>{t('warning')}</strong>
        </p>
        <Field label={t('phraseLabel')} value={phrase} autoComplete="off" onChange={(event) => setPhrase(event.target.value)} />
        {busy && <p role="status">{t('checking')}</p>}
        {problem && <p role="alert">{t(problem)}</p>}
        <div className="actions">
          <Button type="submit" disabled={busy}>
            {t('show')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
