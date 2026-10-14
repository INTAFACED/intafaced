export type Section = 'account' | 'security' | 'verification' | 'display' | 'api-keys' | 'sub-accounts' | 'fees';

/** The sub-nav links (UI-SPEC 5.13 plus the M9 account tools), each on a live route. */
export const sections: ReadonlyArray<{
  id: Section;
  href: string;
  title: 'Account' | 'Security' | 'Verification' | 'Display' | 'API keys' | 'Sub-accounts' | 'Fees';
}> = [
  { id: 'account', href: '/uc/account', title: 'Account' },
  { id: 'security', href: '/uc/safe', title: 'Security' },
  { id: 'verification', href: '/verification', title: 'Verification' },
  { id: 'api-keys', href: '/uc/api', title: 'API keys' },
  { id: 'sub-accounts', href: '/uc/sub-accounts', title: 'Sub-accounts' },
  { id: 'fees', href: '/uc/fees', title: 'Fees' },
  { id: 'display', href: '/view', title: 'Display' },
];

/** Which section a route belongs to; anything that is not one of the others is Account. */
export function sectionFor(path: string): Section {
  const clean = path.split('?')[0];
  return clean === '/uc/safe'
    ? 'security'
    : clean === '/verification'
      ? 'verification'
      : clean === '/view'
        ? 'display'
        : clean === '/uc/api'
          ? 'api-keys'
          : clean === '/uc/sub-accounts'
            ? 'sub-accounts'
            : clean === '/uc/fees'
              ? 'fees'
              : 'account';
}
