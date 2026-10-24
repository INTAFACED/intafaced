import { useState, type ChangeEvent } from 'react';
import { Button } from '@intafaced/ui';
import { PRODUCT_TYPES, type MerchantProduct, type ProductImageRules } from '@intafaced/contracts/merchant-catalog';
import { EmptyState, Field } from '../../ui-kit';
import { navigate } from '../../../../app/location';
import { useResource } from '../../../../shared/resource';
import { PaySection } from '../../components';
import { useMerchantAccess } from '../access/MerchantAccess';
import type { PortalApi } from '../api';
import { Facts, Gate, MoreFooter, PortalFailure, PortalLoading, SelectField } from '../components';
import { newRequestId } from '../model';
import { base64Of } from '../settings/onboarding/Application';
import { DateTime } from '../ui/DateTime';
import { DetailHeader } from '../ui/DetailHeader';
import { EntityList } from '../ui/EntityList';
import { Freshness } from '../ui/Freshness';
import { useServerList } from '../ui/useServerList';
import { useReadAt } from '../hooks';
import { useBodyRequestId } from '../payments/invoice-model';
import { catalogCopy as c } from './copy';
import { blankProduct, checkImage, draftProblem, productBody, sizeText, type ProductDraft } from './model';

const productHref = (id: string) => `/pay/products/${encodeURIComponent(id)}`;

/** `/pay/products`, `/pay/products/new` and `/pay/products/:productId` (J-merchant-03 steps 1 and 2). */
export function Products({ portal, route }: { portal: PortalApi; route: { room: string; param?: string } }) {
  if (route.room === 'product-new') return <ProductCreate portal={portal} />;
  if (route.room === 'product' && route.param) return <ProductDetail portal={portal} productId={route.param} />;
  return <ProductList portal={portal} />;
}

/** Whether this person may add products here: the role table says so, and the business is verified (the service's rule too). */
export function useMayAddProducts(): { allowed: boolean; unverified: boolean } {
  const { access, can } = useMerchantAccess();
  const unverified = access.status === 'ready' && access.kybStatus !== 'approved';
  return { allowed: can('products.manage') && !unverified, unverified: can('products.manage') && unverified };
}

const addButton = (label: string) => (
  <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/products/new" />}>
    {label}
  </Button>
);

export function ProductList({ portal }: { portal: PortalApi }) {
  const { t } = c.useCopy();
  const may = useMayAddProducts();
  const list = useServerList(
    (f, cursor, signal) => portal.products(f.status, cursor, signal),
    { status: '' },
    (p: MerchantProduct) => p.id,
  );
  const readAt = useReadAt(list.state.status === 'ready', list.state);
  return (
    <div className="stack">
      <Freshness asOf={readAt} />
      {list.state.status === 'loading' && <PortalLoading />}
      {list.state.status === 'failed' && <PortalFailure result={list.state.failure} retry={() => list.reload()} />}
      {list.state.status === 'ready' &&
        (list.state.items.length === 0 && !list.state.hasMore ? (
          <EmptyState title={t('emptyTitle')} action={may.allowed ? addButton(t('add')) : undefined}>
            {t(may.allowed ? 'emptyBody' : may.unverified ? 'emptyBodyUnverified' : 'emptyBodyReadOnly')}
          </EmptyState>
        ) : (
          <>
            {may.allowed && <div className="pp-actions">{addButton(t('add'))}</div>}
            <EntityList
              label={t('listLabel')}
              rows={list.state.items}
              rowKey={(row) => row.id}
              href={(row) => productHref(row.id)}
              columns={[
                { header: t('colName'), cell: (row) => <strong>{row.name}</strong> },
                { header: t('colType'), cell: (row) => t(`type_${row.type}`) },
                { header: t('colId'), cell: (row) => <code>{row.productKey}</code> },
                { header: t('colStatus'), cell: (row) => t(`status_${row.status}`) },
                { header: t('colAdded'), cell: (row) => <DateTime value={row.createdAt} /> },
              ]}
              card={(row) => ({ title: row.name, time: <DateTime value={row.createdAt} />, status: t(`status_${row.status}`) })}
            />
            <MoreFooter state={list.state} onMore={list.loadMore} />
          </>
        ))}
    </div>
  );
}

