// volt-room: /pay/products
// volt-room: /pay/products/:productId
// volt-room: portal:products
// volt-room: portal:product
import { useState } from 'react';
import { Button } from '@intafaced/ui/lit';
import type { MerchantProduct } from '@intafaced/contracts/merchant-catalog';
import { navigate } from '../../../../app/location';
import { useResource } from '../../../../shared/resource';
import type { PortalApi } from '../api';
import { useMerchantAccess } from '../access/MerchantAccess';
import { Empty, EntityList, Facts, Failure, Freshness, Gate, LinkButton, Loading, MoreFooter, SelectField } from '../volt/parts';
import { RecordListRoom, type RecordListSlots } from '../volt/RecordListRoom';
import { DateTime } from '../ui/DateTime';
import { useServerList } from '../ui/useServerList';
import { useReadAt, useUrlParam } from '../hooks';
import { useMayAddProducts } from './access';
import { ProductAvailabilitySection } from './Availability';
import { CatalogCopyControl } from './CatalogCopy';
import { inMode, useCatalogMode, type CatalogMode as Mode } from './mode';
import { ProductPrices } from './Prices';
import { catalogCopy as c } from './copy';

const productHref = (id: string) => `/pay/products/${encodeURIComponent(id)}`;

/** A service's answer: done in the kit's hint, refused in its refusal look. */
const DONE_LOOK = 'lt-hint';
const REFUSED_LOOK = 'lt-refusal';

/**
 * `/pay/products` and `/pay/products/:productId` on the record-list template (J-merchant-03 steps 1, 4 and 5): the
 * catalogue with its filters, or one product's own page. Every role reads; the page gates adding.
 */
export function ProductsRoom({ portal, productId }: { portal: PortalApi; productId?: string }) {
  const { access, can } = useMerchantAccess();
  // Until the business is known (and the person may read products), the template draws its own loading, refusal and role states.
  if (access.status !== 'ready' || !can('products.read')) return <RecordListRoom need="products.read">{() => ({})}</RecordListRoom>;
  if (productId)
    return (
      <RecordListRoom need="products.read">{() => ({ detail: <ProductDetail portal={portal} productId={productId} /> })}</RecordListRoom>
    );
  return <ProductsPage portal={portal} />;
}

function ProductsPage({ portal }: { portal: PortalApi }) {
  const slots = useProductSlots(portal);
  return <RecordListRoom need="products.read">{() => slots}</RecordListRoom>;
}

const addButtons = (label: string, importLabel: string, mode: Mode) => (
  <div className="lt-actions">
    <LinkButton href={inMode('/pay/products/new', mode)} tone="primary">
      {label}
    </LinkButton>
    <LinkButton href={inMode('/pay/products/import', mode)}>{importLabel}</LinkButton>
  </div>
);

/**
 * One catalogue (Catalogue › Live or Test), active products first. Copy to live or Copy to test sits above it. An archived
 * product is listed only under Show › Archived products; an empty active list says whether archived products exist, so
 * "No products yet" is said only of a catalogue that has none. Every region in one column: the parts the room hands its
 * template.
 */
export function ProductList({ portal }: { portal: PortalApi }) {
  const slots = useProductSlots(portal);
  return (
    <div className="lt-stack">
      {slots.filters}
      {slots.tools}
      {slots.summary}
      {slots.list}
    </div>
  );
}

/** The regions of the products list for the record-list template. */
function useProductSlots(portal: PortalApi): RecordListSlots {
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
  return {
    filters: (
      <div className="lt-field-row">
        <SelectField
          label={t('catalogueLabel')}
          value={mode}
          onChange={(value) => setMode(value === 'test' ? 'test' : 'live')}
          options={[
            ['live', t('mode_live')],
            ['test', t('mode_test')],
          ]}
        />
        <SelectField
          label={t('showLabel')}
          value={status}
          onChange={setShown}
          options={[
            ['active', t('show_active')],
            ['archived', t('show_archived')],
          ]}
        />
      </div>
    ),
    tools: <CatalogCopyControl key={mode} portal={portal} from={mode} />,
    summary: <Freshness asOf={readAt} />,
    list:
      list.state.status === 'loading' ? (
        <Loading />
      ) : list.state.status === 'failed' ? (
        <Failure result={list.state.failure} retry={() => list.reload()} />
      ) : list.state.items.length === 0 && !list.state.hasMore ? (
        status === 'archived' ? (
          <Empty title={t('emptyArchivedTitle')}>{t('emptyArchivedBody')}</Empty>
        ) : (
          <EmptyActive portal={portal} mode={mode} add={may.allowed ? addButtons(t('add'), t('importLink'), mode) : undefined} />
        )
      ) : (
        <div className="lt-stack">
          {may.allowed && addButtons(t('add'), t('importLink'), mode)}
          <EntityList
            label={t('listLabel')}
            rows={list.state.items}
            rowKey={(row) => row.id}
            href={(row) => productHref(row.id)}
            columns={[
              { header: t('colName'), cell: (row) => <strong>{row.name}</strong> },
              { header: t('colType'), cell: (row) => t(`type_${row.type}`) },
              { header: t('colId'), cell: (row) => <code className="lt-mono">{row.productKey}</code> },
              { header: t('colStatus'), cell: (row) => t(`status_${row.status}`) },
              { header: t('colAdded'), cell: (row) => <DateTime value={row.createdAt} /> },
            ]}
          />
          <MoreFooter state={list.state} onMore={list.loadMore} />
        </div>
      ),
  };
}

