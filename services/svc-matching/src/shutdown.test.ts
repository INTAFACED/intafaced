import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { MatchingEngine } from './engine/engine.js';
import { FileJournal } from './engine/journal.js';
import { shutdownMatching } from './shutdown.js';

/**
 * A rejected app.close() or bus.close() used to skip journal.close() and
 * process.exit(0). The journal file stayed open and the writer lock stayed
 * held. This card calls the production drain with an injected exit.
 */

async function drainWith(fault: 'app' | 'bus' | 'both'): Promise<void> {
  const path = join(mkdtempSync(join(tmpdir(), 'matching-shutdown-')), 'engine.ndjson');
  const journal = new FileJournal(path);
  const engine = new MatchingEngine({
    journal,
    bus: new MemoryEventBus('svc-matching'),
    snapshotEvery: 0,
  });
  let enabledAtClose: boolean | undefined;
  let closedJournal = false;
  let exitCode: number | undefined;
  const noteEnabled = () => {
    if (enabledAtClose === undefined) enabledAtClose = engine.isEnabled;
  };
  try {
    await shutdownMatching({
      engine,
      app: {
        async close() {
          noteEnabled();
          if (fault === 'app' || fault === 'both') throw new Error('app close rejected');
        },
      },
      bus: {
        async close() {
          noteEnabled();
          if (fault === 'bus' || fault === 'both') throw new Error('bus close rejected');
        },
      },
      journal: {
        close() {
          journal.close();
          closedJournal = true;
        },
      },
      exit(code) {
        if (!closedJournal) throw new Error('exited before the journal closed');
        exitCode = code;
      },
    });
  } finally {
    if (!closedJournal) journal.close();
  }

  expect(enabledAtClose).toBe(false);
  expect(engine.isEnabled).toBe(false);
  expect(closedJournal).toBe(true);
  expect(exitCode).toBe(0);

  const reopened = new FileJournal(path);
  reopened.close();
}

describe('matching signal shutdown', () => {
  it('closes the journal and exits when app.close or bus.close rejects', async () => {
    await drainWith('app');
    await drainWith('bus');
    await drainWith('both');
  });
});
