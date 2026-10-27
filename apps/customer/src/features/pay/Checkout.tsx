import { payCopy, PayCopy, payRefusal } from './copy';
import { useMemo, useState, type ReactNode } from 'react';
import { useSession } from '../session/session';
import { useResource, type Resource } from '../../shared/resource';
import { defineCopy } from '../../shared/i18n';
import { displayAmount } from '../../shared/money';
import { Button } from '@intafaced/ui';
import { Field, Page } from './ui-kit';
import { createCheckoutApi } from './pay-api';
import { PayDetails, PayNotice, PaySection, PayState, ReviewedAction, Status, PayTime } from './components';
import type { checkoutSchema, resolvedLinkSchema } from './schemas';
import type { z } from 'zod';

const checkoutReadCopy = defineCopy(
  'pay.checkoutRead',
  {
    linkMissing: 'Payment link not found',
    linkHelp: 'Check the full payment link or ask the merchant to send it again.',
    sessionMissing: 'Payment session not found',
    sessionHelp:
      'This does not confirm whether a payment completed. Check the original payment link or contact the merchant before trying another payment.',
    retry: 'Try again',
    details: 'Service details',
  },
  {
    es: {
      linkMissing: 'Enlace de pago no encontrado',
      linkHelp: 'Comprueba el enlace de pago completo o pide al comercio que lo envíe de nuevo.',
      sessionMissing: 'Sesión de pago no encontrada',
      sessionHelp:
        'Esto no confirma si el pago se completó. Comprueba el enlace de pago original o contacta con el comercio antes de intentar otro pago.',
      retry: 'Intentar de nuevo',
      details: 'Detalles del servicio',
    },
    fr: {
      linkMissing: 'Lien de paiement introuvable',
      linkHelp: 'Vérifiez le lien de paiement complet ou demandez au marchand de le renvoyer.',
      sessionMissing: 'Session de paiement introuvable',
      sessionHelp:
        'Cela ne confirme pas si le paiement a abouti. Vérifiez le lien de paiement initial ou contactez le marchand avant de tenter un autre paiement.',
      retry: 'Réessayer',
      details: 'Détails du service',
    },
  },
);

function CheckoutReadState<T>({
  kind,
  resource,
  retry,
  children,
}: {
  kind: 'link' | 'session';
  resource: Resource<T>;
  retry: () => void;
  children: (data: T) => ReactNode;
}) {
  const { t } = checkoutReadCopy.useCopy();
  const failure = resource.status === 'failed' ? resource.failure : undefined;
  const missingCode = kind === 'link' ? 'pay.link_not_found' : 'pay.checkout_session_not_found';
  // Only a domain-specific missing resource gets this presentation. An absent
  // endpoint, denied read or unavailable service keeps its original refusal.
  if (
    failure?.status === 404 &&
    (failure.code === missingCode || (failure.code === 'NOT_FOUND' && failure.message.startsWith(`${missingCode}:`)))
  ) {
    return (
      <div data-testid="failure" className="failure" role="status">
        <h3>{t(kind === 'link' ? 'linkMissing' : 'sessionMissing')}</h3>
        <p>{t(kind === 'link' ? 'linkHelp' : 'sessionHelp')}</p>
        <Button variant="secondary" onClick={retry}>
          {t('retry')}
        </Button>
        <details>
          <summary>{t('details')}</summary>
          <p lang="und">{failure.message}</p>
        </details>
      </div>
    );
  }
  return (
    <PayState resource={resource} retry={retry}>
      {children}
    </PayState>
  );
}

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
        : Promise.resolve(payRefusal('openAPaymentLinkProvidedByThe', { reason: 'not_supported' })),
    `pay:checkout-link:${token}`,
  );
  const status = useResource(
    (signal) =>
      sessionToken
        ? checkout.status(sessionToken, signal)
        : Promise.resolve(payRefusal('noCheckoutSessionHasBeenOpened', { reason: 'not_supported' })),
    `pay:checkout-status:${sessionToken}`,
  );
  const active = status.resource.status === 'ready' ? status.resource.data : session;
  return (
    <Page
      eyebrow={payCopy.t('hostedCheckout')}
      title={active?.label ? <span lang="und">{active.label}</span> : payCopy.t('payAMerchant')}
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
          <CheckoutReadState kind="session" resource={status.resource} retry={status.reload}>
            {(data) => <CheckoutStatus session={data} />}
          </CheckoutReadState>
          {active && status.resource.status === 'failed' && (
            <PayNotice title={payCopy.t('showingTheOriginalSession')}>
              <PayCopy k="currentPaymentStatusIsUnavailableTheOriginal" /> {session?.status ?? payCopy.t('opened')}
              <PayCopy k="completionHasNotBeenVerifiedByThis" />
            </PayNotice>
          )}
        </PaySection>
      ) : token ? (
        <CheckoutReadState kind="link" resource={resolved.resource} retry={resolved.reload}>
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
        </CheckoutReadState>
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
    <PaySection title={link.label} titleLanguage="und">
      <div className="form-stack pay-form">
        <PayDetails
          values={[
            [
              payCopy.t('amount'),
              link.amount === null ? payCopy.t('payerChoosesTheAmount') : `${displayAmount(link.amount)} ${link.currency ?? ''}`,
            ],
            [payCopy.t('expires'), link.expiresAt ? <PayTime value={link.expiresAt} /> : payCopy.t('notProvided')],
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
                [payCopy.t('merchantLabel'), <span lang="und">{link.label}</span>],
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
          [payCopy.t('method'), <span lang="zxx">{session.method}</span>],
          [payCopy.t('expires'), <PayTime value={session.expiresAt} />],
        ]}
      />
      {session.status === 'open' ? (
        session.instruction ? (
          <PaySection title={payCopy.t('paymentInstructions')}>
            <PayDetails
              values={[
                [payCopy.t('reference'), <span lang="zxx">{session.instruction.reference}</span>],
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
