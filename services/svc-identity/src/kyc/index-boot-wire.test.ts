import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(here, '../index.ts'), 'utf8');

describe('production index boots KYC vault from IDENTITY_KYC_DOC_KEY only', () => {
  it('imports bootKycVault and calls it with the env key — never invents one', () => {
    expect(indexSrc).toMatch(/import\s*\{\s*bootKycVault\s*\}\s*from\s*['"]\.\/kyc\/boot-vault\.js['"]/);
    expect(indexSrc).toMatch(/bootKycVault\(\s*sql\s*,\s*env\.IDENTITY_KYC_DOC_KEY\s*\)/);
    expect(indexSrc).not.toMatch(/new KycDocumentStore\(/);
    expect(indexSrc).not.toMatch(/IDENTITY_KYC_DOC_KEY\s*\|\|/);
    expect(indexSrc).not.toMatch(/randomBytes\(32\)/);
  });

  it('passes vault handles into createIdentityRouter so procedures can boot', () => {
    expect(indexSrc).toMatch(/kycDocs:\s*vault\?\.kycDocs/);
    expect(indexSrc).toMatch(/bindKycProviderRef:\s*vault\?\.bindKycProviderRef/);
  });

  it('does not fail the whole process when the key is unset — auth still boots', () => {
    // TOTP key refuses prod boot; KYC key must not. Unset = procedures refuse, service serves.
    expect(indexSrc).not.toMatch(/if\s*\(\s*!parseKycDocKey/);
    expect(indexSrc).not.toMatch(/throw new Error\(['"]IDENTITY_KYC_DOC_KEY/);
  });
});

describe('compose passes IDENTITY_KYC_DOC_KEY through to svc-identity', () => {
  const composeSrc = readFileSync(join(here, '../../../../docker-compose.apps.yml'), 'utf8');
  const identityBlock = composeSrc.match(/^  svc-identity:[\s\S]*?(?=^  svc-)/m)?.[0] ?? '';

  it('forwards the host key — no compose default, no invented key, blank stays optional', () => {
    expect(identityBlock.length).toBeGreaterThan(0);
    expect(identityBlock).toMatch(/IDENTITY_KYC_DOC_KEY:\s*\$\{IDENTITY_KYC_DOC_KEY:-\}/);
    // `:?` would refuse `platform:up` when the host has no key. Vault is optional.
    expect(identityBlock).not.toMatch(/IDENTITY_KYC_DOC_KEY:\s*\$\{IDENTITY_KYC_DOC_KEY:\?/);
    // No literal key material in compose.
    expect(identityBlock).not.toMatch(/IDENTITY_KYC_DOC_KEY:\s*['"]?[A-Za-z0-9+/=]{32,}/);
  });
});
