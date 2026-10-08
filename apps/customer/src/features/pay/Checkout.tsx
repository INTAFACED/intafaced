import { payCopy, PayCopy } from './copy';
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
            message: payCopy.t('openAPaymentLinkProvidedByThe'),
          }),
    `pay:checkout-link:${token}`,
  );
  const status = useResource(
    (signal) =>
      sessionToken
        ? checkout.status(sessionToken, signal)
        : Promise.resolve({ ok: false as const, reason: 'not_supported' as const, message: payCopy.t('noCheckoutSessionHasBeenOpened') }),
    `pay:checkout-status:${sessionToken}`,
  );
  const active = status.resource.status === 'ready' ? status.resource.data : session;
  return (
    <Page
      eyebrow={payCopy.t('hostedCheckout')}
      title={active?.label ?? payCopy.t('payAMerchant')}
      description={payCopy.t('theMerchantLinkDefinesThePaymentOnly')}
    >
      {sessionToken ? (
        <PaySection
          title={payCopy.t('paymentSession')}
          action={
            <Button variant="secondary" onClick={status.reload}>
              <PayCopy k="refreshPaymentStatus" />
            </Button>
          }
        >
          <PayState resource={status.resource} retry={status.reload}>
            {(data) => <CheckoutStatus session={data} />}
          </PayState>
          {active && status.resource.status === 'failed' && (
            <PayNotice title={payCopy.t('showingTheOriginalSession')}>
              <PayCopy k="currentPaymentStatusIsUnavailableTheOriginal" /> {session?.status ?? payCopy.t('opened')}
              <PayCopy k="completionHasNotBeenVerifiedByThis" />
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
        <PaySection title={payCopy.t('openYourPaymentLink')}>
          <form
            className="form-stack pay-form"
            onSubmit={(event) => {
              event.preventDefault();
              setToken(tokenDraft.trim());
            }}
          >
            <Field
              label={payCopy.t('paymentLinkToken')}
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
              minLength={8}
              maxLength={200}
              autoComplete="off"
              required
              hint={payCopy.t('useTheExactCapabilityFromTheMerchant')}
            />
            <Button type="submit">
              <PayCopy k="openPaymentLink" />
            </Button>
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
            [
              payCopy.t('amount'),
              link.amount === null ? payCopy.t('payerChoosesTheAmount') : `${displayAmount(link.amount)} ${link.currency ?? ''}`,
            ],
            [payCopy.t('expires'), link.expiresAt ?? payCopy.t('notProvided')],
            [payCopy.t('remainingUses'), link.remainingUses === null ? payCopy.t('notLimitedByThisResponse') : String(link.remainingUses)],
          ]}
        />
        {link.amount === null && (
          <Field
            label={payCopy.t('paymentAmount')}
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            required
          />
        )}
        {link.currency === null && (
          <Field
            label={payCopy.t('paymentAsset')}
            value={asset}
            onChange={(event) => setAsset(event.target.value.toUpperCase())}
            maxLength={16}
            required
          />
        )}
        <Field
          label={payCopy.t('yourCountry')}
          value={country}
          onChange={(event) => setCountry(event.target.value.toUpperCase())}
          minLength={2}
          maxLength={2}
          hint={payCopy.t('twoLetterCountryCodeTheServiceUses')}
          required
        />
        <label className="field">
          <PayCopy k="paymentMethod" />
          <select aria-label={payCopy.t('paymentMethod')} value={method} onChange={(event) => setMethod(event.target.value)} required>
            <option value="">{payCopy.t('chooseAMethod')}</option>
            <option value="card">{payCopy.t('card')}</option>
            <option value="crypto">{payCopy.t('crypto')}</option>
          </select>
        </label>
        <PayNotice title={payCopy.t('paymentAvailabilityIsCheckedByTheService')}>
          <PayCopy k="aMethodSelectionDoesNotPromiseA" />
        </PayNotice>
        <ReviewedAction
          title={payCopy.t('openPaymentSession')}
          variant="primary"
          description={payCopy.t('reviewTheMerchantSAmountAndYour')}
          review={
            <PayDetails
              values={[
                [payCopy.t('merchantLabel'), link.label],
                [payCopy.t('payment'), `${link.amount ?? amount} ${link.currency ?? asset}`],
                [payCopy.t('country'), country],
                [payCopy.t('method'), method],
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
          <PayNotice title={payCopy.t('originalCheckoutOpeningIsUnresolved')}>
            <PayCopy k="noNewSessionIsOpenedWhileThe" />
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
          [payCopy.t('status'), <Status value={session.status} />],
          [payCopy.t('payment'), `${displayAmount(session.amount)} ${session.currency}`],
          [payCopy.t('method'), session.method],
          [payCopy.t('expires'), session.expiresAt],
        ]}
      />
      {session.status === 'open' ? (
        session.instruction ? (
          <PaySection title={payCopy.t('paymentInstructions')}>
            <PayDetails
              values={[
                [payCopy.t('reference'), session.instruction.reference],
                [payCopy.t('exactAmount'), `${displayAmount(session.instruction.amount)} ${session.instruction.currency}`],
              ]}
            />
            <p className="muted">
              <PayCopy k="followOnlyTheseReturnedInstructionsThenRefresh" />
            </p>
          </PaySection>
        ) : (
          <PayNotice title={payCopy.t('paymentInstructionsWereNotReturned')}>
            <PayCopy k="thisSessionIsOpenButItSupplies" />
          </PayNotice>
        )
      ) : (
        <p role="status">
          {session.status === 'completed'
            ? payCopy.t('theServiceConfirmedThisSessionCompleted')
            : payCopy.t('thisSessionIsNoNewPaymentIs', { status: session.status })}
        </p>
      )}
    </div>
  );
}
