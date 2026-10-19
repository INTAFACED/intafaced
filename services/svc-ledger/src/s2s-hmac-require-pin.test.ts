import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * PRODUCTION S2S MOUNT REQUIRES BODY-BOUND HMAC.
 *
 * Isolated `registerS2sHttp` tests may still pass `accept-both`. That does not
 * prove the process that boots in the container refuses unbound HMAC on
 * POST /trpc/post. Passing `env.INTERNAL_SERVICE_BODY_BIND` follows the
 * compose default accept-both, so a signed-but-unbound caller still posts.
 *
 * This file reads THE REAL `index.ts` and fails if the production call is
 * missing, commented out, or still bound to the env flag.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = join(HERE, 'index.ts');

function indexSource(): string {
  return readFileSync(INDEX, 'utf8');
}

/** Executable lines — not `//` or block-comment `*` prefixes. */
function liveLines(src: string): { line: string; index: number }[] {
  let offset = 0;
  const out: { line: string; index: number }[] = [];
  for (const line of src.split(/\r?\n/)) {
    const t = line.trimStart();
    if (!(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))) {
      out.push({ line, index: offset });
    }
    offset += line.length + 1;
  }
  return out;
}

describe('the deployed svc-ledger S2S mount requires body-bound HMAC', () => {
  it('calls registerS2sHttp with bodyBind: require on a live line before listen', () => {
    const live = liveLines(indexSource());
    const joined = live.map((l) => l.line).join('\n');
    expect(joined).toMatch(/registerS2sHttp\(\s*app\s*,\s*ledger\s*,\s*env\.INTERNAL_SERVICE_SECRET\s*,\s*\{\s*bodyBind:\s*'require'\s*,/);

    const call = live.find((l) => /registerS2sHttp\s*\(/.test(l.line));
    const listen = live.find((l) => /app\.listen\s*\(/.test(l.line));
    expect(call, 'index.ts must call registerS2sHttp on a live line').toBeDefined();
    expect(listen).toBeDefined();
    expect(call!.index).toBeLessThan(listen!.index);
  });

  it('does not pass env.INTERNAL_SERVICE_BODY_BIND into registerS2sHttp', () => {
    const live = liveLines(indexSource())
      .map((l) => l.line)
      .join('\n');
    expect(live).not.toMatch(/registerS2sHttp\([^;]*INTERNAL_SERVICE_BODY_BIND/);
  });
});
