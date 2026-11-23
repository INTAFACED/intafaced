export type Section = 'account' | 'security' | 'permissions' | 'verification' | 'display';

/** The sub-nav links (UI-SPEC 5.13), each on a live route; Trading permissions is J-derivatives-30 #1. */
export const sections: ReadonlyArray<{
  id: Section;
  href: string;
  title: 'Account' | 'Security' | 'Trading permissions' | 'Verification' | 'Display';
}> = [
  { id: 'account', href: '/uc/account', title: 'Account' },
  { id: 'security', href: '/uc/safe', title: 'Security' },
  { id: 'permissions', href: '/uc/trading-permissions', title: 'Trading permissions' },
  { id: 'verification', href: '/verification', title: 'Verification' },
  { id: 'display', href: '/view', title: 'Display' },
];

/** Which section a route belongs to; anything that is not Security, Trading permissions, Verification or Display is Account. */
export function sectionFor(path: string): Section {
  const clean = path.split('?')[0];
  return clean === '/uc/safe' || clean?.startsWith('/uc/safe/')
    ? 'security'
    : clean === '/uc/trading-permissions'
      ? 'permissions'
      : clean === '/verification'
        ? 'verification'
        : clean === '/view'
          ? 'display'
          : 'account';
}