export function ProductCreate({ portal }: { portal: PortalApi }) {
  const { t } = c.useCopy();
  const may = useMayAddProducts();
  const rules = useResource((signal) => portal.productImageRules(signal), 'portal:catalog:image-rules');
  const [draft, setDraft] = useState<ProductDraft>(blankProduct);
  // One request id per body: a retry of the same product after a lost answer is the same request, and any change to it
  // is a new one, so the service never sees one id with two different products.
  const { requestId: _unsent, ...body } = productBody(draft, '');
  const request = useBodyRequestId('catalog:product-new', body);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const set = <K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const problem = draftProblem(draft);

  async function save() {
    setShown(true);
    if (problem) return;
    setBusy(true);
    setRefused(null);
    try {
      request.sent();
      const result = await portal.createProduct({ ...body, requestId: request.id });
      if (result.ok) {
        request.renew();
        navigate(productHref(result.data.product.id));
      } else {
        setRefused(result.message);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!may.allowed) return <EmptyState title={t('newTitle')}>{t(may.unverified ? 'emptyBodyUnverified' : 'emptyBodyReadOnly')}</EmptyState>;
  return (
    <PaySection title={t('newTitle')} description={t('newPurpose')}>
      <div className="form-stack pp-form">
        <Field
          label={t('name')}
          hint={t('nameHint')}
          value={draft.name}
          maxLength={250}
          onChange={(e) => set('name', e.target.value)}
          error={shown && problem === 'nameRequired' ? t('nameRequired') : undefined}
        />
        <SelectField
          label={t('type')}
          value={draft.type}
          onChange={(value) => set('type', value as ProductDraft['type'])}
          options={PRODUCT_TYPES.map((type) => [type, t(`type_${type}`)] as const)}
        />
        {draft.type === 'event' && (
          <>
            <Field
              label={t('eventStarts')}
              hint={t('eventStartsHint')}
              type="datetime-local"
              value={draft.eventStartsAt}
              onChange={(e) => set('eventStartsAt', e.target.value)}
              error={shown && problem === 'eventInvalid' && !draft.eventStartsAt ? t('eventInvalid') : undefined}
            />
            <Field
              label={t('eventLocation')}
              hint={t('eventLocationHint')}
              value={draft.eventLocation}
              maxLength={200}
              onChange={(e) => set('eventLocation', e.target.value)}
              error={shown && problem === 'eventInvalid' && draft.eventStartsAt ? t('eventInvalid') : undefined}
            />
          </>
        )}
        <Field
          label={t('unitLabel')}
          hint={t('unitLabelHint')}
          value={draft.unitLabel}
          maxLength={40}
          onChange={(e) => set('unitLabel', e.target.value)}
        />
        <Field
          label={t('descriptor')}
          hint={t('descriptorHint')}
          value={draft.statementDescriptor}
          maxLength={22}
          onChange={(e) => set('statementDescriptor', e.target.value)}
          error={shown && problem === 'descriptorInvalid' ? t('descriptorInvalid') : undefined}
        />
        <Field
          label={t('productKey')}
          hint={t('productKeyHint')}
          value={draft.productKey}
          maxLength={64}
          onChange={(e) => set('productKey', e.target.value)}
          error={shown && problem === 'keyInvalid' ? t('keyInvalid') : undefined}
        />
        <Gate resource={rules.resource} retry={rules.reload} rows={1}>
          {(published) => <ImagePicker portal={portal} rules={published} imageId={draft.imageId} onChange={(id) => set('imageId', id)} />}
        </Gate>
        {refused && (
          <p className="pp-callout" role="alert">
            {refused}
          </p>
        )}
        <div className="pp-actions">
          <Button variant="primary" disabled={!draft.name.trim() || busy} onClick={() => void save()}>
            {busy ? t('saving') : t('save')}
          </Button>
        </div>
      </div>
    </PaySection>
  );
}

/** The image field: the owner's rule, checked on the picked file before it is sent, then kept by the service at once. */
function ImagePicker({
  portal,
  rules,
  imageId,
  onChange,
}: {
  portal: PortalApi;
  rules: ProductImageRules;
  imageId: string | null;
  onChange: (imageId: string | null) => void;
}) {
  const { t } = c.useCopy();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (rules.maxBytes === null)
    return (
      <div className="field">
        <span>{t('image')}</span>
        <p className="muted" data-testid="product-image-off">
          {t('imageRulesUnset')}
        </p>
      </div>
    );
  const max = sizeText(rules.maxBytes);
  async function picked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const check = checkImage(file, rules);
    if (!check.ok) {
      onChange(null);
      setNote({
        ok: false,
        text:
          check.reason === 'rulesUnset'
            ? t('imageRulesUnset')
            : t(check.reason === 'tooLarge' ? 'imageTooLarge' : 'imageWrongType', { size: sizeText(check.size), max: sizeText(check.max) }),
      });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const result = await portal.uploadProductImage({
        requestId: newRequestId(),
        contentType: file.type,
        dataBase64: await base64Of(file),
      });
      if (result.ok) {
        onChange(result.data.imageId);
        setNote({ ok: true, text: t('imageAdded') });
      } else {
        onChange(null);
        setNote({ ok: false, text: result.message });
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="field">
      <Field
        label={t('image')}
        hint={t('imageRule', { size: max })}
        type="file"
        accept={rules.types.join(',')}
        disabled={busy}
        onChange={(e) => void picked(e)}
      />
      {busy && <p className="muted">{t('imageUploading')}</p>}
      {note && (
        <p className={note.ok ? 'pp-confirmed' : 'pp-callout'} role={note.ok ? 'status' : 'alert'}>
          {note.text}
        </p>
      )}
      {imageId && (
        <>
          <ProductImage portal={portal} imageId={imageId} name="" />
          <Button
            variant="secondary"
            onClick={() => {
              onChange(null);
              setNote(null);
            }}
          >
            {t('imageRemove')}
          </Button>
        </>
      )}
    </div>
  );
}

function ProductImage({ portal, imageId, name }: { portal: PortalApi; imageId: string; name: string }) {
  const { t } = c.useCopy();
  const { resource } = useResource((signal) => portal.productImage(imageId, signal), `portal:catalog:image:${imageId}`);
  if (resource.status !== 'ready') return null;
  return (
    <img
      className="pp-product-image"
      src={`data:${resource.data.contentType};base64,${resource.data.dataBase64}`}
      alt={t('imageAlt', { name })}
      width={160}
    />
  );
}

export function ProductDetail({ portal, productId }: { portal: PortalApi; productId: string }) {
  const { t } = c.useCopy();
  const { resource, reload } = useResource((signal) => portal.product(productId, signal), `portal:catalog:product:${productId}`);
  return (
    <Gate resource={resource} retry={reload} rows={4}>
      {(product) => (
        <div className="stack">
          <DetailHeader back={{ href: '/pay/products', label: t('back') }} title={product.name} status={t(`status_${product.status}`)} />
          <Facts
            items={[
              [t('factName'), product.name],
              [t('factType'), t(`type_${product.type}`)],
              [t('factId'), <code key="id">{product.productKey}</code>],
              [t('factUnit'), product.unitLabel ?? t('none')],
              [t('factDescriptor'), product.statementDescriptor ?? t('none')],
              ...(product.event
                ? ([
                    [t('factStarts'), <DateTime key="starts" value={product.event.startsAt} />],
                    [t('factLocation'), product.event.location],
                  ] as const)
                : []),
              [t('factStatus'), t(`status_${product.status}`)],
              [t('factAdded'), <DateTime key="added" value={product.createdAt} />],
            ]}
          />
          {product.imageId ? (
            <ProductImage portal={portal} imageId={product.imageId} name={product.name} />
          ) : (
            <p className="muted">{t('noImage')}</p>
          )}
        </div>
      )}
    </Gate>
  );
}
