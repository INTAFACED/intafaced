import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { PRODUCT_IMPORT_MAX_PROBLEMS, type ProductImport, type ProductImportProblem } from '@intafaced/contracts';
import { MerchantOpsError } from '../merchant-ops/errors.js';
import { iso } from '../merchant-ops/money.js';
import type { MerchantCaller } from '../merchant-ops/roles.js';
import { checkImportFile, sortProblems, type CheckedFile } from './import-file.js';
import { assertWriter, FIELDS, generatedKey, isUnique, lockCatalog, requestHash, view, type ProductRow } from './products.js';

/**
 * Importing a file of products (J-merchant-03 step 5, M-catalogue-01, M-adv-payments-core-21).
 *
 * A dry run checks every line, including whether a chosen product id is already taken, and writes nothing. A commit
 * makes the same checks inside one transaction and writes every product and the import's record together, or nothing:
 * one bad line refuses the whole file (`pay.product_import_invalid`). The file's SHA-256 is its key, so the same file again,
 * byte for byte, answers with the products it made, as a dry run or a commit, and never makes them twice. Each product
 * gets a create key made from the business, the file and its line, so a product the file made is also known by it if it
 * is deleted later. Imports and copies into one catalogue of one business take turns (`lockCatalog`), so two files that
 * choose the same id are answered one after the other: the second sees the id taken. A file goes into the live
 * catalogue unless it names the test one. Nothing here moves money.
 */

interface ImportRow {
  row_count: number;
  product_ids: string[];
  imported_at: Date;
}

type Db = Sql | TransactionSql;
type Mode = 'live' | 'test';

/** A uuid-shaped key from a hash: the create key of the product on one line of one imported file. */
export const keyId = (key: string) => {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const lineRequestId = (merchantId: string, mode: Mode, fileSha256: string, line: number) =>
  keyId(`catalog-import:${merchantId}:${mode}:${fileSha256}:${line}`);

export class ProductImports {
  constructor(private readonly sql: Sql) {}

  async run(caller: MerchantCaller, input: { csv: string; commit: boolean; mode?: Mode | undefined }): Promise<ProductImport> {
    assertWriter(caller);
    const mode = input.mode ?? 'live';
    const fileSha256 = createHash('sha256').update(input.csv, 'utf8').digest('hex');
    if (!input.commit) {
      const earlier = await this.earlier(this.sql, caller, mode, fileSha256);
      if (earlier) return earlier;
      const file = checkImportFile(input.csv);
      const problems = await this.withTaken(this.sql, caller, mode, file);
      return {
        fileSha256,
        rows: file.rows,
        problems: problems.slice(0, PRODUCT_IMPORT_MAX_PROBLEMS),
        problemCount: problems.length,
        imported: false,
        replayed: false,
        importedAt: null,
        products: [],
      };
    }
    try {
      return await this.sql.begin(async (tx) => {
        await lockCatalog(tx, caller.merchantId, mode);
        const earlier = await this.earlier(tx, caller, mode, fileSha256);
        if (earlier) return earlier;
        const file = checkImportFile(input.csv);
        if ((await this.withTaken(tx, caller, mode, file)).length) throw new MerchantOpsError('pay.product_import_invalid', 'bad_request');
        const values = file.products.map(({ line, input: product }) => {
          const requestId = lineRequestId(caller.merchantId, mode, fileSha256, line);
          return {
            merchant_id: caller.merchantId,
            mode,
            product_key: product.productKey ?? generatedKey(),
            request_id: requestId,
            request_hash: requestHash({ ...product, mode, requestId }),
            name: product.name,
            type: product.type,
            unit_label: product.unitLabel ?? null,
            statement_descriptor: product.statementDescriptor ?? null,
            event_starts_at: product.event ? new Date(product.event.startsAt) : null,
            event_location: product.event?.location ?? null,
            created_by: caller.userId,
          };
        });
        const made = await tx<ProductRow[]>`INSERT INTO pay.catalog_products ${tx(values)} RETURNING ${FIELDS(tx)}`;
        const byKey = new Map(made.map((row) => [row.product_key, row]));
        const rows = values.map((v) => byKey.get(v.product_key)!);
        const [record] = await tx<Array<{ imported_at: Date }>>`
          INSERT INTO pay.catalog_product_imports (merchant_id, mode, file_sha256, row_count, product_ids, imported_by)
          VALUES (${caller.merchantId}, ${mode}, ${fileSha256}, ${file.rows}, ${tx.array(rows.map((r) => r.id))}::uuid[], ${caller.userId})
          RETURNING imported_at`;
        return {
          fileSha256,
          rows: file.rows,
          problems: [],
          problemCount: 0,
          imported: true,
          replayed: false,
          importedAt: iso(record!.imported_at),
          products: rows.map(view),
        };
      });
    } catch (err) {
      // A product made outside an import took a chosen id after the check: nothing was written.
      if (isUnique(err, 'catalog_products_key_once')) throw new MerchantOpsError('pay.product_import_invalid', 'bad_request');
      // The file's products were made by an import whose record is gone (only a reverted migration forgets one): they
      // are not made twice.
      if (isUnique(err, 'catalog_products_request_once')) throw new MerchantOpsError('pay.request_id_reused', 'conflict');
      throw err;
    }
  }

  /** The import this file already made, with the products it made that still exist, in file order. */
  private async earlier(db: Db, caller: MerchantCaller, mode: Mode, fileSha256: string): Promise<ProductImport | null> {
    const [record] = await db<ImportRow[]>`
      SELECT row_count, product_ids::text[] AS product_ids, imported_at FROM pay.catalog_product_imports
       WHERE merchant_id = ${caller.merchantId} AND mode = ${mode} AND file_sha256 = ${fileSha256}`;
    if (!record) return null;
    const ids = db.array(record.product_ids);
    const rows = await db<ProductRow[]>`
      SELECT ${FIELDS(db)} FROM pay.catalog_products
       WHERE merchant_id = ${caller.merchantId} AND id = ANY(${ids}::uuid[])
       ORDER BY array_position(${ids}::uuid[], id)`;
    return {
      fileSha256,
      rows: record.row_count,
      problems: [],
      problemCount: 0,
      imported: true,
      replayed: true,
      importedAt: iso(record.imported_at),
      products: rows.map(view),
    };
  }

  /** The file's own problems and, for its good lines, every chosen id this business already uses. */
  private async withTaken(db: Db, caller: MerchantCaller, mode: Mode, file: CheckedFile): Promise<ProductImportProblem[]> {
    const chosen = file.products.flatMap(({ line, input }) => (input.productKey ? [{ line, key: input.productKey }] : []));
    if (!chosen.length) return file.problems;
    const taken = await db<Array<{ product_key: string }>>`
      SELECT product_key FROM pay.catalog_products
       WHERE merchant_id = ${caller.merchantId} AND mode = ${mode} AND product_key = ANY(${db.array(chosen.map((c) => c.key))}::text[])`;
    const used = new Set(taken.map((t) => t.product_key));
    const extra = chosen
      .filter((c) => used.has(c.key))
      .map((c): ProductImportProblem => ({ line: c.line, column: 'product_id', problem: 'id_taken' }));
    return extra.length ? sortProblems([...file.problems, ...extra]) : file.problems;
  }
}
