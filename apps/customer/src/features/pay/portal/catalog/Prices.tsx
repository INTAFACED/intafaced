import { useState } from 'react';
import { SALE_CHANNELS, type SaleChannel } from '@intafaced/contracts/merchant-stores';
import { Button } from '@intafaced/ui';
import type { MerchantPrice, MerchantProduct, PriceCreateInput, PriceReplaceInput } from '@intafaced/contracts/merchant-catalog';
import { useResource } from '../../../../shared/resource';
import { Field } from '../../ui-kit';
import { PaySection } from '../../components';
import type { PortalApi } from '../api';
import { MoreFooter, PortalFailure, PortalLoading, SelectField } from '../components';
import { DateTime } from '../ui/DateTime';
import { EntityList } from '../ui/EntityList';
import { formatMoney } from '../ui/format';
import { MoneyText } from '../ui/MoneyText';
import { useServerList } from '../ui/useServerList';
import { useBodyRequestId } from '../payments/invoice-model';
import { refusalText } from '../refusal';
import { catalogCopy as c } from './copy';
import { blankPrice, draftOf, priceBody, priceProblem, type PriceDraft } from './model';
import { useMayAddProducts } from './access';

/**
 * A product's prices (J-merchant-03 steps 3 and 4, M-catalogue-02, M-adv-payments-core-20): the list with its default,
 * Add price, Set as default, Replace price, and a check of an amount a customer would enter on a customer-chosen price.
 * Writing needs the role and a verified business, as adding a product does; everyone on the team reads.
 */
export function ProductPrices({ portal, product }: { portal: PortalApi; product: MerchantProduct }) {
  const { t } = c.useCopy();
  const may = useMayAddProducts();
  const writable = may.allowed && product.status === 'active';
  const list = useServerList(
    (f, cursor, signal) => portal.prices(f.productId, cursor, signal),
    { productId: product.id },
    (p: MerchantPrice) => p.id,
  );
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<MerchantPrice | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [moving, setMoving] = useState<string | null>(null);

  async function makeDefault(price: MerchantPrice) {
    setMoving(price.id);
    setNote(null);
    try {
      const result = await portal.setDefaultPrice({ productId: product.id, priceId: price.id });
      if (result.ok) {
        setNote({ ok: true, text: t('priceDefaultMoved') });
        list.reload();
      } else setNote({ ok: false, text: result.message });
    } finally {
      setMoving(null);
    }
  }

  const prices = list.state.status === 'ready' ? list.state.items : [];
  const chosen = prices.filter((p) => p.kind === 'customer_chosen' && p.status === 'active');
  return (
    <PaySection title={t('pricesTitle')} description={t('pricesPurpose')}>
      <div className="stack">
        {writable && !adding && !replacing && (
          <div className="pp-actions">
            <Button variant="primary" onClick={() => setAdding(true)}>
              {t('addPrice')}
            </Button>
          </div>
        )}
        {adding && (
          <PriceForm
            portal={portal}
            productId={product.id}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              setNote({ ok: true, text: t('priceAdded') });
              list.reload();
            }}
          />
        )}
        {replacing && (
          <PriceForm
            key={replacing.id}
            portal={portal}
            productId={product.id}
            replacing={replacing}
            onCancel={() => setReplacing(null)}
            onSaved={() => {
              setReplacing(null);
              setNote({ ok: true, text: t('replacedDone') });
              list.reload();
            }}
          />
        )}
        {note && (
          <p className={note.ok ? 'pp-confirmed' : 'pp-callout'} role={note.ok ? 'status' : 'alert'}>
            {note.text}
          </p>
        )}
        {list.state.status === 'loading' && <PortalLoading />}
        {list.state.status === 'failed' && <PortalFailure result={list.state.failure} retry={() => list.reload()} />}
        {list.state.status === 'ready' &&
          (prices.length === 0 && !list.state.hasMore ? (
            <p className="muted">{t(writable ? 'pricesEmpty' : 'pricesEmptyReadOnly')}</p>
          ) : (
            <>
              <EntityList
                label={t('pricesLabel')}
                rows={prices}
                rowKey={(row) => row.id}
                columns={[
                  { header: t('colPrice'), cell: (row) => <PriceText price={row} /> },
                  { header: t('colBilling'), cell: (row) => t(`billing_${row.billing}`) },
                  {
                    header: t('colDefault'),
                    cell: (row) =>
                      row.isDefault ? (
                        <strong>{t('defaultMark')}</strong>
                      ) : writable && row.status === 'active' ? (
                        <Button variant="secondary" disabled={moving !== null} onClick={() => void makeDefault(row)}>
                          {t('setDefault')}
                        </Button>
                      ) : (
                        <span className="muted">—</span>
                      ),
                  },
                  { header: t('colStatus'), cell: (row) => t(`status_${row.status}`) },
                  { header: t('colAdded'), cell: (row) => <DateTime value={row.createdAt} /> },
                  {
                    header: t('colChange'),
                    cell: (row) =>
                      writable && row.status === 'active' ? (
                        <Button
                          variant="secondary"
                          disabled={adding || replacing !== null}
                          onClick={() => {
                            setNote(null);
                            setReplacing(row);
                          }}
                        >
                          {t('replacePrice')}
                        </Button>
                      ) : (
                        <span className="muted">—</span>
                      ),
                  },
                ]}
                card={(row) => ({
                  title: <PriceText price={row} />,
                  time: <DateTime value={row.createdAt} />,
                  status: row.isDefault ? t('defaultMark') : t(`billing_${row.billing}`),
                })}
              />
              <MoreFooter state={list.state} onMore={list.loadMore} />
            </>
          ))}
        {chosen.length > 0 && <AmountCheck portal={portal} prices={chosen} />}
        <SaleCheck portal={portal} productId={product.id} prices={prices.filter((p) => p.status === 'active')} />
      </div>
    </PaySection>
  );
}