/** An empty active list: "No products yet" only when nothing is archived either. */
function EmptyActive({ portal, mode, add }: { portal: PortalApi; mode: Mode; add: ReturnType<typeof addButtons> | undefined }) {
  const { t } = c.useCopy();
  const may = useMayAddProducts();
  const { resource, reload } = useResource(
    (signal) => portal.products('archived', undefined, signal, mode),
    `portal:catalog:archived-probe:${mode}`,
  );
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  if (resource.data.items.length > 0)
    return (
      <Empty title={t('emptyActiveTitle')} action={add}>
        {t('emptyActiveBody')}
      </Empty>
    );
  return (
    <Empty title={t('emptyTitle')} action={add}>
      {t(may.allowed ? 'emptyBody' : may.unverified ? 'emptyBodyUnverified' : 'emptyBodyReadOnly')}
    </Empty>
  );
}

function ProductImage({ portal, imageId, name }: { portal: PortalApi; imageId: string; name: string }) {
  const { t } = c.useCopy();
  const { resource } = useResource((signal) => portal.productImage(imageId, signal), `portal:catalog:image:${imageId}`);
  if (resource.status !== 'ready') return null;
  return (
    <figure className="lt-media">
      <img src={`data:${resource.data.contentType};base64,${resource.data.dataBase64}`} alt={t('imageAlt', { name })} width={160} />
    </figure>
  );
}

function ProductDetail({ portal, productId }: { portal: PortalApi; productId: string }) {
  const { t } = c.useCopy();
  const { resource, reload } = useResource((signal) => portal.product(productId, signal), `portal:catalog:product:${productId}`);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <Gate resource={resource} retry={reload} rows={4}>
      {(product) => (
        <div className="lt-stack">
          <header className="lt-stack">
            <a className="lt-link" href={inMode('/pay/products', product.mode)}>
              {t('back')}
            </a>
            <h2>
              {product.name} {t(`status_${product.status}`)}
            </h2>
          </header>
          {product.status === 'archived' && <p className="lt-stale">{t('archivedNotice')}</p>}
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
            <p
              className={note.ok ? DONE_LOOK : REFUSED_LOOK}
              data-refusal={note.ok ? undefined : 'refused'}
              role={note.ok ? 'status' : 'alert'}
            >
              {note.text}
            </p>
          )}
          <Facts
            items={[
              [t('factName'), product.name],
              [t('factType'), t(`type_${product.type}`)],
              [
                t('factId'),
                <code key="id" className="lt-mono">
                  {product.productKey}
                </code>,
              ],
              [t('factCatalogue'), t(`mode_${product.mode}`)],
              ...(product.copiedFrom
                ? ([
                    [
                      t('factCopiedFrom'),
                      <a key="from" className="lt-link" href={productHref(product.copiedFrom)}>
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
            <p className="lt-muted">{t('noImage')}</p>
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
    <div className="lt-actions">
      <Button
        tone="secondary"
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
        <div className="lt-actions" role="group" aria-label={t('deleteProduct')}>
          <span>{t('deleteConfirm')}</span>
          <Button
            tone="primary"
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
          <Button tone="secondary" disabled={busy} onClick={() => setConfirming(false)}>
            {t('deleteKeep')}
          </Button>
        </div>
      ) : (
        <Button tone="secondary" disabled={busy} onClick={() => setConfirming(true)}>
          {t('deleteProduct')}
        </Button>
      )}
    </div>
  );
}
