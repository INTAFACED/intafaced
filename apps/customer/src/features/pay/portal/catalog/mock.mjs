// TEST DATA ONLY. Nothing here is a real product, image or id. The image size below stands in for what INTAFACED
// publishes; it is not a published value.
import { NOT_MINE, USER_ID, hex, iso, ok, page, refuse } from '../mock/shared.mjs';

export const TEST_IMAGE_RULES = { maxBytes: 500_000, types: ['image/png', 'image/jpeg', 'image/webp'] };

/** The product catalogue's stand-in (`merchantCatalog.*`), answering like svc-pay. A new business has no products. */
export function createCatalogMock(ctx) {
  const { state, now } = ctx;
  if (state.products === undefined)
    state.products =
      ctx.scenario === 'active' || ctx.scenario === 'halted'
        ? [
            {
              id: hex('c1', 1),
              productKey: 'test-classic-tee',
              mode: 'live',
              name: 'TEST Classic tee',
              type: 'physical',
              unitLabel: 'shirt',
              statementDescriptor: 'TEST TEE SHOP',
              event: null,
              imageId: null,
              copiedFrom: null,
              status: 'active',
              version: 1,
              createdAt: iso(now - 86_400_000),
              createdBy: USER_ID,
              updatedAt: iso(now - 86_400_000),
            },
          ]
        : [];
  state.productImages ??= [];
  state.prices ??= [];
  state.stores ??= [];
  /** `productId|storeId|channel` for each place a product is not sold. */
  state.notSold ??= new Set();
  const availability = (productId) => ({
    productId,
    stores: state.stores.map((store) => ({
      storeId: store.id,
      name: store.name,
      status: store.status,
      channels: Object.fromEntries(
        ['online', 'in_person', 'invoice'].map((channel) => [channel, !state.notSold.has(`${productId}|${store.id}|${channel}`)]),
      ),
    })),
  });
  return {
    /** Returns NOT_MINE for a procedure this part does not own. */
    async handle(procedure, input, route) {
      switch (procedure) {
        case 'merchantCatalog.products.list':
          return ok(
            route,
            page(
              state.products
                .filter((p) => p.mode === (input.mode ?? 'live'))
                .filter((p) => !input.status || p.status === input.status)
                .map(strip),
              input,
            ),
          );
        case 'merchantCatalog.products.get': {
          const found = state.products.find((p) => p.id === input.productId);
          return found ? ok(route, strip(found)) : refuse(route, 404, 'pay.product_not_found');
        }
        case 'merchantCatalog.products.create': {
          const replay = state.products.find((p) => p.requestId === input.requestId);
          if (replay) return ok(route, { product: strip(replay), replayed: true });
          const key = input.productKey ?? `prod_test${String(state.products.length + 1).padStart(12, 'a')}`;
          const mode = input.mode ?? 'live';
          if (state.products.some((p) => p.mode === mode && p.productKey === key)) return refuse(route, 409, 'pay.product_id_taken');
          const at = iso(Date.now());
          const product = {
            id: hex('c1', state.products.length + 2),
            productKey: key,
            mode,
            name: input.name,
            type: input.type,
            unitLabel: input.unitLabel ?? null,
            statementDescriptor: input.statementDescriptor ?? null,
            event: input.event ? { startsAt: new Date(input.event.startsAt).toISOString(), location: input.event.location } : null,
            imageId: input.imageId ?? null,
            copiedFrom: null,
            status: 'active',
            version: 1,
            createdAt: at,
            createdBy: USER_ID,
            updatedAt: at,
          };
          state.products.unshift({ ...product, requestId: input.requestId });
          return ok(route, { product, replayed: false });
        }
        case 'merchantCatalog.images.rules':
          return ok(route, TEST_IMAGE_RULES);
        case 'merchantCatalog.images.upload': {
          const bytes = Buffer.from(input.dataBase64, 'base64');
          if (bytes.length > TEST_IMAGE_RULES.maxBytes) return refuse(route, 400, 'pay.product_image_too_large');
          if (!TEST_IMAGE_RULES.types.includes(input.contentType)) return refuse(route, 400, 'pay.product_image_type_refused');
          const image = {
            imageId: hex('c2', state.productImages.length + 1),
            contentType: input.contentType,
            byteSize: bytes.length,
            sha256: 'a'.repeat(64),
          };
          state.productImages.push({ ...image, dataBase64: input.dataBase64 });
          return ok(route, image);
        }
        case 'merchantCatalog.images.get': {
          const found = state.productImages.find((i) => i.imageId === input.imageId);
          return found ? ok(route, found) : refuse(route, 404, 'pay.product_image_not_found');
        }
        case 'merchantCatalog.prices.list': {
          if (!state.products.some((p) => p.id === input.productId)) return refuse(route, 404, 'pay.product_not_found');
          return ok(route, page(state.prices.filter((p) => p.productId === input.productId).map(strip), input));
        }
        case 'merchantCatalog.prices.create': {
          const replay = state.prices.find((p) => p.requestId === input.requestId);
          if (replay) return ok(route, { price: strip(replay), replayed: true });
          if (!state.products.some((p) => p.id === input.productId)) return refuse(route, 404, 'pay.product_not_found');
          const chosen = input.kind === 'customer_chosen';
          if (chosen && input.billing !== 'one_time') return refuse(route, 400, 'pay.price_customer_chosen_one_time');
          if (chosen ? !input.minAmount || !input.maxAmount : !input.amount)
            return refuse(route, 400, chosen ? 'pay.price_bounds_required' : 'pay.price_amount_required');
          const price = {
            id: hex('c3', state.prices.length + 1),
            productId: input.productId,
            billing: input.billing,
            kind: input.kind,
            assetId: input.assetId,
            amount: chosen ? null : input.amount,
            minAmount: chosen ? input.minAmount : null,
            maxAmount: chosen ? input.maxAmount : null,
            isDefault: !state.prices.some((p) => p.productId === input.productId && p.isDefault),
            status: 'active',
            replacesId: null,
            createdAt: iso(Date.now()),
            createdBy: USER_ID,
          };
          state.prices.push({ ...price, requestId: input.requestId });
          return ok(route, { price, replayed: false });
        }
        case 'merchantCatalog.prices.replace': {
          const replay = state.prices.find((p) => p.requestId === input.requestId);
          if (replay) {
            const old = state.prices.find((p) => p.id === replay.replacesId);
            return ok(route, { price: strip(replay), replaced: strip(old), replayed: true });
          }
          const product = state.products.find((p) => p.id === input.productId);
          if (!product) return refuse(route, 404, 'pay.product_not_found');
          if (product.status !== 'active') return refuse(route, 412, 'pay.product_archived');
          const old = state.prices.find((p) => p.id === input.priceId && p.productId === input.productId);
          if (!old) return refuse(route, 404, 'pay.price_not_found');
          if (old.status !== 'active') return refuse(route, 412, 'pay.price_archived');
          const chosen = input.kind === 'customer_chosen';
          const price = {
            id: hex('c3', state.prices.length + 1),
            productId: input.productId,
            billing: input.billing,
            kind: input.kind,
            assetId: input.assetId,
            amount: chosen ? null : input.amount,
            minAmount: chosen ? input.minAmount : null,
            maxAmount: chosen ? input.maxAmount : null,
            isDefault: old.isDefault,
            status: 'active',
            replacesId: old.id,
            createdAt: iso(Date.now()),
            createdBy: USER_ID,
          };
          Object.assign(old, { status: 'archived', isDefault: false });
          state.prices.push({ ...price, requestId: input.requestId });
          return ok(route, { price, replaced: strip(old), replayed: false });
        }
        case 'merchantCatalog.prices.get': {
          const found = state.prices.find((p) => p.id === input.priceId);
          const product = found && state.products.find((p) => p.id === found.productId);
          if (!found || !product) return refuse(route, 404, 'pay.price_not_found');
          return ok(route, pricedProduct(found, product));
        }
        case 'merchantCatalog.prices.usage': {
          if (!state.prices.some((p) => p.id === input.priceId)) return refuse(route, 404, 'pay.price_not_found');
          const open = (state.subscriptions ?? []).filter(
            (s) => s.priceId === input.priceId && (s.status === 'active' || s.status === 'paused'),
          ).length;
          return ok(route, { priceId: input.priceId, openSubscriptions: open });
        }
        case 'merchantCatalog.prices.choices': {
          const rows = state.prices
            .filter((p) => p.status === 'active')
            .filter((p) => !input.billing || p.billing === input.billing)
            .filter((p) => !input.kind || p.kind === input.kind)
            .filter((p) => !input.assetId || p.assetId === input.assetId)
            .filter((p) => input.amount === undefined || (p.amount !== null && scaled(p.amount) === scaled(input.amount)))
            .map((p) => [p, state.products.find((x) => x.id === p.productId)])
            .filter(([, product]) => product && product.status === 'active')
            .reverse()
            .map(([p, product]) => pricedProduct(p, product));
          return ok(route, page(rows, input));
        }
        case 'merchantCatalog.products.archive':
        case 'merchantCatalog.products.unarchive': {
          const found = state.products.find((p) => p.id === input.productId);
          if (!found) return refuse(route, 404, 'pay.product_not_found');
          const status = procedure.endsWith('.archive') ? 'archived' : 'active';
          if (found.status !== status) Object.assign(found, { status, version: found.version + 1, updatedAt: iso(Date.now()) });
          return ok(route, strip(found));
        }
        case 'merchantCatalog.products.import': {
          // A plain stand-in: one product a line, no quoted cells. svc-pay reads full CSV and checks every column.
          state.productImports ??= [];
          const mode = input.mode ?? 'live';
          const earlier = state.productImports.find((i) => i.csv === input.csv && i.mode === mode);
          if (earlier)
            return ok(route, {
              ...earlier.answer,
              replayed: true,
              products: earlier.answer.products.filter((p) => state.products.some((x) => x.id === p.id)),
            });
          const [header = '', ...lines] = input.csv.split(/\r?\n/);
          const columns = header.split(',').map((c) => c.trim().toLowerCase());
          const rows = lines.map((text, i) => ({ line: i + 2, cells: text.split(',') })).filter((r) => r.cells.some((c) => c.trim()));
          if (!rows.length) return refuse(route, 400, 'pay.product_import_empty');
          const cell = (row, column) => row.cells[columns.indexOf(column)]?.trim() ?? '';
          const problems = [];
          for (const row of rows) {
            if (!cell(row, 'name')) problems.push({ line: row.line, column: 'name', problem: 'value_required' });
            if (!['physical', 'digital', 'service', 'event'].includes(cell(row, 'type').toLowerCase()))
              problems.push({ line: row.line, column: 'type', problem: 'value_invalid' });
            if (cell(row, 'product_id') && state.products.some((p) => p.mode === mode && p.productKey === cell(row, 'product_id')))
              problems.push({ line: row.line, column: 'product_id', problem: 'id_taken' });
          }
          const base = { fileSha256: 'a'.repeat(64), rows: rows.length, problems, problemCount: problems.length };
          if (!input.commit || problems.length) {
            if (input.commit) return refuse(route, 400, 'pay.product_import_invalid');
            return ok(route, { ...base, imported: false, replayed: false, importedAt: null, products: [] });
          }
          const at = iso(Date.now());
          const first = state.products.length;
          const made = rows
            .map((row, i) => ({
              id: hex('c1', first + i + 2),
              productKey: cell(row, 'product_id') || `prod_test${String(first + i + 1).padStart(12, 'a')}`,
              mode,
              name: cell(row, 'name'),
              type: cell(row, 'type').toLowerCase(),
              unitLabel: cell(row, 'unit_label') || null,
              statementDescriptor: cell(row, 'statement_descriptor') || null,
              event: null,
              imageId: null,
              copiedFrom: null,
              status: 'active',
              version: 1,
              createdAt: at,
              createdBy: USER_ID,
              updatedAt: at,
            }))
            .map((product) => (state.products.unshift({ ...product, requestId: product.id }), product));
          const answer = { ...base, imported: true, replayed: false, importedAt: at, products: made };
          state.productImports.push({ csv: input.csv, mode, answer });
          return ok(route, answer);
        }
        case 'merchantCatalog.copy': {
          if (input.from === input.to) return refuse(route, 400, 'pay.catalog_copy_same_mode');
          const report = { from: input.from, to: input.to, created: [], skipped: [] };
          const target = state.products.filter((p) => p.mode === input.to);
          for (const source of state.products.filter((p) => p.mode === input.from).reverse()) {
            const skip = (reason, productId) =>
              report.skipped.push({ sourceId: source.id, productKey: source.productKey, name: source.name, reason, productId });
            const copy = target.find((p) => p.copiedFrom === source.id || p.id === source.copiedFrom);
            const holder = target.find((p) => p.productKey === source.productKey);
            if (copy) skip('copied_before', copy.id);
            else if (source.status !== 'active') skip('archived', null);
            else if (holder) skip('id_taken', holder.id);
            else {
              const at = iso(Date.now());
              const made = {
                ...source,
                id: hex('c1', state.products.length + 2),
                mode: input.to,
                copiedFrom: source.id,
                version: 1,
                createdAt: at,
                updatedAt: at,
              };
              state.products.unshift({ ...made, requestId: made.id });
              const prices = state.prices.filter((p) => p.productId === source.id && p.status === 'active');
              for (const price of prices)
                state.prices.push({
                  ...price,
                  id: hex('c3', state.prices.length + 1),
                  productId: made.id,
                  replacesId: null,
                  requestId: hex('c4', state.prices.length + 1),
                });
              report.created.push({
                sourceId: source.id,
                productId: made.id,
                productKey: made.productKey,
                name: made.name,
                prices: prices.length,
              });
            }
          }
          return ok(route, report);
        }
        case 'merchantCatalog.products.delete': {
          const at = state.products.findIndex((p) => p.id === input.productId);
          if (at < 0) return refuse(route, 404, 'pay.product_not_found');
          if (state.prices.some((p) => p.productId === input.productId)) return refuse(route, 412, 'pay.product_has_prices');
          state.products.splice(at, 1);
          return ok(route, { productId: input.productId, deleted: true });
        }
        case 'merchantCatalog.prices.setDefault': {
          const found = state.prices.find((p) => p.id === input.priceId && p.productId === input.productId);
          if (!found) return refuse(route, 404, 'pay.price_not_found');
          for (const p of state.prices) if (p.productId === input.productId) p.isDefault = p.id === found.id;
          return ok(route, strip(found));
        }
        case 'merchantStores.list':
          return ok(route, page(state.stores.filter((s) => !input.status || s.status === input.status).map(strip), input));
        case 'merchantStores.create': {
          const replay = state.stores.find((s) => s.requestId === input.requestId);
          if (replay) return ok(route, { store: strip(replay), replayed: true });
          if (state.stores.some((s) => s.name.toLowerCase() === input.name.toLowerCase()))
            return refuse(route, 409, 'pay.store_name_taken');
          const at = iso(Date.now());
          const store = {
            id: hex('c5', state.stores.length + 1),
            requestId: input.requestId,
            name: input.name,
            address: input.address ?? null,
            timezone: input.timezone,
            status: 'active',
            version: 1,
            createdAt: at,
            updatedAt: at,
          };
          state.stores.push(store);
          return ok(route, { store: strip(store), replayed: false });
        }
        case 'merchantStores.archive':
        case 'merchantStores.reopen': {
          const found = state.stores.find((s) => s.id === input.storeId);
          if (!found) return refuse(route, 404, 'pay.store_not_found');
          const status = procedure.endsWith('archive') ? 'archived' : 'active';
          if (found.status !== status) Object.assign(found, { status, version: found.version + 1, updatedAt: iso(Date.now()) });
          return ok(route, strip(found));
        }
        case 'merchantCatalog.availability.get':
          return state.products.some((p) => p.id === input.productId)
            ? ok(route, availability(input.productId))
            : refuse(route, 404, 'pay.product_not_found');
        case 'merchantCatalog.availability.set': {
          const store = state.stores.find((s) => s.id === input.storeId);
          if (!store) return refuse(route, 404, 'pay.store_not_found');
          if (store.status !== 'active') return refuse(route, 412, 'pay.store_archived');
          if (!state.products.some((p) => p.id === input.productId)) return refuse(route, 404, 'pay.product_not_found');
          const key = `${input.productId}|${input.storeId}|${input.channel}`;
          if (input.sold) state.notSold.delete(key);
          else state.notSold.add(key);
          return ok(route, availability(input.productId));
        }
        case 'merchantCatalog.prices.quote': {
          const found = state.prices.find((p) => p.id === input.priceId);
          if (!found) return refuse(route, 404, 'pay.price_not_found');
          if (input.storeId) {
            const store = state.stores.find((s) => s.id === input.storeId);
            if (!store) return refuse(route, 404, 'pay.store_not_found');
            if (store.status !== 'active') return refuse(route, 412, 'pay.store_archived');
            if (state.notSold.has(`${found.productId}|${input.storeId}|${input.channel}`))
              return refuse(route, 412, 'pay.product_not_sold_here');
          }
          const answer = (amount) => ok(route, { priceId: found.id, assetId: found.assetId, amount, billing: found.billing });
          if (found.kind === 'fixed') return answer(found.amount);
          if (!input.amount) return refuse(route, 400, 'pay.price_amount_required');
          if (scaled(input.amount) < scaled(found.minAmount)) return refuse(route, 400, 'pay.price_amount_below_minimum');
          if (scaled(input.amount) > scaled(found.maxAmount)) return refuse(route, 400, 'pay.price_amount_above_maximum');
          return answer(input.amount);
        }
        default:
          return NOT_MINE;
      }
    },
  };
}

/** A decimal string as 18-place scaled integer, as the ledger keeps it; never a float. */
const scaled = (value) => {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole + fraction.padEnd(18, '0').slice(0, 18));
};

const strip = ({ requestId: _requestId, ...product }) => product;

const pricedProduct = (price, product) => ({
  price: strip(price),
  product: { id: product.id, productKey: product.productKey, name: product.name, status: product.status },
});
