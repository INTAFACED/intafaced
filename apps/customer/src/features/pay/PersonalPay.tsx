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
  { path: '/pay/send', title: 'Send', detail: 'Pay another Intafaced account', icon: '↗' },
  { path: '/pay/receive', title: 'Receive', detail: 'Share your receiving account', icon: '↙' },
  { path: '/pay/request', title: 'Request', detail: 'Ask someone to pay you', icon: '↔' },
];
export function PersonalPay({ path }: { path: string }) {
  const { api, userId } = useSession();
  const pay = useMemo(() => createPersonalPayApi(api, userId), [api, userId]);
  const current = path.split('?')[0];
  const title =
    current === '/pay/send'
      ? 'Send money'
      : current === '/pay/receive'
        ? 'Receive money'
        : current === '/pay/request'
          ? 'Request a payment'
          : current === '/pay/bills'
            ? 'Bill pay'
            : current === '/pay/global'
              ? 'Send to a bank abroad'
              : 'Pay';
  return (
    <Page
      eyebrow="Personal account"
      title={title}
      description={current === '/pay' ? 'Move money with a clear recipient and an exact amount.' : undefined}
    >
      <div className="pay-personal">
        <nav className="pay-personal-nav" aria-label="Personal Pay">
          {destinations.map((item) => (
            <a key={item.path} href={item.path} aria-current={current === item.path ? 'page' : undefined}>
              <span className="pay-nav-symbol" aria-hidden="true">
                {item.icon}
              </span>
              <span>
                {item.title}
                <small>{item.detail}</small>
              </span>
              <span aria-hidden="true">→</span>
            </a>
          ))}
        </nav>
        <div className="pay-personal-content">
          {current === '/pay/send' ? (
            <SendMoney pay={pay} userId={userId} />
          ) : current === '/pay/receive' ? (
            <ReceiveMoney pay={pay} userId={userId} />
          ) : current === '/pay/request' ? (
            <PayNotice title="Payment requests are not connected">
              There is no personal request contract or shareable request status yet. You can share your account ID from Receive for an
              internal transfer.
            </PayNotice>
          ) : current === '/pay/bills' ? (
            <PayNotice title="Bill payment rail is not connected">
              Biller discovery, invoice validation and a bill payment rail are not available. No bill can be paid here yet. Keep paying the
              bill directly with your provider.
            </PayNotice>
          ) : current === '/pay/global' ? (
            <PayNotice title="International bank sending is not connected">
              The corridor, recipient bank validation, exchange quote and transfer rail are missing. No bank account or transfer estimate is
              requested until those contracts are available.
            </PayNotice>
          ) : (
            <>
              <PaySection title="Pay another person" description="Internal transfers use your bank space on the same ledger.">
                <p className="pay-intro">Choose the source, review the recipient account and send the exact asset quantity.</p>
                <a href="/pay/send" className="button button--chrome">
                  Send money <span aria-hidden="true">↗</span>
                </a>
              </PaySection>
              <PaySection title="Person-to-person" description="Browse offers and manage orders with escrow status.">
                <a className="pay-destination" href="/p2p">
                  <span>
                    Open P2P<small>Offers, your orders and payment details</small>
                  </span>
                  <span aria-hidden="true">→</span>
                </a>
              </PaySection>
              <PaySection title="Other ways to pay">
                <a className="pay-destination" href="/pay/bills">
                  <span>
                    Bill pay<small>Biller and payment rail not connected</small>
                  </span>
                  <span aria-hidden="true">→</span>
                </a>
                <a className="pay-destination" href="/pay/global">
                  <span>
                    Send to a bank abroad<small>International corridor and quote not connected</small>
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

function SendMoney({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  const sources = useResource((signal) => pay.spaces(signal), `pay:send-sources:${userId}`);
  return (
    <PayState resource={sources.resource} retry={sources.reload} empty="No source spaces available">
      {(spaces) => <SendForm pay={pay} spaces={spaces} userId={userId} reload={sources.reload} />}
    </PayState>
  );
}
function SendForm({
  pay,
  spaces,
  userId,
  reload,
}: {
  pay: PersonalPayApi;
  spaces: z.infer<typeof spaceSchema>[];
  userId: string | null;
  reload: () => void;
}) {
  const { hideBalances } = usePreferences();
  const [sourceId, setSourceId] = useState('');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [review, setReview] = useState<z.infer<typeof sendInput> | null>(null);
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
      setError(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
      return;
    }
    if (!source) {
      setError('Choose your source account.');
      return;
    }
    if (recipient.trim() === userId) {
      setError('Choose another recipient account.');
      return;
    }
    if (parseAmount(parsed.data.amount) > parseAmount(source.balance)) {
      setError('This amount exceeds the source’s ledger balance.');
      return;
    }
    setReview(parsed.data);
  }
  async function confirm() {
    if (!review || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const outcome = await pay.send(review);
    setResult(outcome);
    setBusy(false);
    inFlight.current = false;
    if (outcome.ok) {
      setReview(null);
      setAmount('');
      reload();
    }
  }
  return (
    <PaySection title="Send from your bank space">
      <form
        className="form-stack pay-form"
        onSubmit={(event) => {
          event.preventDefault();
          prepare();
        }}
      >
        <label className="field">
          Source account
          <select aria-label="Source account" value={sourceId} onChange={(event) => setSourceId(event.target.value)} required>
            <option value="">Choose a source</option>
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
                `Ledger balance · ${source.assetId}`,
                <span className="numeric">{hideBalances ? 'Hidden' : displayAmount(source.balance)}</span>,
              ],
              ['Lock', source.lockedUntil ?? 'No time lock'],
            ]}
          />
        )}
        <Field
          label="Recipient account ID"
          name="recipient"
          autoComplete="off"
          value={recipient}
          onChange={(event) => setRecipient(event.target.value)}
          hint="Ask your recipient to share the account ID shown in Receive. Contact and name lookup are not connected."
          required
          maxLength={64}
        />
        <Field
          label={`Amount${source ? ` · ${source.assetId}` : ''}`}
          aria-label={`Amount${source ? ` · ${source.assetId}` : ''}`}
          name="send-amount"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          hint="The quantity is sent in the source asset. No conversion is performed."
          required
        />
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={!source || Boolean(unresolved)} variant="primary">
          Review transfer
        </Button>
      </form>
      {unresolved && (
        <PayNotice title="Original transfer is unresolved">
          A previous transfer has not been confirmed. Check Money activity or contact Support with the original transfer ID. The service has
          no transfer lookup by client ID; this screen cannot safely clear the lock by comparing balances.
          {pay.guard.reference(`${userId}:send`) && (
            <span className="pay-cell-note">Original transfer ID: {pay.guard.reference(`${userId}:send`)}</span>
          )}
        </PayNotice>
      )}
      <MutationResult result={result} />
      {result?.ok && (
        <PayDetails
          values={[
            ['Ledger transaction', result.data.ledgerTxId],
            ['Confirmed amount', `${displayAmount(result.data.amount)} ${source?.assetId ?? ''}`],
          ]}
        />
      )}
      {review && (
        <Dialog
          title="Review transfer"
          onClose={() => {
            if (!busy) setReview(null);
          }}
        >
          <div className="form-stack">
            <PayDetails
              values={[
                ['From', source?.name],
                ['Recipient account', review.toUserId],
                ['You send', `${displayAmount(review.amount)} ${source?.assetId}`],
                ['Transfer ID', review.transferId],
              ]}
            />
            <p className="muted">
              This is an internal transfer in the source asset. Recipient name verification and fee preview are not published. The server
              checks that the recipient has a primary bank space for this asset and revalidates the source before posting.
            </p>
            <MutationResult result={result} />
            <Button onClick={() => void confirm()} disabled={busy || Boolean(result && !result.ok && result.reason === 'uncertain')}>
              {busy ? 'Waiting for ledger confirmation…' : 'Confirm transfer'}
            </Button>
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
      <PaySection title="Your receiving account" description="Share this account ID for an internal Intafaced transfer.">
        {userId ? (
          <>
            <p className="pay-account-id">{userId}</p>
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard
                  .writeText(userId)
                  .then(() => setCopied('Account ID copied'))
                  .catch(() => setCopied('Copy is unavailable. Select the account ID to copy it.'));
              }}
            >
              Copy account ID
            </Button>
            {copied && <p role="status">{copied}</p>}
          </>
        ) : (
          <PayNotice title="Sign in to receive">Your receiving account is available after sign-in.</PayNotice>
        )}
      </PaySection>
      <PaySection title="Receiving assets" description="A transfer arrives in the asset sent. Your primary bank space holds that asset.">
        <PayState resource={sources.resource} retry={sources.reload} empty="No bank spaces returned">
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
                    <span className="muted">Keep in asset</span>
                  </div>
                ))}
            </div>
          )}
        </PayState>
      </PaySection>
      <PayNotice title="Automatic receive conversion is unavailable">
        The receive preference and conversion quote contracts are not connected. Incoming transfers stay in the original asset. Asset
        deposit addresses live under Money.
      </PayNotice>
      <a className="text-link" href="/uc/recharge">
        Open deposit on Money →
      </a>
    </div>
  );
}
