/**
 * The watch threshold is an owner value. Compose must pass it through empty.
 * A baked number would mark videos watched without the owner publishing one.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function academyServiceBlock(source: string): string {
  const match = source.match(/^  svc-academy:\n(?:.*\n)*?(?=^  [a-z]|\Z)/m);
  if (!match) throw new Error('svc-academy service block missing from docker-compose.apps.yml');
  return match[0];
}

const LINE = /^\s+ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS:\s*\$\{ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS:-\}\s*$/gm;

describe('compose ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS for svc-academy', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const envTs = readFileSync(join(ROOT, 'services/svc-academy/src/env.ts'), 'utf8');
  const block = academyServiceBlock(compose);

  it('passes the host value through empty and does not bake a duration', () => {
    expect(block.match(LINE)).toHaveLength(1);
    expect(block).not.toMatch(/ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS:\s*\$\{ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS:-\d+/);
    expect(envTs).not.toMatch(/ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS:[\s\S]{0,400}\.default\(\d+\)/);
    const hits = compose.match(/^\s+ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS:/gm) ?? [];
    expect(hits).toHaveLength(1);
  });
});
