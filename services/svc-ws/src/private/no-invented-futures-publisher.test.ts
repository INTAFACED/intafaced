import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { PrivateOrderHub } from './hub.js';
import { subscribePrivatePositions } from './source.js';

/**
 * Positions fan-out consumes trade.futures `positionUpdated`. svc-ws must not
 * invent that publisher. Absent publisher stays honest: no fabricated frame.
 */

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function productionSources(dir = SRC_ROOT): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...productionSources(path));
      continue;
    }
    if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

describe('positions channel has no invented futures publisher', () => {
  it('production src subscribes to positionUpdated and never publishes it', () => {
    const files = productionSources();
    const texts = files.map((path) => ({ path, text: readFileSync(path, 'utf8') }));
    const publishes = texts.filter(({ text }) => /\.publish\(\s*['"]positionUpdated['"]/.test(text));
    expect(publishes, 'svc-ws must not invent a futures positionUpdated publisher').toEqual([]);

    const source = texts.find(({ path }) => path.replace(/\\/g, '/').endsWith('private/source.ts'));
    expect(source, 'private/source.ts must exist').toBeDefined();
    expect(source!.text).toMatch(/\.subscribe\(\s*[\s\S]*?['"]positionUpdated['"]/);
    expect(source!.text).not.toMatch(/\.publish\(\s*['"]positionUpdated['"]/);
  });

  it('absent publisher stays silent — subscribe does not invent a position frame', async () => {
    const bus = new MemoryEventBus('svc-ws-no-fake-publisher');
    const hub = new PrivateOrderHub({ highWaterBytes: 1_000_000, maxLagTicks: 5, maxConnections: 10, maxConnectionsPerUser: 10 });
    const sent: string[] = [];
    hub.attach(USER, {
      get bufferedBytes() {
        return 0;
      },
      send(frame: string) {
        sent.push(frame);
      },
      close() {
        /* unused */
      },
    });

    await subscribePrivatePositions({ bus, hub, durable: 'ws-no-fake-positions' });
    await new Promise((r) => setTimeout(r, 20));

    expect(sent).toEqual([]);
  });
});
