/**
 * Compose must pass warehouse replica env into the admin container.
 *
 * The warehouse route already reads these via resolveWarehouseReplicaConfig.
 * Without pass-through, a host cannot pin a read-replica from `.env` and the
 * console always sees an unconfigured warehouse.
 *
 * Unset omits the key (compose key-no-value). Do not default CONFIGURED to
 * true. Do not invent postgres URLs or lag numbers.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const COMPOSE = resolve(import.meta.dirname, '../../../../docker-compose.apps.yml');

const REPLICA_KEYS = [
  'ANALYTICS_REPLICA_LEDGER_URL',
  'ANALYTICS_REPLICA_TRADE_URL',
  'ANALYTICS_REPLICA_IDENTITY_URL',
  'ANALYTICS_REPLICA_CONFIGURED',
  'ANALYTICS_REPLICA_LAG_SECONDS',
] as const;

function adminServiceBlock(source: string): string {
  return composeServiceBlock(source, 'admin');
}

function assignmentLines(block: string, key: string): string[] {
  return block.split('\n').filter((line) => new RegExp(`^\\s+${key}:`).test(line));
}

describe('compose warehouse replica env for admin', () => {
  it('passes each replica key once as key-no-value with no invented defaults', () => {
    const block = adminServiceBlock(readFileSync(COMPOSE, 'utf8'));

    for (const key of REPLICA_KEYS) {
      const lines = assignmentLines(block, key);
      expect(lines, `${key} must appear once in the admin block`).toHaveLength(1);
      expect(lines[0]).toMatch(new RegExp(`^\\s+${key}:\\s*$`));
      expect(lines[0]).not.toMatch(/\$\{/);
      expect(lines[0]).not.toMatch(/postgres:/i);
    }

    expect(block).not.toMatch(/ANALYTICS_REPLICA_CONFIGURED:\s*\$\{[^}]*true/);
  });
});
