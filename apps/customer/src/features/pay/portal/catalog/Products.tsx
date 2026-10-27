import { useEffect, useState, type ChangeEvent } from 'react';
import { Button } from '@intafaced/ui';
import { PRODUCT_TYPES, type MerchantProduct, type ProductImageRules } from '@intafaced/contracts/merchant-catalog';
import { EmptyState, Field } from '../../ui-kit';
import { navigate } from '../../../../app/location';
import { useResource } from '../../../../shared/resource';
import { PaySection } from '../../components';
import type { PortalApi } from '../api';
import { Facts, Gate, MoreFooter, PortalFailure, PortalLoading, SelectField } from '../components';
import { base64Of } from '../settings/onboarding/Application';
import { DateTime } from '../ui/DateTime';
import { DetailHeader } from '../ui/DetailHeader';
import { EntityList } from '../ui/EntityList';
import { Freshness } from '../ui/Freshness';
import { useServerList } from '../ui/useServerList';
import { useReadAt, useUrlParam } from '../hooks';
import { useBodyRequestId } from '../payments/invoice-model';
import { useMayAddProducts } from './access';
import { ProductAvailabilitySection } from './Availability';
import { CatalogCopyControl } from './CatalogCopy';
import { inMode, useCatalogMode, type CatalogMode as Mode } from './mode';
import { ProductImport } from './ProductImport';
import { ProductPrices } from './Prices';
import { catalogCopy as c } from './copy';
import { blankProduct, checkImage, draftProblem, imageRequestId, productBody, sizeText, type ProductDraft } from './model';

const productHref = (id: string) => `/pay/products/${encodeURIComponent(id)}`;

/** `/pay/products`, `/pay/products/new`, `/pay/products/import` and `/pay/products/:productId` (J-merchant-03 steps 1, 2, 4 and 5). */
export function Products({ portal, route }: { portal: PortalApi; route: { room: string; param?: string } }) {
  if (route.room === 'product-new') return <ProductCreate portal={portal} />;
  if (route.room === 'product-import') return <ProductImport portal={portal} />;
  if (route.room === 'product' && route.param) return <ProductDetail portal={portal} productId={route.param} />;
  return <ProductList portal={portal} />;
}

const addButton = (label: string, importLabel: string, mode: Mode) => (
  <div className="pp-actions">
    <Button variant="primary" nativeButton={false} role="link" render={<a href={inMode('/pay/products/new', mode)} />}>
      {label}
    </Button>
    <Button variant="secondary" nativeButton={false} role="link" render={<a href={inMode('/pay/products/import', mode)} />}>
      {importLabel}
    </Button>
  </div>
);

/**
 * One catalogue (Catalogue › Live or Test), active products first. Copy to live or Copy to test sits above it. An archived product is listed only under Show › Archived products; an empty
 * active list says whether archived products exist, so "No products yet" is said only of a catalogue that has none.
 */
