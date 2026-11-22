import type { ReactNode } from 'react';
import { Button, Dialog } from '../../../shared/ui';
import { usePreferences } from '../../../shared/preferences';
import { walletCopy } from './copy';
import { payloadText, describeRequest } from './eip1193';
import { useWallet, WalletCore, type SequenceSheetProps, type SignSheetProps, type WalletParts } from './wallet-core';

export * from './wallet-core';

/**
 * The wallet in the old look, for every room not yet drawn from the kit: the same logic as `KitWalletProvider`
 * (`wallet-core.tsx`), with this file's gate and sheets. `scope`, `chainId` and `gate` as `WalletCore` names them.
 */
export function WalletProvider(props: { children: ReactNode; discovery?: boolean; gate?: boolean; scope?: string; chainId?: number }) {
  return <WalletCore {...props} parts={OLD_PARTS} />;
}

/** What sits behind a wallet: nothing renders until a remembered wallet has answered, so no control offers Connect first. */
export function WalletGate({ children }: { children: ReactNode }) {
  const { status } = useWallet();
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  return status === 'restoring' ? (
    <p className="muted" role="status" aria-busy="true" data-wallet="restoring">
      {t('restoring')}
    </p>
  ) : (
    children
  );
}

/** The plain-words sheet that comes before every wallet prompt: what, which contract, amount, spender and expiry. */
export function SignSheet({ request, account, chainId, onCancel, onContinue }: SignSheetProps) {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const facts = describeRequest(request);
  return (
    <Dialog title={t('sheetTitle')} onClose={onCancel}>
      <div data-sheet="sign">
        <p>{t(request.kind === 'transaction' ? 'sheetSends' : request.kind === 'message' ? 'sheetSignsMessage' : 'sheetSignsData')}</p>
        <dl className="protocol-facts">
          <div>
            <dt>{t('fact_account')}</dt>
            <dd className="numeric">{account}</dd>
          </div>
          <div>
            <dt>{t('fact_network')}</dt>
            <dd>{chainId}</dd>
          </div>
          {facts.map((fact, index) => (
            <div key={`${fact.label}:${index}`}>
              <dt>{t(`fact_${fact.label}`)}</dt>
              <dd className="numeric">{fact.value}</dd>
            </div>
          ))}
        </dl>
        <details open>
          <summary>{t('sheetExact')}</summary>
          <pre className="numeric" data-sheet-payload>
            {payloadText(request, account, chainId)}
          </pre>
        </details>
        <p className="muted">
          {t(request.kind === 'transaction' ? 'sheetMovesFunds' : request.kind === 'message' ? 'sheetMovesNothing' : 'sheetMayAuthorise')}
        </p>
        <Button onClick={onContinue}>{t('sheetContinue')}</Button>{' '}
        <Button variant="secondary" onClick={onCancel}>
          {t('sheetCancel')}
        </Button>
      </div>
    </Dialog>
  );
}

/** The plain-words sheet for several transactions: every step listed in order, each with its exact data, one Continue. */
export function SequenceSheet({ sequence, account, chainId, onCancel, onContinue }: SequenceSheetProps) {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  return (
    <Dialog title={t('sheetTitle')} onClose={onCancel}>
      <div data-sheet="sequence">
        <p>
          {sequence.steps.some((step) => 'sign' in step)
            ? t('seqSignsAndSends', {
                signs: String(sequence.steps.filter((step) => 'sign' in step).length),
                count: String(sequence.steps.filter((step) => !('sign' in step)).length),
              })
            : t('seqSends', { count: String(sequence.steps.length) })}
        </p>
        <dl className="protocol-facts">
          <div>
            <dt>{t('fact_account')}</dt>
            <dd className="numeric">{account}</dd>
          </div>
          <div>
            <dt>{t('fact_network')}</dt>
            <dd>{chainId}</dd>
          </div>
          {(sequence.facts ?? []).map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd className="numeric">{fact.value}</dd>
            </div>
          ))}
        </dl>
        <ol aria-label={sequence.title}>
          {sequence.steps.map((step, index) => (
            <li key={index}>{step.label}</li>
          ))}
        </ol>
        <details>
          <summary>{t('sheetExact')}</summary>
          {sequence.steps.map((step, index) => (
            <pre key={index} className="numeric" data-sheet-payload>
              {'request' in step
                ? payloadText(step.request, account, chainId)
                : 'sign' in step
                  ? payloadText({ kind: 'typedData', typedData: step.sign }, account, chainId)
                  : step.preview}
            </pre>
          ))}
        </details>
        <p className="muted">{t('sheetMovesFunds')}</p>
        <Button onClick={onContinue}>{t('sheetContinue')}</Button>{' '}
        <Button variant="secondary" onClick={onCancel}>
          {t('sheetCancel')}
        </Button>
      </div>
    </Dialog>
  );
}

const OLD_PARTS: WalletParts = { Gate: WalletGate, SignSheet, SequenceSheet };
