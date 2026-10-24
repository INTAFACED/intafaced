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
              status: 'active',
              version: 1,
              createdAt: iso(now - 86_400_000),
              createdBy: USER_ID,
              updatedAt: iso(now - 86_400_000),
            },
          ]
        : [];
  state.productImages ??= [];
  return {
    /** Returns NOT_MINE for a procedure this part does not own. */
    async handle(procedure, input, route) {
      switch (procedure) {
        case 'merchantCatalog.products.list':
          return ok(route, page(state.products.filter((p) => !input.status || p.status === input.status).map(strip), input));
        case 'merchantCatalog.products.get': {
          const found = state.products.find((p) => p.id === input.productId);
          return found ? ok(route, strip(found)) : refuse(route, 404, 'pay.product_not_found');
        }
        case 'merchantCatalog.products.create': {
          const replay = state.products.find((p) => p.requestId === input.requestId);
          if (replay) return ok(route, { product: strip(replay), replayed: true });
          const key = input.productKey ?? `prod_test${String(state.products.length + 1).padStart(12, 'a')}`;
          if (state.products.some((p) => p.productKey === key)) return refuse(route, 409, 'pay.product_id_taken');
          const at = iso(Date.now());
          const product = {
            id: hex('c1', state.products.length + 2),
            productKey: key,
            mode: 'live',
            name: input.name,
            type: input.type,
            unitLabel: input.unitLabel ?? null,
            statementDescriptor: input.statementDescriptor ?? null,
            event: input.event ? { startsAt: new Date(input.event.startsAt).toISOString(), location: input.event.location } : null,
            imageId: input.imageId ?? null,
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
        default:
          return NOT_MINE;
      }
    },
  };
}

const strip = ({ requestId: _requestId, ...product }) => product;