export function ProductList({ portal }: { portal: PortalApi }) {
  const { t } = c.useCopy();
  const may = useMayAddProducts();
  const [shown, setShown] = useUrlParam('status', 'active');
  const [mode, setMode] = useCatalogMode();
  const status = shown === 'archived' ? 'archived' : 'active';
  const list = useServerList(
    (f, cursor, signal) => portal.products(f.status, cursor, signal, f.mode),
    { status, mode },
    (p: MerchantProduct) => p.id,
  );
  const readAt = useReadAt(list.state.status === 'ready', list.state);
  return (
    <div className="stack">
      <Freshness asOf={readAt} />
      <SelectField
        label={t('catalogueLabel')}
        value={mode}
        onChange={(value) => setMode(value === 'test' ? 'test' : 'live')}
        options={[
          ['live', t('mode_live')],
          ['test', t('mode_test')],
        ]}
      />
      <CatalogCopyControl key={mode} portal={portal} from={mode} />
      <SelectField
        label={t('showLabel')}
        value={status}
        onChange={setShown}
        options={[
          ['active', t('show_active')],
          ['archived', t('show_archived')],
        ]}
      />
      {list.state.status === 'loading' && <PortalLoading />}
      {list.state.status === 'failed' && <PortalFailure result={list.state.failure} retry={() => list.reload()} />}
      {list.state.status === 'ready' &&
        (list.state.items.length === 0 && !list.state.hasMore ? (
          status === 'archived' ? (
            <EmptyState title={t('emptyArchivedTitle')}>{t('emptyArchivedBody')}</EmptyState>
          ) : (
            <EmptyActive portal={portal} mode={mode} add={may.allowed ? addButton(t('add'), t('importLink'), mode) : undefined} />
          )
        ) : (
          <>
            {may.allowed && addButton(t('add'), t('importLink'), mode)}
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

/** An empty active list: "No products yet" only when nothing is archived either. */
function EmptyActive({ portal, mode, add }: { portal: PortalApi; mode: Mode; add: ReturnType<typeof addButton> | undefined }) {
  const { t } = c.useCopy();
  const may = useMayAddProducts();
  const { resource, reload } = useResource(
    (signal) => portal.products('archived', undefined, signal, mode),
    `portal:catalog:archived-probe:${mode}`,
  );
  if (resource.status === 'loading') return <PortalLoading />;
  if (resource.status === 'failed') return <PortalFailure result={resource.failure} retry={reload} />;
  if (resource.data.items.length > 0)
    return (
      <EmptyState title={t('emptyActiveTitle')} action={add}>
        {t('emptyActiveBody')}
      </EmptyState>
    );
  return (
    <EmptyState title={t('emptyTitle')} action={add}>
      {t(may.allowed ? 'emptyBody' : may.unverified ? 'emptyBodyUnverified' : 'emptyBodyReadOnly')}
    </EmptyState>
  );
}

export function ProductCreate({ portal }: { portal: PortalApi }) {
  const { t } = c.useCopy();
  const may = useMayAddProducts();
  const rules = useResource((signal) => portal.productImageRules(signal), 'portal:catalog:image-rules');
  const [draft, setDraft] = useState<ProductDraft>(blankProduct);
  const [mode] = useCatalogMode();
  // One request id per body: a retry of the same product after a lost answer is the same request, and any change to it
  // is a new one, so the service never sees one id with two different products.
  const { requestId: _unsent, ...body } = productBody(draft, '', mode);
  const request = useBodyRequestId('catalog:product-new', body);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const set = <K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const problem = draftProblem(draft);

  async function save() {
    setShown(true);
    if (problem || uploading) return;
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
      <div data-testid="form-stack" className="form-stack pp-form">
        {mode === 'test' && (
          <p className="pp-callout" role="note">
            {t('testCatalogueNote')}
          </p>
        )}
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
          {(published) => (
            <ImagePicker
              portal={portal}
              rules={published}
              imageId={draft.imageId}
              onChange={(id) => set('imageId', id)}
              onBusy={setUploading}
            />
          )}
        </Gate>
        {refused && (
          <p className="pp-callout" role="alert">
            {refused}
          </p>
        )}
        <div className="pp-actions">
          <Button variant="primary" disabled={!draft.name.trim() || busy || uploading} onClick={() => void save()}>
            {busy ? t('saving') : t('save')}
          </Button>
        </div>
      </div>
    </PaySection>
  );
}

/**
 * The image field: the owner's rule, checked on the picked file before it is sent, then kept by the service at once.
 * Save waits while an upload runs (`onBusy`), so a product is never saved without the picture just picked.
 */
function ImagePicker({
  portal,
  rules,
  imageId,
  onChange,
  onBusy,
}: {
  portal: PortalApi;
  rules: ProductImageRules;
  imageId: string | null;
  onChange: (imageId: string | null) => void;
  onBusy: (busy: boolean) => void;
}) {
  const { t } = c.useCopy();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusyState] = useState(false);
  // The picked file shows from the browser's own copy; nothing is fetched back to preview it.
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);
  const setBusy = (value: boolean) => {
    setBusyState(value);
    onBusy(value);
  };
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
      setPreview(null);
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
      // The request id comes from the file's own bytes: sending the same file again after a lost answer is the same
      // upload, and the service hands back the image it already kept instead of storing a second copy.
      const result = await portal.uploadProductImage({
        requestId: await imageRequestId(file),
        contentType: file.type,
        dataBase64: await base64Of(file),
      });
      if (result.ok) {
        onChange(result.data.imageId);
        setPreview(URL.createObjectURL(file));
        setNote({ ok: true, text: t('imageAdded') });
      } else {
        onChange(null);
        setPreview(null);
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
          {preview && <img className="pp-product-image" src={preview} alt={t('imagePreviewAlt')} width={160} />}
          <Button
            variant="secondary"
            onClick={() => {
              onChange(null);
              setPreview(null);
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
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <Gate resource={resource} retry={reload} rows={4}>
      {(product) => (
        <div className="stack">
          <DetailHeader
            back={{ href: inMode('/pay/products', product.mode), label: t('back') }}
            title={product.name}
            status={t(`status_${product.status}`)}
          />
          {product.status === 'archived' && <p className="pp-callout">{t('archivedNotice')}</p>}
          <ProductActions
            portal={portal}
            product={product}
            onDone={(text) => {
              setNote({ ok: true, text });
              reload();
            }}
            onRefused={(text) => setNote({ ok: false, text })}
          />
          {note && (
            <p className={note.ok ? 'pp-confirmed' : 'pp-callout'} role={note.ok ? 'status' : 'alert'}>
              {note.text}
            </p>
          )}
          <Facts
            items={[
              [t('factName'), product.name],
              [t('factType'), t(`type_${product.type}`)],
              [t('factId'), <code key="id">{product.productKey}</code>],
              [t('factCatalogue'), t(`mode_${product.mode}`)],
              ...(product.copiedFrom
                ? ([
                    [
                      t('factCopiedFrom'),
                      <a key="from" className="text-link" href={productHref(product.copiedFrom)}>
                        {t(product.mode === 'live' ? 'copiedFromTest' : 'copiedFromLive')}
                      </a>,
                    ],
                  ] as const)
                : []),
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
          <ProductPrices portal={portal} product={product} />
          <ProductAvailabilitySection portal={portal} product={product} />
        </div>
      )}
    </Gate>
  );
}

/**
 * Archive, unarchive or delete a product (M-adv-payments-core-20). Archiving is undone by Unarchive. Deleting asks once
 * more, and the service refuses it for a product that has any price (`pay.product_has_prices`), so a product a
 * subscription or a document names is archived instead.
 */
function ProductActions({
  portal,
  product,
  onDone,
  onRefused,
}: {
  portal: PortalApi;
  product: MerchantProduct;
  onDone: (text: string) => void;
  onRefused: (text: string) => void;
}) {
  const { t } = c.useCopy();
  const may = useMayAddProducts();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  if (!may.allowed) return null;

  async function act(run: () => Promise<{ ok: true } | { ok: false; message: string }>, done: () => void) {
    setBusy(true);
    try {
      const result = await run();
      if (result.ok) done();
      else onRefused(result.message);
    } finally {
      setBusy(false);
    }
  }
  const archived = product.status === 'archived';
  return (
    <div className="pp-actions">
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() =>
          void act(
            () => (archived ? portal.unarchiveProduct(product.id) : portal.archiveProduct(product.id)),
            () => onDone(t(archived ? 'unarchivedDone' : 'archivedDone')),
          )
        }
      >
        {t(archived ? 'unarchive' : 'archive')}
      </Button>
      {confirming ? (
        <div className="pp-actions" role="group" aria-label={t('deleteProduct')}>
          <span>{t('deleteConfirm')}</span>
          <Button
            variant="sell"
            disabled={busy}
            onClick={() =>
              void act(
                () => portal.deleteProduct(product.id),
                () => navigate(inMode('/pay/products', product.mode)),
              ).finally(() => setConfirming(false))
            }
          >
            {t('deleteProduct')}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
            {t('deleteKeep')}
          </Button>
        </div>
      ) : (
        <Button variant="secondary" disabled={busy} onClick={() => setConfirming(true)}>
          {t('deleteProduct')}
        </Button>
      )}
    </div>
  );
}
