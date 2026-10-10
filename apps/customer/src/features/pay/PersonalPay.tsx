import { payCopy, PayCopy } from './copy';
import { useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import type { ApiClient, ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { usePreferences } from '../../shared/preferences';
import { parseAmount } from '../../shared/money';
import { Button, Dialog, Field, Page } from '../../shared/ui';
import { createPersonalPayApi, type PersonalPayApi } from './pay-api';
import { useSession } from '../session/session';
import { PayAmount, PayDetails, PayNotice, PaySection, PayState, MutationResult, PayTime } from './components';
import { asset as assetSchema, sendInput, type spaceSchema } from './schemas';
import type { z } from 'zod';
import { currentSharedCardRoute, subscribeSharedCardRoute } from '../more/blueprint-shared-card-contract';

const destinations = [
  { path: '/pay/send', title: 'send', detail: 'payAnotherIntafacedAccount', icon: '↗' },
  { path: '/pay/receive', title: 'receive', detail: 'shareYourReceivingAccount', icon: '↙' },
  { path: '/pay/request', title: 'request', detail: 'askSomeoneToPayYou', icon: '↔' },
] as const;
export function PersonalPay({ path }: { path: string }) {
  const { api, userId } = useSession();
  const pay = useMemo(() => createPersonalPayApi(api, userId), [api, userId]);
  const current = path.split('?')[0];
  const assetParams = new URLSearchParams(path.split('?')[1] ?? '').getAll('asset');
  const requestedAsset = assetParams.length === 1 ? assetSchema.safeParse(assetParams[0]) : null;
  const asset = requestedAsset?.success ? requestedAsset.data : null;
  const invalidAsset = assetParams.length > 0 && !asset;
  const title =
    current === '/pay/send'
      ? payCopy.t('sendMoney')
      : current === '/pay/receive'
        ? payCopy.t('receiveMoney')
        : current === '/pay/request'
          ? payCopy.t('requestAPayment')
          : current === '/pay/bills'
            ? payCopy.t('billPay')
            : current === '/pay/global'
              ? payCopy.t('sendToABankAbroad')
              : payCopy.t('pay');
  return (
    <Page
      eyebrow={payCopy.t('personalAccount')}
      title={title}
      description={current === '/pay' ? payCopy.t('moveMoneyWithAClearRecipientAnd') : undefined}
    >
      <div className={`pay-personal${current === '/pay/receive' ? ' pay-personal-receive' : ''}`}>
        <nav className="pay-personal-nav" aria-label={payCopy.t('personalPay')}>
          {destinations.map((item) => (
            <a key={item.path} href={item.path} aria-current={current === item.path ? 'page' : undefined}>
              <span className="pay-nav-symbol" aria-hidden="true">
                {item.icon}
              </span>
              <span>
                <PayCopy k={item.title} />
                <small>
                  <PayCopy k={item.detail} />
                </small>
              </span>
              <span aria-hidden="true">→</span>
            </a>
          ))}
        </nav>
        <div className="pay-personal-content">
          {current === '/pay/send' ? (
            <SendMoney
              key={`${userId ?? 'anonymous'}:${asset ?? ''}`}
              pay={pay}
              userId={userId}
              asset={asset}
              invalidAsset={invalidAsset}
            />
          ) : current === '/pay/receive' ? (
            <ReceiveMoney pay={pay} userId={userId} />
          ) : current === '/pay/request' ? (
            <PayNotice title={payCopy.t('paymentRequestsAreNotConnected')}>
              <PayCopy k="thereIsNoPersonalRequestContractOr" />
            </PayNotice>
          ) : current === '/pay/bills' ? (
            <PayNotice title={payCopy.t('billPaymentRailIsNotConnected')}>
              <PayCopy k="billerDiscoveryInvoiceValidationAndABill" />
            </PayNotice>
          ) : current === '/pay/global' ? (
            <PayNotice title={payCopy.t('internationalBankSendingIsNotConnected')}>
              <PayCopy k="theCorridorRecipientBankValidationExchangeQuote" />
            </PayNotice>
          ) : (
            <>
              <PaySection title={payCopy.t('payAnotherPerson')} description={payCopy.t('internalTransfersUseYourBankSpaceOn')}>
                <p className="pay-intro">
                  <PayCopy k="chooseTheSourceReviewTheRecipientAccount" />
                </p>
                <a href="/pay/send" className="button button--chrome">
                  <PayCopy k="sendMoney" /> <span aria-hidden="true">↗</span>
                </a>
              </PaySection>
              <PaySection title={payCopy.t('personToPerson')} description={payCopy.t('browseOffersAndManageOrdersWithEscrow')}>
                <a className="pay-destination" href="/p2p">
                  <span>
                    <PayCopy k="openP2p" />
                    <small>
                      <PayCopy k="offersYourOrdersAndPaymentDetails" />
                    </small>
                  </span>
                  <span aria-hidden="true">→</span>
                </a>
              </PaySection>
              <PaySection title={payCopy.t('otherWaysToPay')}>
                <a className="pay-destination" href="/pay/bills">
                  <span>
                    <PayCopy k="billPay" />
                    <small>
                      <PayCopy k="billerAndPaymentRailNotConnected" />
                    </small>
                  </span>
                  <span aria-hidden="true">→</span>
                </a>
                <a className="pay-destination" href="/pay/global">
                  <span>
                    <PayCopy k="sendToABankAbroad" />
                    <small>
                      <PayCopy k="internationalCorridorAndQuoteNotConnected" />
                    </small>
                  </span>
                  <span aria-hidden="true">→</span>
                </a>
              </PaySection>
            </>
          )}
        </div>
      </div>
    </Page>
  );
}

type SendContext = { api: ApiClient; pay: PersonalPayApi; userId: string | null; href: string; epoch: number };
type SendLifetime = { context: SendContext; mounted: boolean };
type ConfirmedTransfer = { ledgerTxId: string; amount: string; assetId: string; transferId: string };

function SendMoney({
  pay,
  userId,
  asset,
  invalidAsset,
}: {
  pay: PersonalPayApi;
  userId: string | null;
  asset: string | null;
  invalidAsset: boolean;
}) {
  const { api } = useSession();
  const version = useRef<SendContext>({ api, pay, userId, href: location.href, epoch: 0 });
  if (
    version.current.api !== api ||
    version.current.pay !== pay ||
    version.current.userId !== userId ||
    version.current.href !== location.href
  )
    version.current = { api, pay, userId, href: location.href, epoch: version.current.epoch + 1 };
  const context = version.current;
  const lifetime = useRef<SendLifetime>({ context, mounted: true });
  lifetime.current.context = context;
  const [, invalidateNavigation] = useReducer((revision: number) => revision + 1, 0);
  useLayoutEffect(() => {
    lifetime.current.mounted = true;
    const departed = () => {
      const previous = version.current;
      if (previous.href === location.href) return;
      const next = { ...previous, href: location.href, epoch: previous.epoch + 1 };
      version.current = next;
      lifetime.current.context = next;
      // The event itself invalidates admission, even if React sees A again.
      // Flush the private subtree before another handler in this task can use it.
      flushSync(() => {
        setConfirmed(null);
        setRefused(null);
        recoveryAttempt.current = null;
        setRecoveryAction(null);
        invalidateNavigation();
      });
    };
    window.addEventListener('popstate', departed);
    window.addEventListener('hashchange', departed);
    return () => {
      lifetime.current.mounted = false;
      window.removeEventListener('popstate', departed);
      window.removeEventListener('hashchange', departed);
    };
  }, []);
  const sources = useResource((signal) => pay.spaces(signal), `pay:send-sources:${userId}:${context.epoch}`);
  const [confirmed, setConfirmed] = useState<{ context: SendContext; receipt: ConfirmedTransfer } | null>(null);
  const [refused, setRefused] = useState<{ context: SendContext; response: Extract<ApiResult<unknown>, { ok: false }> } | null>(null);
  const currentConfirmed = confirmed?.context === context ? confirmed.receipt : null;
  const currentRefused = refused?.context === context ? refused.response : null;
  const [, refreshGuard] = useReducer((revision: number) => revision + 1, 0);
  const recoveryAttempt = useRef<{ context: SendContext; token: object } | null>(null);
  const [recoveryAction, setRecoveryAction] = useState<{ context: SendContext; token: object } | null>(null);
  const recoveryBusy = recoveryAction?.context === context;
  const key = `${userId}:send`;
  const isRecoveryCurrent = () =>
    lifetime.current.mounted && lifetime.current.context === context && location.href === context.href && context.api.canWrite();
  useLayoutEffect(() => {
    const restore = async () => {
      await pay.guard.restore(key);
      if (isRecoveryCurrent()) refreshGuard();
    };
    const returned = () => {
      if (document.visibilityState === 'visible') void restore();
    };
    const changed = (event: StorageEvent) => {
      if (event.key === `pay.unresolved:${key}` || event.key === null) void restore();
    };
    void restore();
    window.addEventListener('storage', changed);
    window.addEventListener('focus', returned);
    document.addEventListener('visibilitychange', returned);
    return () => {
      window.removeEventListener('storage', changed);
      window.removeEventListener('focus', returned);
      document.removeEventListener('visibilitychange', returned);
    };
  }, [context]);
  const unresolved = pay.guard.status(key);
  const recoveryProblem = pay.guard.problem(key);
  const knownCleanup = pay.guard.knownCleanup(key);
  const cleanupOriginal = pay.guard.knownProof(key);
  const knownConfirmed = pay.guard.knownConfirmed(key);
  const originalReferences = pay.guard.references(key);
  async function retryRecovery() {
    if (!isRecoveryCurrent() || recoveryAttempt.current?.context === context) return;
    const action = { context, token: {} };
    recoveryAttempt.current = action;
    setRecoveryAction(action);
    try {
      if (knownCleanup) await pay.guard.cleanupKnown(key, isRecoveryCurrent, cleanupOriginal);
      else await pay.guard.restore(key);
    } finally {
      if (isRecoveryCurrent() && recoveryAttempt.current === action) {
        recoveryAttempt.current = null;
        setRecoveryAction(null);
        refreshGuard();
      }
    }
  }
  return (
    <>
      {asset && (
        <PaySection title={payCopy.t('sendingAsset', { asset })} description={payCopy.t('onlyAssetSources', { asset })}>
          <a className="text-link" href={`/portfolio/${encodeURIComponent(asset)}`}>
            {payCopy.t('backToAssetHolding', { asset })} ↗
          </a>
        </PaySection>
      )}
      {unresolved && (
        <PayNotice
          title={payCopy.t(
            knownCleanup
              ? knownConfirmed
                ? 'knownRecoveryTitle'
                : 'refusedRecoveryTitle'
              : recoveryProblem
                ? 'recoveryStorageTitle'
                : 'originalTransferIsUnresolved',
          )}
          action={
            <div className="pay-transfer-recovery-actions">
              {(knownCleanup || recoveryProblem) && (
                <Button variant="secondary" disabled={recoveryBusy} onClick={() => void retryRecovery()}>
                  <PayCopy k={knownCleanup ? 'retryLocalCleanup' : 'retryRecovery'} />
                </Button>
              )}
              {(knownCleanup || !recoveryProblem) && (
                <a className="button button--secondary" href="/uc/record">
                  <PayCopy k="checkMoneyActivity" />
                </a>
              )}
              <a className="button button--primary" href="/support">
                <PayCopy k="contactSupport" />
              </a>
            </div>
          }
        >
          <PayCopy
            k={
              knownCleanup
                ? knownConfirmed
                  ? 'knownRecoveryBody'
                  : 'refusedRecoveryBody'
                : recoveryProblem === 'conflict'
                  ? 'recoveryConflictBody'
                  : recoveryProblem
                    ? 'recoveryStorageBody'
                    : 'aPreviousTransferHasNotBeenConfirmed'
            }
          />
          {originalReferences.map((originalReference) => (
            <span className="pay-cell-note" key={originalReference}>
              <PayCopy k="originalTransferId" /> <span lang="zxx">{originalReference}</span>
            </span>
          ))}
        </PayNotice>
      )}
      <div className="pay-transfer-outcome" role="status" aria-label={payCopy.t('transferResult')} aria-live="polite" aria-atomic="true">
        <MutationResult result={currentRefused} />
        {currentConfirmed && (
          <PaySection title={payCopy.t('transferConfirmed')} description={payCopy.t('keepThisLedgerReceipt')}>
            <PayDetails
              values={[
                [payCopy.t('ledgerTransaction'), <span lang="zxx">{currentConfirmed.ledgerTxId}</span>],
                [payCopy.t('originalTransferId'), <span lang="zxx">{currentConfirmed.transferId}</span>],
                [
                  payCopy.t('confirmedAmount'),
                  <PayAmount value={currentConfirmed.amount} unit={currentConfirmed.assetId} label={payCopy.t('confirmedAmount')} />,
                ],
              ]}
            />
          </PaySection>
        )}
      </div>
      {invalidAsset ? (
        <PayNotice title={payCopy.t('invalidHoldingContext')}>
          <a className="text-link" href="/portfolio">
            {payCopy.t('returnToHoldings')}
          </a>
        </PayNotice>
      ) : (
        <PayState resource={sources.resource} retry={sources.reload}>
          {(spaces) => {
            const matching = asset ? spaces.filter((space) => space.assetId === asset) : spaces;
            return matching.length ? (
              <SendForm
                key={context.epoch}
                context={context}
                lifetime={lifetime.current}
                pay={pay}
                spaces={matching}
                asset={asset}
                userId={userId}
                reload={sources.reload}
                onConfirmed={(receipt) => setConfirmed({ context, receipt })}
                onRefused={(response) => setRefused({ context, response })}
                onSettled={refreshGuard}
                isRecoveryCurrent={isRecoveryCurrent}
              />
            ) : (
              <PayNotice title={asset ? payCopy.t('noAssetSource', { asset }) : payCopy.t('noSourceSpacesAvailable')}>
                {asset && (
                  <>
                    <p>{payCopy.t('noAssetSourceExplanation', { asset })}</p>
                    <a className="text-link" href="/pay/send">
                      {payCopy.t('chooseAnotherAsset')}
                    </a>
                  </>
                )}
              </PayNotice>
            );
          }}
        </PayState>
      )}
    </>
  );
}
function SendForm({
  context,
  lifetime,
  pay,
  spaces,
  asset,
  userId,
  reload,
  onConfirmed,
  onRefused,
  onSettled,
  isRecoveryCurrent,
}: {
  context: SendContext;
  lifetime: SendLifetime;
  pay: PersonalPayApi;
  spaces: z.infer<typeof spaceSchema>[];
  asset: string | null;
  userId: string | null;
  reload: () => void;
  onConfirmed: (receipt: ConfirmedTransfer) => void;
  onRefused: (response: Extract<ApiResult<unknown>, { ok: false }>) => void;
  onSettled: () => void;
  isRecoveryCurrent: () => boolean;
}) {
  const { hideBalances } = usePreferences();
  const [sourceId, setSourceId] = useState(asset && spaces.length === 1 ? spaces[0]!.id : '');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<
    'invalidSendInput' | 'chooseYourSourceAccount' | 'chooseAnotherRecipientAccount' | 'thisAmountExceedsTheSourceSLedger' | null
  >(null);
  const [review, setReview] = useState<{
    input: z.infer<typeof sendInput>;
    sourceName: string;
    assetId: string;
  } | null>(null);
  const admittedReview = useRef<typeof review>(null);
  const [result, setResult] = useState<ApiResult<{ ledgerTxId: string; amount: string }> | null>(null);
  const completion = useRef<{ review: NonNullable<typeof review>; outcome: NonNullable<typeof result> } | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef<object | null>(null);
  const mounted = useRef(true);
  const form = useRef<HTMLFormElement | null>(null);
  const isCurrent = () =>
    mounted.current && lifetime.mounted && lifetime.context === context && location.href === context.href && context.api.canWrite();
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      admittedReview.current = null;
      completion.current = null;
      // Detached controls may still be retained by a browser event task.
      for (const input of form.current?.querySelectorAll('input') ?? []) input.value = '';
    };
  }, []);
  const source = spaces.find((space) => space.id === sourceId);
  const unresolved = pay.guard.status(`${userId}:send`);
  function retireReview() {
    admittedReview.current = null;
    completion.current = null;
    inFlight.current = null;
    setBusy(false);
    setReview(null);
  }
  const isReviewCurrent = () => isCurrent() && admittedReview.current === review;
  function closeReview() {
    if (!isReviewCurrent()) return;
    const knownRefusal =
      completion.current?.review === review &&
      completion.current?.outcome === result &&
      result &&
      !result.ok &&
      result.reason !== 'uncertain' &&
      result.reason !== 'aborted' &&
      !inFlight.current &&
      pay.guard.knownCleanup(`${userId}:send`) &&
      !pay.guard.knownConfirmed(`${userId}:send`);
    // Dismiss only this known reply's private review. Its original recovery
    // record and RAM proof remain available for the separate local-only retry.
    if (!pay.guard.status(`${userId}:send`) || knownRefusal) retireReview();
  }
  function prepare() {
    if (!isReviewCurrent() || inFlight.current) return;
    if (pay.guard.status(`${userId}:send`)) {
      onSettled();
      return;
    }
    setError(null);
    completion.current = null;
    setResult(null);
    const parsed = sendInput.safeParse({
      transferId: crypto.randomUUID(),
      fromSpaceId: sourceId,
      toUserId: recipient.trim(),
      amount: amount.trim(),
    });
    if (!parsed.success) {
      setError('invalidSendInput');
      return;
    }
    if (!source) {
      setError('chooseYourSourceAccount');
      return;
    }
    if (recipient.trim() === userId) {
      setError('chooseAnotherRecipientAccount');
      return;
    }
    if (parseAmount(parsed.data.amount) > parseAmount(source.balance)) {
      setError('thisAmountExceedsTheSourceSLedger');
      return;
    }
    const prepared = { input: parsed.data, sourceName: source.name, assetId: source.assetId };
    admittedReview.current = prepared;
    setReview(prepared);
  }
  async function confirm() {
    if (!isReviewCurrent() || !review || inFlight.current) return;
    if (pay.guard.status(`${userId}:send`)) {
      onSettled();
      return;
    }
    const original = review;
    const action = {};
    inFlight.current = action;
    setBusy(true);
    try {
      const originalCurrent = () => isCurrent() && admittedReview.current === original;
      const outcome = await pay.send(original.input, originalCurrent, isRecoveryCurrent);
      if (!originalCurrent() || inFlight.current !== action) return;
      onSettled();
      completion.current = { review: original, outcome };
      setResult(outcome);
      if (!outcome.ok && pay.guard.knownCleanup(`${userId}:send`)) onRefused(outcome);
      if (outcome.ok) {
        onConfirmed({ ...outcome.data, assetId: original.assetId, transferId: original.input.transferId });
        admittedReview.current = null;
        completion.current = null;
        setReview(null);
        setAmount('');
        reload();
      } else if (outcome.code === 'pay.recovery_journal_unavailable') {
        // Local recovery actions must remain reachable outside the review modal.
        // Retry prepares a fresh private review, never an automatic resubmission.
        admittedReview.current = null;
        completion.current = null;
        setReview(null);
        setRecipient('');
        setAmount('');
      }
    } finally {
      if (isCurrent() && inFlight.current === action) {
        setBusy(false);
        inFlight.current = null;
      }
    }
  }
  return (
    <PaySection title={payCopy.t('sendFromYourBankSpace')}>
      <form
        ref={form}
        className="form-stack pay-form"
        onSubmit={(event) => {
          event.preventDefault();
          prepare();
        }}
      >
        <label className="field">
          <PayCopy k="sourceAccount" />
          <select
            aria-label={payCopy.t('sourceAccount')}
            value={sourceId}
            onChange={(event) => {
              if (isReviewCurrent() && !inFlight.current && !pay.guard.status(`${userId}:send`)) {
                setSourceId(event.target.value);
                retireReview();
              }
            }}
            required
          >
            <option value="">{payCopy.t('chooseASource')}</option>
            {spaces.map((space) => (
              <option key={space.id} value={space.id} lang="und">
                {space.name} · {space.assetId}
              </option>
            ))}
          </select>
        </label>
        {source && (
          <PayDetails
            values={[
              [
                payCopy.t('ledgerBalance', { assetId: source.assetId }),
                hideBalances ? (
                  payCopy.t('hidden')
                ) : (
                  <PayAmount value={source.balance} unit={source.assetId} label={payCopy.t('ledgerBalance', { assetId: source.assetId })} />
                ),
              ],
              [payCopy.t('lock'), source.lockedUntil ? <PayTime value={source.lockedUntil} /> : payCopy.t('noTimeLock')],
            ]}
          />
        )}
        <Field
          label={payCopy.t('recipientAccountId')}
          name="recipient"
          autoComplete="off"
          value={recipient}
          onChange={(event) => {
            if (isReviewCurrent() && !inFlight.current && !pay.guard.status(`${userId}:send`)) {
              setRecipient(event.target.value);
              retireReview();
            }
          }}
          hint={payCopy.t('askYourRecipientToShareTheAccount')}
          required
          maxLength={64}
        />
        <Field
          label={payCopy.t('amount2', { value1: source ? ` · ${source.assetId}` : '' })}
          aria-label={payCopy.t('amount2', { value1: source ? ` · ${source.assetId}` : '' })}
          name="send-amount"
          inputMode="decimal"
          value={amount}
          onChange={(event) => {
            if (isReviewCurrent() && !inFlight.current && !pay.guard.status(`${userId}:send`)) {
              setAmount(event.target.value);
              retireReview();
            }
          }}
          hint={payCopy.t('theQuantityIsSentInTheSource')}
          required
        />
        {error && (
          <p className="error-text" role="alert">
            {payCopy.t(error)}
          </p>
        )}
        <Button type="submit" disabled={!source || Boolean(unresolved)} variant="primary">
          <PayCopy k="reviewTransfer" />
        </Button>
      </form>
      <MutationResult result={result} />
      {review && (
        <Dialog title={payCopy.t('reviewTransfer')} onClose={closeReview}>
          <div className="pay-transfer-review">
            <div className="pay-transfer-value" role="group" aria-label={payCopy.t('youSend')}>
              <span className="muted">
                <PayCopy k="youSend" />
              </span>
              <p className="numeric">
                <PayAmount value={review.input.amount} unit={review.assetId} label={payCopy.t('youSend')} />
              </p>
            </div>
            <PayDetails
              values={[
                [
                  payCopy.t('from'),
                  <span lang="und">
                    {review.sourceName} · {review.assetId}
                  </span>,
                ],
                [
                  payCopy.t('recipientAccount'),
                  <>
                    <span lang="zxx">{review.input.toUserId}</span>
                    <small className="pay-transfer-recipient-hint">
                      <PayCopy k="confirmRecipientAccountId" />
                    </small>
                  </>,
                ],
                [
                  payCopy.t('transferId'),
                  <span className="pay-transfer-reference" lang="zxx">
                    {review.input.transferId}
                  </span>,
                ],
              ]}
            />
            <p className="muted">
              <PayCopy k="internalTransferReview" params={{ assetId: review.assetId }} />
            </p>
            <MutationResult result={result} />
            <div className="pay-transfer-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  if (isReviewCurrent() && !pay.guard.status(`${userId}:send`)) retireReview();
                }}
                disabled={Boolean(unresolved)}
              >
                <PayCopy k="editTransfer" />
              </Button>
              <Button variant="primary" onClick={() => void confirm()} disabled={busy || Boolean(unresolved)}>
                {busy ? payCopy.t('waitingForLedgerConfirmation') : payCopy.t('confirmTransfer')}
              </Button>
            </div>
            {unresolved && (
              <a className="text-link" href="/support">
                <PayCopy k="contactSupport" />
              </a>
            )}
          </div>
        </Dialog>
      )}
    </PaySection>
  );
}
let receivingIdentity = 0;
function ReceiveMoney({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  const { api } = useSession();
  const route = useSyncExternalStore(subscribeSharedCardRoute, currentSharedCardRoute);
  const context = useMemo(
    () => ({ api, userId, route, active: false, attempt: null as object | null, read: ++receivingIdentity }),
    [api, pay, userId, route],
  );
  useLayoutEffect(() => {
    context.active = true;
    return () => {
      context.active = false;
      context.attempt = null;
    };
  }, [context]);
  const current = () => context.active && api.canWrite() && context.route === currentSharedCardRoute();
  const sources = useResource((signal) => pay.spaces(signal), `pay:receiving:${context.read}`);
  const [copied, setCopied] = useState<{ context: typeof context; status: 'accountCopied' | 'copyUnavailable' } | null>(null);
  const [copying, setCopying] = useState<typeof context | null>(null);
  const status = copied?.context === context ? copied.status : null;
  async function copyAccount() {
    if (!userId || !current() || context.attempt) return;
    const attempt = {};
    context.attempt = attempt;
    setCopied(null);
    setCopying(context);
    try {
      const clipboard = navigator.clipboard;
      if (typeof clipboard?.writeText !== 'function') throw new Error('copy-unavailable');
      await clipboard.writeText(userId);
      if (current() && context.attempt === attempt) setCopied({ context, status: 'accountCopied' });
    } catch {
      if (current() && context.attempt === attempt) setCopied({ context, status: 'copyUnavailable' });
    } finally {
      if (context.attempt === attempt) {
        context.attempt = null;
        if (current()) setCopying(null);
      }
    }
  }
  return (
    <div className="pay-receive">
      <PaySection title={payCopy.t('yourReceivingAccount')} description={payCopy.t('shareThisAccountIdForAnInternal')}>
        {userId ? (
          <div className="pay-receive-reference">
            <p
              className="pay-account-id"
              lang="zxx"
              tabIndex={0}
              onFocus={(event) => {
                if (!current()) return;
                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(event.currentTarget);
                selection?.removeAllRanges();
                selection?.addRange(range);
              }}
            >
              {userId}
            </p>
            <Button disabled={copying === context} onClick={copyAccount}>
              <PayCopy k={copying === context ? 'receiveCopying' : 'copyAccountId'} />
            </Button>
            {status && (
              <div className={`pay-receive-copy-status${status === 'accountCopied' ? ' positive' : ''}`} role="status">
                <strong>{payCopy.t(status)}</strong>
                {status === 'copyUnavailable' && (
                  <p className="muted">
                    <PayCopy k="receiveCopyRetry" />
                  </p>
                )}
              </div>
            )}
            {status !== 'copyUnavailable' && (
              <p className="muted pay-receive-manual">
                <PayCopy k="receiveManualCopy" />
              </p>
            )}
          </div>
        ) : (
          <PayNotice title={payCopy.t('signInToReceive')}>
            <PayCopy k="yourReceivingAccountIsAvailableAfterSign" />
          </PayNotice>
        )}
      </PaySection>
      <PaySection
        title={payCopy.t('receivingAssets')}
        action={
          <Button
            variant="secondary"
            aria-label={payCopy.t('receiveRefreshLabel')}
            disabled={sources.resource.status === 'loading'}
            onClick={() => {
              if (current()) sources.reload();
            }}
          >
            <PayCopy k="receiveRefresh" />
          </Button>
        }
      >
        <p className="pay-receive-caption">
          <PayCopy k="aTransferArrivesInTheAssetSent" />
        </p>
        <PayState
          resource={sources.resource}
          retry={() => {
            if (current()) sources.reload();
          }}
        >
          {(spaces) => {
            const primary = spaces.filter((space) => space.kind === 'primary');
            return primary.length ? (
              <div>
                {primary.map((space) => (
                  <div className="pay-destination" key={space.id}>
                    <span lang="und">
                      <span lang="zxx">{space.assetId}</span>
                      <small lang="und">{space.name}</small>
                    </span>
                    <span className="muted">
                      <PayCopy k="keepInAsset" />
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="pay-receive-empty">
                <h3>
                  <PayCopy k="receiveNoPrimary" />
                </h3>
                <p className="muted">
                  <PayCopy k={spaces.length ? 'receiveNamedOnly' : 'receiveNoSpaces'} />
                </p>
              </div>
            );
          }}
        </PayState>
        <p className="pay-receive-coverage muted">
          <PayCopy k={sources.resource.status === 'failed' ? 'receiveReadFailed' : 'receiveCoverage'} />
        </p>
        <a className="text-link" href="/bank">
          <PayCopy k="inspectBankSpaces" /> <span aria-hidden="true">↗</span>
        </a>
      </PaySection>
      <PayNotice title={payCopy.t('automaticReceiveConversionIsUnavailable')}>
        <PayCopy k="theReceivePreferenceAndConversionQuoteContracts" />
      </PayNotice>
      <a className="text-link" href="/uc/recharge">
        <PayCopy k="openDepositOnMoney" />
      </a>
    </div>
  );
}