/** A price as one line: the fixed amount, or the range a customer chooses in. */
function PriceText({ price }: { price: MerchantPrice }) {
  const { t } = c.useCopy();
  if (price.kind === 'fixed' && price.amount) return <MoneyText value={price.amount} asset={price.assetId} />;
  return (
    <span className="numeric">
      {t('priceChosenRange', {
        min: moneyWords(price.minAmount ?? '', price.assetId),
        max: moneyWords(price.maxAmount ?? '', price.assetId),
      })}
    </span>
  );
}

const moneyWords = (value: string, asset: string) => `${formatMoney(value, asset, { exact: true })} ${asset}`;

/** A price in words, for a heading or a picker: "5.00 USDC" or the customer-chosen range. */
export function priceWords(price: MerchantPrice): string {
  if (price.kind === 'fixed' && price.amount) return moneyWords(price.amount, price.assetId);
  return c.t('priceChosenRange', {
    min: moneyWords(price.minAmount ?? '', price.assetId),
    max: moneyWords(price.maxAmount ?? '', price.assetId),
  });
}

/**
 * Add a price, or replace one (`replacing`): the same details, starting from the old price's, saved as a new price that
 * archives the old one in one step. Before a replacement is saved, the form says what uses the old price, and that it
 * stays on it.
 */
