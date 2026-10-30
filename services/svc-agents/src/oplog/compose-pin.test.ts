import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The operator log's three owner values reach the svc-agents container only through compose pass-through, and each
// is passed in the key-only form: unset stays unset (and refuses), never an empty string or an invented default.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const OWNER_VALUES = ['AGENTS_LOG_READ_REASONS', 'AGENTS_OPS_ACTIONS_LIMIT', 'AGENTS_TRANSCRIPT_RETENTION_DAYS'];

function agentsServiceBlock(source: string): string {
  const match = source.match(/^ {2}svc-agents:\n(?:.*\n)*?(?=^ {2}[a-z]|\Z)/m);
  if (!match) throw new Error('svc-agents service block missing from docker-compose.apps.yml');
  return match[0];
}

describe('compose passes the operator log owner values to svc-agents', () => {
  const block = agentsServiceBlock(readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8'));
  const envTs = readFileSync(join(ROOT, 'services/svc-agents/src/env.ts'), 'utf8');
  const example = readFileSync(join(ROOT, '.env.example'), 'utf8');

  it.each(OWNER_VALUES)('%s: declared optional in env.ts, passed key-only once, and blank in .env.example', (name) => {
    expect(envTs).toMatch(new RegExp(`${name}: blankAsAbsent\\(`));
    expect(block.match(new RegExp(`^\\s+${name}:.*$`, 'gm'))).toEqual([expect.stringMatching(new RegExp(`^\\s+${name}:$`))]);
    expect(example.match(new RegExp(`^#? ?${name}=.*$`, 'gm'))).toEqual([`# ${name}=`]);
  });
});
