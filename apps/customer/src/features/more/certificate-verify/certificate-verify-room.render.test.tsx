import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionProvider } from '../../session';
import { CertificateVerifyRoom } from './CertificateVerifyRoom';

const html = (node: React.ReactNode) => renderToStaticMarkup(<SessionProvider>{node}</SessionProvider>);

describe('the certificate check on the flow template', () => {
  it('keeps the Academy title and says when the address carries no code', () => {
    const out = html(<CertificateVerifyRoom code={undefined} />);
    expect(out).toContain('data-template="flow"');
    expect(out).toMatch(/<h1[^>]*>Academy<\/h1>/);
    expect(out).toContain('Certificate check');
    expect(out).toContain('data-certificate-verify=""');
    expect(out).toContain('This address does not carry a verification code, so there is nothing to check.');
    expect(out).not.toContain('lt-tabs');
  });

  it('refuses a malformed code in words and asks Academy nothing', () => {
    const out = html(<CertificateVerifyRoom code="nope" />);
    expect(out).toContain('A verification code is 32 characters long');
  });

  it('checks a well-formed code, lower-cased, and says it is checking', () => {
    const out = html(<CertificateVerifyRoom code={'A'.repeat(32)} />);
    expect(out).toContain(`data-certificate-verify="${'a'.repeat(32)}"`);
    expect(out).toContain('Checking the code');
  });
});
