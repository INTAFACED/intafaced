import postgres from 'postgres';
import { MetricsProjector } from './projector.js';

/**
 * Rebuild the metrics projection from source, then reconcile it.
 *
 *   DATABASE_URL=... pnpm --filter @intafaced/svc-pay exec tsx src/metrics/rebuild-cli.ts [--clear] [--merchant <uuid>] [--check]
 *
 * `--clear` empties the projection first (readers see an empty projection with a
 * lag until it is rebuilt). `--check` skips the rebuild and only reconciles.
 * Exit code 1 if any difference remains: zero tolerance.
 */
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const merchantId = args.includes('--merchant') ? args[args.indexOf('--merchant') + 1] : undefined;
const url = process.env.DATABASE_URL ?? 'postgres://svc_pay:svc_pay@localhost:5433/intafaced';
const sql = postgres(url, { max: 2, onnotice: () => undefined });
try {
  const projector = new MetricsProjector(sql);
  if (!flag('--check')) {
    const r = await projector.rebuild({ clear: flag('--clear'), ...(merchantId ? { merchantId } : {}) });
    console.log(`rebuilt: marked ${r.marked} merchant-days, processed ${r.processed}, remaining ${r.remaining}, failed ${r.failed.length}`);
    for (const f of r.failed) console.error(`  failed ${f.key.merchantId} ${f.key.day}: ${f.error}`);
  }
  const report = await projector.reconcile(merchantId ? { merchantId } : {});
  console.log(`reconcile: checked ${report.checkedKeys}, pending ${report.pendingKeys}, diffs ${report.diffs.length}`);
  for (const d of report.diffs.slice(0, 50)) console.error(`  ${d.kind} ${d.table} ${d.merchantId} ${d.day} ${d.subKey}`);
  process.exitCode = report.diffs.length === 0 ? 0 : 1;
} finally {
  await sql.end({ timeout: 5 });
}
