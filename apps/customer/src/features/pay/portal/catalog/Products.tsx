import { useState } from 'react';
import { Button } from '@intafaced/ui';
import type { MerchantProduct } from '@intafaced/contracts/merchant-catalog';
import { EmptyState } from '../../ui-kit';
import { navigate } from '../../../../app/location';
import { useResource } from '../../../../shared/resource';
import type { PortalApi } from '../api';
import { Facts, Gate, MoreFooter, PortalFailure, PortalLoading, SelectField } from '../components';
import { DateTime } from '../ui/DateTime';
import { DetailHeader } from '../ui/DetailHeader';
import { EntityList } from '../ui/EntityList';
import { Freshness } from '../ui/Freshness';
import { useServerList } from '../ui/useServerList';
import { useReadAt, useUrlParam } from '../hooks';
import { useMayAddProducts } from './access';
import { ProductAvailabilitySection } from './Availability';
import { CatalogCopyControl } from './CatalogCopy';
import { inMode, useCatalogMode, type CatalogMode as Mode } from './mode';
import { ProductImport } from './ProductImport';
import { ProductCreate } from '../flow/ProductNewRoom';

export { ProductCreate };
import { ProductPrices } from './Prices';
import { catalogCopy as c } from './copy';

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
