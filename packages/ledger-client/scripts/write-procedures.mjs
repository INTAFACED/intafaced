// Writes procedures.schema.json from the built records: `pnpm --filter @intafaced/ledger-client procedures:write`.
import { writeFileSync } from 'node:fs';
import { procedureSchemaFile } from '@intafaced/contracts/procedure';
import { LEDGER_PROCEDURES } from '../dist/procedure-registry.js';

writeFileSync(new URL('../procedures.schema.json', import.meta.url), procedureSchemaFile(LEDGER_PROCEDURES));