function PriceForm({
  portal,
  productId,
  replacing,
  onCancel,
  onSaved,
}: {
  portal: PortalApi;
  productId: string;
  replacing?: MerchantPrice;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = c.useCopy();
  const [draft, setDraft] = useState<PriceDraft>(() => (replacing ? draftOf(replacing) : blankPrice));
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const set = <K extends keyof PriceDraft>(key: K, value: PriceDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const body = priceBody(draft, productId);
  // One request id per body, as for a product: a retry after a lost answer is the same price, any change a new one.
  const request = useBodyRequestId(replacing ? `catalog:price-replace:${replacing.id}` : `catalog:price-new:${productId}`, body);
  const problem = priceProblem(draft);
  const usage = useResource(
    (signal) => (replacing ? portal.priceUsage(replacing.id, signal) : Promise.resolve({ ok: true as const, data: null })),
    `portal:catalog:price-usage:${replacing?.id ?? 'none'}`,
  );

  async function save() {
    setShown(true);
    if (problem) return;
    setBusy(true);
    setRefused(null);
    try {
      request.sent();
      const result = replacing
        ? await portal.replacePrice({ ...body, requestId: request.id, priceId: replacing.id } as PriceReplaceInput)
        : await portal.createPrice({ ...body, requestId: request.id } as PriceCreateInput);
      if (result.ok) {
        request.renew();
        onSaved();
      } else setRefused(result.message);
    } finally {
      setBusy(false);
    }
  }

  const error = (key: NonNullable<ReturnType<typeof priceProblem>>) => (shown && problem === key ? t(key) : undefined);
  return (
    <div
      data-testid="form-stack"
      className="form-stack pp-form"
      role="group"
      aria-label={replacing ? t('replaceTitle', { price: priceWords(replacing) }) : t('addPrice')}
    >
      {replacing && (
        <>
          <h3>{t('replaceTitle', { price: priceWords(replacing) })}</h3>
          <p className="muted">{t('replacePurpose')}</p>
          {usage.resource.status === 'loading' && <PortalLoading />}
          {usage.resource.status === 'failed' && <PortalFailure result={usage.resource.failure} retry={usage.reload} />}
          {usage.resource.status === 'ready' && usage.resource.data && (
            <p className="pp-callout" role="status">
              {usage.resource.data.openSubscriptions === 0
                ? t('replaceUsageNone')
                : usage.resource.data.openSubscriptions === 1
                  ? t('replaceUsageOne')
                  : t('replaceUsageMany', { count: String(usage.resource.data.openSubscriptions) })}
            </p>
          )}
        </>
      )}
      <SelectField
        label={t('billing')}
        value={draft.billing}
        onChange={(value) =>
          setDraft((d) => ({ ...d, billing: value as PriceDraft['billing'], kind: value === 'monthly' ? 'fixed' : d.kind }))
        }
        options={[
          ['one_time', t('billing_one_time')],
          ['monthly', t('billing_monthly')],
        ]}
      />
      {draft.billing === 'one_time' && (
        <SelectField
          label={t('priceKind')}
          hint={t('priceKindHint')}
          value={draft.kind}
          onChange={(value) => set('kind', value as PriceDraft['kind'])}
          options={[
            ['fixed', t('kind_fixed')],
            ['customer_chosen', t('kind_customer_chosen')],
          ]}
        />
      )}
      {draft.kind === 'fixed' ? (
        <Field
          label={t('amount')}
          hint={t('amountHint')}
          inputMode="decimal"
          value={draft.amount}
          onChange={(e) => set('amount', e.target.value)}
          error={error('amountInvalid')}
        />
      ) : (
        <>
          <Field
            label={t('minAmount')}
            inputMode="decimal"
            value={draft.minAmount}
            onChange={(e) => set('minAmount', e.target.value)}
            error={error('boundsInvalid')}
          />
          <Field
            label={t('maxAmount')}
            hint={t('maxAmountHint')}
            inputMode="decimal"
            value={draft.maxAmount}
            onChange={(e) => set('maxAmount', e.target.value)}
          />
        </>
      )}
      <Field
        label={t('asset')}
        hint={t('assetHint')}
        value={draft.assetId}
        maxLength={16}
        autoCapitalize="characters"
        onChange={(e) => set('assetId', e.target.value.toUpperCase())}
        error={error('assetInvalid')}
      />
      {refused && (
        <p className="pp-callout" role="alert">
          {refused}
        </p>
      )}
      <div className="pp-actions">
        <Button
          variant="primary"
          // A replacement is saved only once it has said what uses the old price.
          disabled={busy || (replacing !== undefined && usage.resource.status !== 'ready')}
          onClick={() => void save()}
        >
          {busy ? t('saving') : t(replacing ? 'saveReplacement' : 'savePrice')}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}

/** What a customer-chosen price takes: an amount checked against the business's minimum and maximum by the service. */
function AmountCheck({ portal, prices }: { portal: PortalApi; prices: readonly MerchantPrice[] }) {
  const { t } = c.useCopy();
  const [priceId, setPriceId] = useState(prices[0]!.id);
  const [amount, setAmount] = useState('');
  const [answer, setAnswer] = useState<{ ok: true; amount: string; assetId: string } | { ok: false; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const current = prices.find((p) => p.id === priceId) ?? prices[0]!;

  async function check() {
    setBusy(true);
    setAnswer(null);
    try {
      const result = await portal.quotePrice({ priceId: current.id, amount: amount.trim() });
      setAnswer(
        result.ok ? { ok: true, amount: result.data.amount, assetId: result.data.assetId } : { ok: false, text: refusalText(result) },
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="form-stack" className="form-stack pp-form" role="group" aria-label={t('checkTitle')}>
      <h3>{t('checkTitle')}</h3>
      <p className="muted">{t('checkPurpose')}</p>
      {prices.length > 1 && (
        <SelectField
          label={t('checkPrice')}
          value={current.id}
          onChange={(id) => {
            setPriceId(id);
            setAnswer(null);
          }}
          options={prices.map(
            (p) =>
              [
                p.id,
                t('priceChosenRange', { min: moneyWords(p.minAmount ?? '', p.assetId), max: moneyWords(p.maxAmount ?? '', p.assetId) }),
              ] as const,
          )}
        />
      )}
      <Field
        label={t('checkAmount')}
        inputMode="decimal"
        value={amount}
        onChange={(e) => {
          setAmount(e.target.value);
          setAnswer(null);
        }}
      />
      <div className="pp-actions">
        <Button variant="secondary" disabled={busy || !amount.trim()} onClick={() => void check()}>
          {t('checkButton')}
        </Button>
      </div>
      {answer &&
        (answer.ok ? (
          <p className="pp-confirmed" role="status">
            {t('checkAccepted', { amount: moneyWords(answer.amount, answer.assetId) })}
          </p>
        ) : (
          <p className="pp-callout" role="alert">
            {answer.text}
          </p>
        ))}
    </div>
  );
}

/**
 * Check a sale: what one active price charges in one open store and channel, or the service's refusal where the product
 * is not sold. Shown under the prices, so a price just added is offered at once; nothing when the business has no store.
 */
function SaleCheck({ portal, productId, prices }: { portal: PortalApi; productId: string; prices: readonly MerchantPrice[] }) {
  const { t } = c.useCopy();
  // Every store at once (availability is not paged), so no open store is left out of the choice.
  const open = useResource((signal) => portal.availability(productId, signal), `portal:catalog:sale-check:${productId}`);
  const [priceId, setPriceId] = useState('');
  const [storeId, setStoreId] = useState('');
  const [channel, setChannel] = useState<SaleChannel>('online');
  const [amount, setAmount] = useState('');
  const [answer, setAnswer] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (open.resource.status === 'loading') return <PortalLoading />;
  if (open.resource.status === 'failed') return <PortalFailure result={open.resource.failure} retry={open.reload} />;
  const stores = open.resource.data.stores.filter((s) => s.status === 'active');
  if (prices.length === 0 || stores.length === 0) return null;
  const price = prices.find((p) => p.id === priceId) ?? prices[0]!;
  const store = stores.find((s) => s.storeId === storeId) ?? stores[0]!;

  async function check() {
    setBusy(true);
    setAnswer(null);
    try {
      const result = await portal.quotePrice({
        priceId: price.id,
        ...(price.kind === 'customer_chosen' ? { amount: amount.trim() } : {}),
        storeId: store.storeId,
        channel,
      });
      setAnswer(
        result.ok
          ? { ok: true, text: t('saleCheckAccepted', { amount: moneyWords(result.data.amount, result.data.assetId) }) }
          : { ok: false, text: refusalText(result) },
      );
    } finally {
      setBusy(false);
    }
  }

  const clear =
    <V,>(setter: (value: V) => void) =>
    (value: V) => {
      setter(value);
      setAnswer(null);
    };
  return (
    <div data-testid="form-stack" className="form-stack pp-form" role="group" aria-label={t('saleCheckTitle')}>
      <h3>{t('saleCheckTitle')}</h3>
      <p className="muted">{t('saleCheckPurpose')}</p>
      <SelectField
        label={t('saleCheckPrice')}
        value={price.id}
        onChange={clear(setPriceId)}
        options={prices.map((p) => [p.id, priceWords(p)] as const)}
      />
      <SelectField
        label={t('saleCheckStore')}
        value={store.storeId}
        onChange={clear(setStoreId)}
        options={stores.map((s) => [s.storeId, s.name] as const)}
      />
      <SelectField
        label={t('saleCheckChannel')}
        value={channel}
        onChange={clear((value: string) => setChannel(value as SaleChannel))}
        options={SALE_CHANNELS.map((ch) => [ch, t(`channel_${ch}`)] as const)}
      />
      {price.kind === 'customer_chosen' && (
        <Field label={t('checkAmount')} inputMode="decimal" value={amount} onChange={(e) => clear(setAmount)(e.target.value)} />
      )}
      <div className="pp-actions">
        <Button variant="secondary" disabled={busy || (price.kind === 'customer_chosen' && !amount.trim())} onClick={() => void check()}>
          {t('saleCheckButton')}
        </Button>
      </div>
      {answer && (
        <p className={answer.ok ? 'pp-confirmed' : 'pp-callout'} role={answer.ok ? 'status' : 'alert'}>
          {answer.text}
        </p>
      )}
    </div>
  );
}
