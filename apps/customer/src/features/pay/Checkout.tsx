import { useMemo, useState } from 'react';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { displayAmount } from '../../shared/money';
import { Button, Field, Page } from '../../shared/ui';
import { createCheckoutApi } from './pay-api';
import { PayDetails, PayNotice, PaySection, PayState, ReviewedAction, Status } from './components';
import type { checkoutSchema, resolvedLinkSchema } from './schemas';
import type { z } from 'zod';

export function Checkout({ path }: { path: string }) {
  const { api } = useSession();
  const checkout = useMemo(() => createCheckoutApi(api), [api]);
  const query = new URLSearchParams(
    path.includes('?') ? path.slice(path.indexOf('?')) : typeof location === 'undefined' ? '' : location.search,
  );
  const [tokenDraft, setTokenDraft] = useState('');
  const [token, setToken] = useState(query.get('token') ?? '');
  const [sessionToken, setSessionToken] = useState(query.get('session') ?? '');
  const [session, setSession] = useState<z.infer<typeof checkoutSchema> | null>(null);
  const resolved = useResource(
    (signal) =>
      token.length >= 8 && token.length <= 200
        ? checkout.resolve(token, signal)
        : Promise.resolve({
            ok: false as const,
            reason: 'not_supported' as const,
            message: 'Open a payment link provided by the merchant.',
          }),
    `pay:checkout-link:${token}`,
  );
  const status = useResource(
    (signal) =>
      sessionToken
        ? checkout.status(sessionToken, signal)
        : Promise.resolve({ ok: false as const, reason: 'not_supported' as const, message: 'No checkout session has been opened.' }),
    `pay:checkout-status:${sessionToken}`,
  );
  const active = status.resource.status === 'ready' ? status.resource.data : session;
  return (
    <Page
      eyebrow="Hosted checkout"
      title={active?.label ?? 'Pay a merchant'}
      description="The merchant link defines the payment. Only the payment service confirms completion."
    >
      {sessionToken ? (
        <PaySection
          title="Payment session"
          action={
            <Button variant="secondary" onClick={status.reload}>
              Refresh payment status
            </Button>
          }
        >
          <PayState resource={status.resource} retry={status.reload}>
            {(data) => <CheckoutStatus session={data} />}
          </PayState>
          {active && status.resource.status === 'failed' && (
            <PayNotice title="Showing the original session">
              Current payment status is unavailable. The original session was {session?.status ?? 'opened'}; completion has not been
              verified by this refresh.
            </PayNotice>
          )}
        </PaySection>
      ) : token ? (
        <PayState resource={resolved.resource} retry={resolved.reload}>
          {(link) => (
            <CheckoutForm
              key={token}
              link={link}
              token={token}
              checkout={checkout}
              onOpened={(result) => {
                setSessionToken(result.sessionToken);
                setSession(result.session);
                const next = new URL(location.href);
                next.search = new URLSearchParams({ session: result.sessionToken }).toString();
                history.replaceState(null, '', next);
              }}
            />
          )}
        </PayState>
      ) : (
        <PaySection title="Open your payment link">
          <form
            className="form-stack pay-form"
            onSubmit={(event) => {
              event.preventDefault();
              setToken(tokenDraft.trim());
            }}
          >
            <Field
              label="Payment link token"
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
              minLength={8}
              maxLength={200}
              autoComplete="off"
              required
              hint="Use the exact capability from the merchant’s link. This does not sign in to a merchant account."
            />
            <Button type="submit">Open payment link</Button>
          </form>
        </PaySection>
      )}
    </Page>
  );
}
function CheckoutForm({
  link,
  token,
  checkout,
  onOpened,
}: {
  link: z.infer<typeof resolvedLinkSchema>;
  token: string;
  checkout: ReturnType<typeof createCheckoutApi>;
  onOpened: (data: { sessionToken: string; session: z.infer<typeof checkoutSchema> }) => void;
}) {
  const [amount, setAmount] = useState('');
  const [asset, setAsset] = useState('');
  const [country, setCountry] = useState('');
  const [method, setMethod] = useState('');
  return (
    <PaySection title={link.label}>
      <div className="form-stack pay-form">
        <PayDetails
          values={[
            ['Amount', link.amount === null ? 'Payer chooses the amount' : `${displayAmount(link.amount)} ${link.currency ?? ''}`],
            ['Expires', link.expiresAt ?? 'Not provided'],
            ['Remaining uses', link.remainingUses === null ? 'Not limited by this response' : String(link.remainingUses)],
          ]}
        />
        {link.amount === null && (
          <Field label="Payment amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} required />
        )}
        {link.currency === null && (
          <Field
            label="Payment asset"
            value={asset}
            onChange={(event) => setAsset(event.target.value.toUpperCase())}
            maxLength={16}
            required
          />
        )}
        <Field
          label="Your country"
          value={country}
          onChange={(event) => setCountry(event.target.value.toUpperCase())}
          minLength={2}
          maxLength={2}
          hint="Two-letter country code. The service uses it for routing and eligibility."
          required
        />
        <label className="field">
          Payment method
          <select aria-label="Payment method" value={method} onChange={(event) => setMethod(event.target.value)} required>
            <option value="">Choose a method</option>
            <option value="card">Card</option>
            <option value="crypto">Crypto</option>
          </select>
        </label>
        <PayNotice title="Payment availability is checked by the service">
          A method selection does not promise a connected payment rail. If no eligible live rail exists, the session refuses. Opening a
          session does not mark anything paid.
        </PayNotice>
        <ReviewedAction
          title="Open payment session"
          variant="primary"
          description="Review the merchant’s amount and your routing details. The service selects the payment rail. You cannot select a sandbox or mark this link paid."
          review={
            <PayDetails
              values={[
                ['Merchant label', link.label],
                ['Payment', `${link.amount ?? amount} ${link.currency ?? asset}`],
                ['Country', country],
                ['Method', method],
              ]}
            />
          }
          perform={() => checkout.open(link, token, { geoCountry: country, method, amount, assetId: asset })}
          disabled={
            !country ||
            !method ||
            (link.amount === null && !amount) ||
            (link.currency === null && !asset) ||
            Boolean(checkout.guard.status('checkout:open'))
          }
          onConfirmed={onOpened}
        />
        {checkout.guard.status('checkout:open') && (
          <PayNotice title="Original checkout opening is unresolved">
            No new session is opened while the first result is unknown. If you have the original session link, open it to check status.
            Otherwise contact the merchant; do not start another payment.
          </PayNotice>
        )}
      </div>
    </PaySection>
  );
}
function CheckoutStatus({ session }: { session: z.infer<typeof checkoutSchema> }) {
  return (
    <div className="stack">
      <PayDetails
        values={[
          ['Status', <Status value={session.status} />],
          ['Payment', `${displayAmount(session.amount)} ${session.currency}`],
          ['Method', session.method],
          ['Expires', session.expiresAt],
        ]}
      />
      {session.status === 'open' ? (
        session.instruction ? (
          <PaySection title="Payment instructions">
            <PayDetails
              values={[
                ['Reference', session.instruction.reference],
                ['Exact amount', `${displayAmount(session.instruction.amount)} ${session.instruction.currency}`],
              ]}
            />
            <p className="muted">
              Follow only these returned instructions, then refresh status. A receipt or button click does not confirm payment.
            </p>
          </PaySection>
        ) : (
          <PayNotice title="Payment instructions were not returned">
            This session is open, but it supplies no payment destination or hosted card handoff. Do not send money to an invented address.
            Ask the merchant for a supported payment path.
          </PayNotice>
        )
      ) : (
        <p role="status">
          {session.status === 'completed'
            ? 'The service confirmed this session completed.'
            : `This session is ${session.status}. No new payment is initiated from this screen.`}
        </p>
      )}
    </div>
  );
}
