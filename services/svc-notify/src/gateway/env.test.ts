import { describe, expect, it } from 'vitest';
import { readRelayEnvironment } from './env.js';

const configured = {
  NOTIFY_RELAY_DATABASE_URL: 'postgres://fixture@127.0.0.1:55447/independent_receipts_test',
  NOTIFY_RELAY_TOKEN: 'synthetic-relay-credential-at-least-32-characters',
  NOTIFY_RELAY_SEND_URL: 'https://mailbox.fixture/send',
  NOTIFY_RELAY_SEND_TOKEN: 'synthetic-separate-mailbox-credential',
  NOTIFY_RELAY_TIMEOUT_MS: '1000',
  NOTIFY_RELAY_PORT: '8081',
};
describe('independent relay configuration', () => {
  it('requires explicit private relay inputs without platform identity or NATS', () => {
    expect(readRelayEnvironment(configured)).toMatchObject({ host: '127.0.0.1', port: 8081, timeoutMs: 1000 });
    expect(() => readRelayEnvironment({})).toThrow('notify.relay.configuration_invalid');
  });
  it.each([
    { NOTIFY_RELAY_SEND_URL: 'http://mailbox.fixture/send' },
    { NOTIFY_RELAY_SEND_URL: 'https://secret@mailbox.fixture/send' },
    { NOTIFY_RELAY_TOKEN: 'short' },
    { NOTIFY_RELAY_SEND_TOKEN: configured.NOTIFY_RELAY_TOKEN },
    { NOTIFY_RELAY_TIMEOUT_MS: '10001' },
    { NOTIFY_RELAY_TIMEOUT_MS: '1e3' },
    { NOTIFY_RELAY_DATABASE_URL: 'https://database.fixture' },
    { DATABASE_URL: 'postgres://different-user@127.0.0.1:55447/independent_receipts_test' },
  ])('refuses unsafe configuration without exposing its values (%j)', (override) => {
    expect(() => readRelayEnvironment({ ...configured, ...override })).toThrow(/^notify\.relay\.configuration_invalid$/);
  });
});
