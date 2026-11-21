// Writes procedures.schema.json from the built records: `pnpm --filter @intafaced/contracts procedures:write`.
import { writeFileSync } from 'node:fs';
import { CONTRACT_PROCEDURES } from '../dist/procedure-registry.js';
import { procedureSchemaFile } from '../dist/procedure.js';

writeFileSync(new URL('../procedures.schema.json', import.meta.url), procedureSchemaFile(CONTRACT_PROCEDURES));
