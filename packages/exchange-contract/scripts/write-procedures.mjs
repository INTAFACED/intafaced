// Writes procedures.schema.json from the built records: `pnpm --filter @intafaced/exchange-contract procedures:write`.
import { writeFileSync } from 'node:fs';
import { procedureSchemaFile } from '@intafaced/contracts/procedure';
import { EXCHANGE_PROCEDURES } from '../dist/procedure-registry.js';

writeFileSync(new URL('../procedures.schema.json', import.meta.url), procedureSchemaFile(EXCHANGE_PROCEDURES));
