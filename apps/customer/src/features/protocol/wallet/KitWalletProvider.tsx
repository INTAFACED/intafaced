import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { Sheet } from '@intafaced/ui/lit/templates';
import { usePreferences } from '../../../shared/preferences';
import { walletCopy } from './copy';
import { describeRequest, payloadText } from './eip1193';
import { useWallet, WalletCore, type SequenceSheetProps, type SignSheetProps, type WalletParts } from './wallet-core';

/**
 * The wallet for a room drawn from the kit: the same logic as `WalletProvider` (`wallet-core.tsx`), the same words and
 * the same `data-sheet` hooks, with the gate and both sheets drawn from the kit. `scope`, `chainId` and `gate` as
 * `WalletCore` names them.
 */
export function KitWalletProvider(props: { children: ReactNode; discovery?: boolean; gate?: boolean; scope?: string; chainId?: number }) {
  return <WalletCore {...props} parts={KIT_PARTS} />;
}

function KitWalletGate({ children }: { children: ReactNode }) {
  const { status } = useWallet();
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  return status === 'restoring' ? (
    <p className="lt-hint" role="status" aria-busy="true" data-wallet="restoring">
      {t('restoring')}
    </p>
  ) : (
    children
  );
}

function Facts({ account, chainId, facts }: { account: string; chainId: number; facts: readonly { label: string; value: string }[] }) {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  return (
    <dl className="lt-kv">
      <div>
        <dt>{t('fact_account')}</dt>
        <dd className="lt-mono lt-wrap">{account}</dd>
      </div>
      <div>
        <dt>{t('fact_network')}</dt>
        <dd>{chainId}</dd>
      </div>
      {facts.map((fact, index) => (
        <div key={`${fact.label}:${index}`}>
          <dt>{fact.label}</dt>
          <dd className="lt-mono lt-wrap">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Choices({ onContinue, onCancel }: { onContinue: () => void; onCancel: () => void }) {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  return (
    <div className="lt-actions">
      <Button tone="primary" onClick={onContinue}>
        {t('sheetContinue')}
      </Button>
      <Button onClick={onCancel}>{t('sheetCancel')}</Button>
    </div>
  );
}

/** The plain-words sheet before one wallet prompt, drawn from the kit: what, which contract, amount, spender and expiry. */
function KitSignSheet({ request, account, chainId, onCancel, onContinue }: SignSheetProps) {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  const facts = describeRequest(request).map((fact) => ({ label: t(`fact_${fact.label}`), value: fact.value }));
  return (
    <Sheet open title={t('sheetTitle')} onClose={onCancel}>
      <div className="lt-stack" data-sheet="sign">
        <p>{t(request.kind === 'transaction' ? 'sheetSends' : request.kind === 'message' ? 'sheetSignsMessage' : 'sheetSignsData')}</p>
        <Facts account={account} chainId={chainId} facts={facts} />
        <details open>
          <summary>{t('sheetExact')}</summary>
          <pre className="lt-pre lt-pre-wrap" data-sheet-payload>
            {payloadText(request, account, chainId)}
          </pre>
        </details>
        <p className="lt-hint">
          {t(request.kind === 'transaction' ? 'sheetMovesFunds' : request.kind === 'message' ? 'sheetMovesNothing' : 'sheetMayAuthorise')}
        </p>
        <Choices onContinue={onContinue} onCancel={onCancel} />
      </div>
    </Sheet>
  );
}

/** The plain-words sheet for several transactions, drawn from the kit: every step in order, each with its exact data, one Continue. */
function KitSequenceSheet({ sequence, account, chainId, onCancel, onContinue }: SequenceSheetProps) {
  const { language } = usePreferences();
  const { t } = walletCopy.forLocale(language);
  return (
    <Sheet open title={t('sheetTitle')} onClose={onCancel}>
      <div className="lt-stack" data-sheet="sequence">
        <p>
          {sequence.steps.some((step) => 'sign' in step)
            ? t('seqSignsAndSends', {
                signs: String(sequence.steps.filter((step) => 'sign' in step).length),
                count: String(sequence.steps.filter((step) => !('sign' in step)).length),
              })
            : t('seqSends', { count: String(sequence.steps.length) })}
        </p>
        <Facts account={account} chainId={chainId} facts={sequence.facts ?? []} />
        <ol aria-label={sequence.title}>
          {sequence.steps.map((step, index) => (
            <li key={index}>{step.label}</li>
          ))}
        </ol>
        <details>
          <summary>{t('sheetExact')}</summary>
          {sequence.steps.map((step, index) => (
            <pre key={index} className="lt-pre lt-pre-wrap" data-sheet-payload>
              {'request' in step
                ? payloadText(step.request, account, chainId)
                : 'sign' in step
                  ? payloadText({ kind: 'typedData', typedData: step.sign }, account, chainId)
                  : step.preview}
            </pre>
          ))}
        </details>
        <p className="lt-hint">{t('sheetMovesFunds')}</p>
        <Choices onContinue={onContinue} onCancel={onCancel} />
      </div>
    </Sheet>
  );
}

const KIT_PARTS: WalletParts = { Gate: KitWalletGate, SignSheet: KitSignSheet, SequenceSheet: KitSequenceSheet };
