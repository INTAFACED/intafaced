import { payCopy, PayCopy } from './copy';
import { useMemo, useRef, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { usePreferences } from '../../shared/preferences';
import { displayAmount, parseAmount } from '../../shared/money';
import { Button, Dialog, Field, Page } from '../../shared/ui';
import { createPersonalPayApi, type PersonalPayApi } from './pay-api';
import { useSession } from '../session/session';
import { PayDetails, PayNotice, PaySection, PayState, MutationResult } from './components';
import { sendInput, type spaceSchema } from './schemas';
import type { z } from 'zod';

const destinations = [
  { path: '/pay/send', title: 'send', detail: 'payAnotherIntafacedAccount', icon: '↗' },
  { path: '/pay/receive', title: 'receive', detail: 'shareYourReceivingAccount', icon: '↙' },
  { path: '/pay/request', title: 'request', detail: 'askSomeoneToPayYou', icon: '↔' },
] as const;
export function PersonalPay({ path }: { path: string }) {
  const { api, userId } = useSession();
  const pay = useMemo(() => createPersonalPayApi(api, userId), [api, userId]);
  const current = path.split('?')[0];
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
      <div className="pay-personal">
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
            <SendMoney key={userId ?? 'anonymous'} pay={pay} userId={userId} />
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

type ConfirmedTransfer = { ledgerTxId: string; amount: string; assetId: string };

function SendMoney({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  const sources = useResource((signal) => pay.spaces(signal), `pay:send-sources:${userId}`);
  const [confirmed, setConfirmed] = useState<ConfirmedTransfer | null>(null);
  return (
    <>
      <div className="pay-transfer-outcome" role="status" aria-label={payCopy.t('transferResult')} aria-live="polite" aria-atomic="true">
        {confirmed && (
          <PaySection title={payCopy.t('transferConfirmed')} description={payCopy.t('keepThisLedgerReceipt')}>
            <PayDetails
              values={[
                [payCopy.t('ledgerTransaction'), confirmed.ledgerTxId],
                [payCopy.t('confirmedAmount'), `${displayAmount(confirmed.amount)} ${confirmed.assetId}`],
              ]}
            />
          </PaySection>
        )}
      </div>
      <PayState resource={sources.resource} retry={sources.reload} empty={payCopy.t('noSourceSpacesAvailable')}>
        {(spaces) => <SendForm pay={pay} spaces={spaces} userId={userId} reload={sources.reload} onConfirmed={setConfirmed} />}
      </PayState>
    </>
  );
}
function SendForm({
  pay,
  spaces,
  userId,
  reload,
  onConfirmed,
}: {
  pay: PersonalPayApi;
  spaces: z.infer<typeof spaceSchema>[];
  userId: string | null;
  reload: () => void;
  onConfirmed: (receipt: ConfirmedTransfer) => void;
}) {
  const { hideBalances } = usePreferences();
  const [sourceId, setSourceId] = useState('');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [review, setReview] = useState<{
    input: z.infer<typeof sendInput>;
    sourceName: string;
    assetId: string;
  } | null>(null);
  const [result, setResult] = useState<ApiResult<{ ledgerTxId: string; amount: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const source = spaces.find((space) => space.id === sourceId);
  const unresolved = pay.guard.status(`${userId}:send`);
  function prepare() {
    setError('');
    setResult(null);
    const parsed = sendInput.safeParse({
      transferId: crypto.randomUUID(),
      fromSpaceId: sourceId,
      toUserId: recipient.trim(),
      amount: amount.trim(),
    });
    if (!parsed.success) {
      setError(payCopy.t('invalidSendInput'));
      return;
    }
    if (!source) {
      setError(payCopy.t('chooseYourSourceAccount'));
      return;
    }
    if (recipient.trim() === userId) {
      setError(payCopy.t('chooseAnotherRecipientAccount'));
      return;
    }
    if (parseAmount(parsed.data.amount) > parseAmount(source.balance)) {
      setError(payCopy.t('thisAmountExceedsTheSourceSLedger'));
      return;
    }
    setReview({ input: parsed.data, sourceName: source.name, assetId: source.assetId });
  }
  async function confirm() {
    if (!review || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const outcome = await pay.send(review.input);
    setResult(outcome);
    setBusy(false);
    inFlight.current = false;
    if (outcome.ok) {
      onConfirmed({ ...outcome.data, assetId: review.assetId });
      setReview(null);
      setAmount('');
      reload();
    }
  }
  return (
    <PaySection title={payCopy.t('sendFromYourBankSpace')}>
      {unresolved && (
        <PayNotice
          title={payCopy.t('originalTransferIsUnresolved')}
          action={
            <div className="pay-transfer-recovery-actions">
              <a className="button button--secondary" href="/uc/record">
                <PayCopy k="checkMoneyActivity" />
              </a>
              <a className="button button--primary" href="/support">
                <PayCopy k="contactSupport" />
              </a>
            </div>
          }
        >
          <PayCopy k="aPreviousTransferHasNotBeenConfirmed" />
          {pay.guard.reference(`${userId}:send`) && (
            <span className="pay-cell-note">
              <PayCopy k="originalTransferId" /> <span>{pay.guard.reference(`${userId}:send`)}</span>
            </span>
          )}
        </PayNotice>
      )}
      <form
        className="form-stack pay-form"
        onSubmit={(event) => {
          event.preventDefault();
          prepare();
        }}
      >
        <label className="field">
          <PayCopy k="sourceAccount" />
          <select aria-label={payCopy.t('sourceAccount')} value={sourceId} onChange={(event) => setSourceId(event.target.value)} required>
            <option value="">{payCopy.t('chooseASource')}</option>
            {spaces.map((space) => (
              <option key={space.id} value={space.id}>
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
                <span className="numeric">{hideBalances ? payCopy.t('hidden') : displayAmount(source.balance)}</span>,
              ],
              [payCopy.t('lock'), source.lockedUntil ?? payCopy.t('noTimeLock')],
            ]}
          />
        )}
        <Field
          label={payCopy.t('recipientAccountId')}
          name="recipient"
          autoComplete="off"
          value={recipient}
          onChange={(event) => setRecipient(event.target.value)}
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
          onChange={(event) => setAmount(event.target.value)}
          hint={payCopy.t('theQuantityIsSentInTheSource')}
          required
        />
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={!source || Boolean(unresolved)} variant="primary">
          <PayCopy k="reviewTransfer" />
        </Button>
      </form>
      <MutationResult result={result} />
      {review && (
        <Dialog
          title={payCopy.t('reviewTransfer')}
          onClose={() => {
            if (!busy) setReview(null);
          }}
        >
          <div className="pay-transfer-review">
            <div className="pay-transfer-value" role="group" aria-label={payCopy.t('youSend')}>
              <span className="muted">
                <PayCopy k="youSend" />
              </span>
              <p className="numeric">
                {displayAmount(review.input.amount)} {review.assetId}
              </p>
            </div>
            <PayDetails
              values={[
                [payCopy.t('from'), `${review.sourceName} · ${review.assetId}`],
                [
                  payCopy.t('recipientAccount'),
                  <>
                    <span>{review.input.toUserId}</span>
                    <small className="pay-transfer-recipient-hint">
                      <PayCopy k="confirmRecipientAccountId" />
                    </small>
                  </>,
                ],
                [payCopy.t('transferId'), <span className="pay-transfer-reference">{review.input.transferId}</span>],
              ]}
            />
            <p className="muted">
              <PayCopy k="internalTransferReview" params={{ assetId: review.assetId }} />
            </p>
            <MutationResult result={result} />
            <div className="pay-transfer-actions">
              <Button variant="secondary" onClick={() => setReview(null)} disabled={busy || Boolean(unresolved)}>
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
function ReceiveMoney({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  const sources = useResource((signal) => pay.spaces(signal), `pay:receiving:${userId}`);
  const [copied, setCopied] = useState('');
  return (
    <div className="stack">
      <PaySection title={payCopy.t('yourReceivingAccount')} description={payCopy.t('shareThisAccountIdForAnInternal')}>
        {userId ? (
          <>
            <p className="pay-account-id">{userId}</p>
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard
                  .writeText(userId)
                  .then(() => setCopied(payCopy.t('accountCopied')))
                  .catch(() => setCopied(payCopy.t('copyUnavailable')));
              }}
            >
              <PayCopy k="copyAccountId" />
            </Button>
            {copied && <p role="status">{copied}</p>}
          </>
        ) : (
          <PayNotice title={payCopy.t('signInToReceive')}>
            <PayCopy k="yourReceivingAccountIsAvailableAfterSign" />
          </PayNotice>
        )}
      </PaySection>
      <PaySection title={payCopy.t('receivingAssets')} description={payCopy.t('aTransferArrivesInTheAssetSent')}>
        <PayState resource={sources.resource} retry={sources.reload} empty={payCopy.t('noBankSpacesReturned')}>
          {(spaces) => (
            <div>
              {spaces
                .filter((space) => space.kind === 'primary')
                .map((space) => (
                  <div className="pay-destination" key={space.id}>
                    <span>
                      {space.assetId}
                      <small>{space.name}</small>
                    </span>
                    <span className="muted">
                      <PayCopy k="keepInAsset" />
                    </span>
                  </div>
                ))}
            </div>
          )}
        </PayState>
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
