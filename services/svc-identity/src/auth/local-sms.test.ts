import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { localSmsLine, openIdentitySms, SMS_TRANSPORT_REFUSED } from './local-sms.js';

describe('the LOCAL-TEST text-message outbox', () => {
  it('is off when unset, and refused at boot for another name, outside dev or test, or with a relative path', () => {
    expect(openIdentitySms({ appEnv: 'dev', transport: undefined, outboxPath: undefined })).toBeUndefined();
    expect(openIdentitySms({ appEnv: 'dev', transport: '  ', outboxPath: '/tmp/x' })).toBeUndefined();
    expect(() => openIdentitySms({ appEnv: 'dev', transport: 'twilio', outboxPath: '/tmp/x' })).toThrow(SMS_TRANSPORT_REFUSED);
    for (const appEnv of [undefined, 'staging', 'production', 'DEV']) {
      expect(() => openIdentitySms({ appEnv, transport: 'local-outbox', outboxPath: '/tmp/x' })).toThrow(SMS_TRANSPORT_REFUSED);
    }
    expect(() => openIdentitySms({ appEnv: 'test', transport: 'local-outbox', outboxPath: 'relative.log' })).toThrow(SMS_TRANSPORT_REFUSED);
  });

  it('appends one LOCAL-TEST line with the number and the code, readable by its owner only', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'sms-')), 'state', 'sms-outbox.log');
    const sms = openIdentitySms({ appEnv: 'test', transport: 'local-outbox', outboxPath: file })!;
    const expiresAt = new Date('2026-11-12T10:10:00Z');
    await sms.send({ phone: '+447700900123', code: '012345', expiresAt, purpose: 'phone-signin-link' });
    await sms.send({ phone: '+447700900124', code: '999999', expiresAt, purpose: 'phone-signin-link' });
    expect(readFileSync(file, 'utf8')).toBe(
      'LOCAL-TEST purpose=phone-signin-link phone=+447700900123 expires=2026-11-12T10:10:00.000Z code=012345\n' +
        'LOCAL-TEST purpose=phone-signin-link phone=+447700900124 expires=2026-11-12T10:10:00.000Z code=999999\n',
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps a line one line whatever the input holds', () => {
    const line = localSmsLine({ phone: '+44 7700\nx', code: '12\n34ab56', expiresAt: new Date(0), purpose: 'phone-signin-link' });
    expect(line.split('\n')).toHaveLength(2);
    expect(line).toContain('phone=+447700 ');
    expect(line).toContain('code=123456');
  });
});
