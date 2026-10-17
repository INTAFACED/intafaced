import postgres from 'postgres';
import { createPostgresStrategyRepository } from './postgres-repository.js';

const url = process.env.QUANT_REOPEN_URL;
const schema = process.env.QUANT_REOPEN_SCHEMA;
const accountId = process.env.QUANT_REOPEN_ACCOUNT;
const id = process.env.QUANT_REOPEN_ID;
if (!url || !schema || !accountId || !id) {
  console.error('quant.database_url_unset — reopen probe is missing QUANT_REOPEN_URL');
  process.exit(2);
}

const sql = postgres(url, { max: 1, onnotice: () => undefined });
try {
  const versions = await createPostgresStrategyRepository(sql, schema).versions({ accountId, id });
  console.log(JSON.stringify({ versions: versions?.map((row) => ({ version: row.version, name: row.name })) ?? null }));
} finally {
  await sql.end({ timeout: 5 });
}
