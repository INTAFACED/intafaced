import { fileURLToPath } from 'node:url';
import { refusalCoverage } from '@intafaced/contracts/procedure-refusal-coverage';
import { TAX_PROCEDURES } from '@intafaced/contracts/tax-procedures';

// Every refusal svc-tax's records list is produced by a test through the mounted router, or named in the ceiling file.
const coverage = refusalCoverage(TAX_PROCEDURES, fileURLToPath(new URL('./refusals-unproduced.json', import.meta.url)));
export const setup = coverage.setup;
export const teardown = coverage.teardown;
