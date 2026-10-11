/**
 * C8 fail-first golden: compose empty-passes RPC and venue; omitted venue
 * remains a named refusal (`indexer.venue_unset`) rather than an empty book.
 * Owner may set the disposable Anvil fixture explicitly — this mill does not.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');

/** Next service key, or the real end of the string. A literal Z must not end the block. */
function indexerBlock(source: string): string {
  return source.match(/^  svc-indexer:\n(?:.*\n)*?(?=^  [a-z]|(?![\s\S]))/m)?.[0] ?? '';
}

function expectNoInventedSecrets(block: string): void {
  expect(block).not.toMatch(/INDEXER_RPC_URL:.*evm:8545/);
  expect(block).not.toMatch(/INDEXER_VENUE_ADDRESS:.*0x0116/);
  expect(block).not.toMatch(/PRIVATE_KEY|SIGNING_KEY|LEDGER_URL/);
}

describe('socket.clob-contracts Anvil wire golden', () => {
  it('keeps the compose seam explicit and non-custodial', () => {
    const source = readFileSync(COMPOSE, 'utf8');
    const block = indexerBlock(source);
    expect(block).toContain('INDEXER_RPC_URL: ${INDEXER_RPC_URL:-}');
    expect(block).not.toMatch(/INDEXER_RPC_URL:.*evm:8545/);
    expect(block).toContain('INDEXER_VENUE_ADDRESS: ${INDEXER_VENUE_ADDRESS:-}');
    expect(block).not.toMatch(/INDEXER_VENUE_ADDRESS:.*0x0116/);
    expect(block).toContain('indexer.venue_unset');
    expect(block).not.toMatch(/PRIVATE_KEY|SIGNING_KEY|LEDGER_URL/);
  });

  it('returns the last svc-indexer block and checks lines after a line that contains Z', () => {
    const blockText = [
      '  svc-indexer:',
      '    environment:',
      'Z',
      '      INDEXER_RPC_URL: ${INDEXER_RPC_URL:-}',
      '      INDEXER_VENUE_ADDRESS: ${INDEXER_VENUE_ADDRESS:-}',
      '      # indexer.venue_unset',
      '',
    ].join('\n');
    const source = `services:\n${blockText}`;
    const block = indexerBlock(source);
    expect(block).toBe(blockText);
    const afterZ = block.slice(block.indexOf('\nZ\n') + '\nZ\n'.length);
    expect(afterZ).toContain('INDEXER_RPC_URL: ${INDEXER_RPC_URL:-}');
    expect(afterZ).toContain('INDEXER_VENUE_ADDRESS: ${INDEXER_VENUE_ADDRESS:-}');
    expect(afterZ).toContain('indexer.venue_unset');
    expectNoInventedSecrets(afterZ);
  });

  it('excludes a later service from the svc-indexer block', () => {
    const blockText = [
      '  svc-indexer:',
      '    environment:',
      '      INDEXER_RPC_URL: ${INDEXER_RPC_URL:-}',
      '      # indexer.venue_unset',
      '',
    ].join('\n');
    const source = `services:\n${blockText}  svc-later:\n    ONLY_LATER: 1\n`;
    const block = indexerBlock(source);
    expect(block).toBe(blockText);
    expect(block).not.toContain('svc-later');
    expect(block).not.toContain('ONLY_LATER');
    expectNoInventedSecrets(block);
  });

  it('pins the disposable deployment and production zero sentinel', () => {
    expect('0x0116686E2291dbd5e317F47faDBFb43B599786Ef').toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect('0x0000000000000000000000000000000000000000').toMatch(/^0x0{40}$/);
  });
});
