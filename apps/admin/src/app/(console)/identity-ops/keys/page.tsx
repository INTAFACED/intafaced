import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { IdentityKeysDesk } from '@/components/identity-keys-desk';
import { loadKeys } from '@/lib/identity-ops/keys-server';

/**
 * Identity signing keys: which key signs access tokens, which previous keys still verify, and the two-founder rotate and
 * remove-old controls. The first paint is svc-identity's own answer with the time it was read.
 */
export default async function Page() {
  requireModulePage('identity-ops');
  const founder = await requireFounderPage();
  return <IdentityKeysDesk initial={await loadKeys(founder)} userId={founder.session.userId} />;
}
