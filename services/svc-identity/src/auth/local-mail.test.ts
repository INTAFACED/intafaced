import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCAL_MAIL_TRANSPORT, MAIL_TRANSPORT_REFUSED, localMailLine, openIdentityMail } from './local-mail.js';

describe('openIdentityMail', () => {
  const file = path.join(tmpdir(), 'email-outbox.log');

  it('stays unwired when no transport is selected', () => {
    expect(openIdentityMail({ appEnv: 'prod', transport: undefined, outboxPath: file })).toBeUndefined();
    expect(openIdentityMail({ appEnv: 'dev', transport: '  ', outboxPath: file })).toBeUndefined();
  });

  it('refuses the local outbox unless APP_ENV is exactly dev or test', () => {
    for (const appEnv of [undefined, '', 'staging', 'prod', 'DEV', 'production', 'test ']) {
      expect(() => openIdentityMail({ appEnv, transport: LOCAL_MAIL_TRANSPORT, outboxPath: file })).toThrow(MAIL_TRANSPORT_REFUSED);
    }
  });

  it('refuses any other transport name at boot', () => {
    expect(() => openIdentityMail({ appEnv: 'dev', transport: 'smtp', outboxPath: file })).toThrow(
      `${MAIL_TRANSPORT_REFUSED}: mail transport is not available`,
    );
    expect(() => openIdentityMail({ appEnv: 'test', transport: 'local-outbox', outboxPath: 'relative/outbox.log' })).toThrow(
      'absolute file path',
    );
  });

  it('writes a LOCAL-TEST confirm link and does not print the token', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mail-outbox-'));
    const outbox = path.join(dir, 'email-outbox.log');
    const mail = openIdentityMail({ appEnv: 'dev', transport: LOCAL_MAIL_TRANSPORT, outboxPath: outbox });
    expect(mail).toBeDefined();
    const token = 'super-secret-confirm-token';
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await mail!.send({
        email: 'Owner@Example.com',
        code: token,
        expiresAt: new Date('2026-10-17T00:00:00.000Z'),
        purpose: 'email-confirm',
      });
    } finally {
      process.stderr.write = original;
    }
    const text = readFileSync(outbox, 'utf8');
    expect(text).toContain('LOCAL-TEST');
    expect(text).toContain('purpose=email-confirm');
    expect(text).toContain(`link=confirm-email?token=${encodeURIComponent(token)}`);
    expect(written.join('')).not.toContain(token);
    expect(readFileSync(new URL('./local-mail.ts', import.meta.url), 'utf8')).not.toMatch(
      /nodemailer|resend|sendgrid|mailgun|postmark|amazonaws/i,
    );
  });

  it('builds the confirm line without a break in the email field', () => {
    const line = localMailLine({
      email: 'a\nb@example.com',
      code: 'tok',
      expiresAt: new Date('2026-10-17T00:00:00.000Z'),
      purpose: 'email-confirm',
    });
    expect(line).toBe(
      'LOCAL-TEST purpose=email-confirm email=ab@example.com expires=2026-10-17T00:00:00.000Z link=confirm-email?token=tok\n',
    );
  });
});

describe('localMailLine anti-phishing code', () => {
  const expiresAt = new Date('2026-10-23T12:00:00.000Z');

  it('puts the code on the end of the line, after everything the line already says', () => {
    const plain = localMailLine({ email: 'a@example.com', code: 'tok', expiresAt, purpose: 'email-confirm' });
    const stamped = localMailLine({
      email: 'a@example.com',
      code: 'tok',
      expiresAt,
      purpose: 'email-confirm',
      antiPhishingCode: 'Harbour42',
    });
    expect(stamped).toBe(plain.replace(/\n$/, ' anti_phishing=Harbour42\n'));
    expect(
      localMailLine({ email: 'a@example.com', code: '', expiresAt, purpose: 'email-change-notice', antiPhishingCode: 'Ab12' }),
    ).toMatch(/notice=address-changed anti_phishing=Ab12\n$/);
  });

  it('writes nothing for a missing code and only letters and digits for a present one', () => {
    expect(localMailLine({ email: 'a@example.com', code: 'tok', expiresAt })).not.toContain('anti_phishing');
    expect(localMailLine({ email: 'a@example.com', code: 'tok', expiresAt, antiPhishingCode: 'Ab 12\nx=y' })).toMatch(
      / anti_phishing=Ab12xy\n$/,
    );
  });
});
