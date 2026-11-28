import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LOCAL_MAIL_TRANSPORT, MAIL_TRANSPORT_REFUSED, localMailLine, openIdentityMail } from './local-mail.js';

describe('openIdentityMail', () => {
  const file = path.join(tmpdir(), 'email-outbox.log');

  // Staging and prod refuse to boot with no transport: gateway-mail.test.ts, 'mail transport at boot'.
  it('stays unwired in dev and test when no transport is selected', () => {
    expect(openIdentityMail({ appEnv: 'test', transport: undefined, outboxPath: file })).toBeUndefined();
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
  });

  it('the local outbox sends through no mail vendor and makes no request: the line goes to the file alone', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mail-outbox-'));
    const outbox = path.join(dir, 'email-outbox.log');
    const savedFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests.push(String(input));
      throw new Error('the local outbox made a request');
    }) as typeof fetch;
    try {
      // The fetch handed in is the one a gateway would use: the local outbox never calls it either.
      const mail = openIdentityMail({ appEnv: 'test', transport: LOCAL_MAIL_TRANSPORT, outboxPath: outbox }, globalThis.fetch);
      const message = {
        email: 'a@example.com',
        code: 'tok',
        expiresAt: new Date('2026-10-17T00:00:00.000Z'),
        purpose: 'email-confirm' as const,
      };
      await mail!.send(message);
      expect(readFileSync(outbox, 'utf8')).toBe(localMailLine(message));
    } finally {
      globalThis.fetch = savedFetch;
    }
    expect(requests).toEqual([]);
    // No vendor SDK or network module is loaded with it: a fresh load of the module with each watched loads none.
    const loaded: string[] = [];
    const watched = ['node:http', 'node:https', 'node:net', 'node:tls', 'nodemailer', 'resend', '@sendgrid/mail', 'mailgun.js', 'postmark'];
    for (const name of watched)
      vi.doMock(name, () => {
        loaded.push(name);
        return {};
      });
    vi.resetModules();
    try {
      const fresh = await import('./local-mail.js');
      expect(fresh.openIdentityMail({ appEnv: 'test', transport: LOCAL_MAIL_TRANSPORT, outboxPath: outbox })).toBeDefined();
    } finally {
      for (const name of watched) vi.doUnmock(name);
      vi.resetModules();
    }
    expect(loaded).toEqual([]);
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

describe('localMailLine support chat', () => {
  it('names the chat a customer continued by email, and links the app’s support chat', () => {
    const line = localMailLine({
      email: 'c@example.com',
      code: '33333333-3333-4333-8333-333333333333',
      expiresAt: new Date('2026-10-31T00:00:00.000Z'),
      purpose: 'support-chat-email',
      detail: 'reply 4',
    });
    expect(line).toBe(
      'LOCAL-TEST purpose=support-chat-email email=c@example.com expires=2026-10-31T00:00:00.000Z chat=33333333-3333-4333-8333-333333333333 part=reply_4 link=support/chat\n',
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
