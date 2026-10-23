export type Section = 'account' | 'security' | 'verification' | 'display';

/** The four sub-nav links (UI-SPEC 5.13), each on a live route. */
export const sections: ReadonlyArray<{ id: Section; href: string; title: 'Account' | 'Security' | 'Verification' | 'Display' }> = [
  { id: 'account', href: '/uc/account', title: 'Account' },
  { id: 'security', href: '/uc/safe', title: 'Security' },
  { id: 'verification', href: '/verification', title: 'Verification' },
  { id: 'display', href: '/view', title: 'Display' },
];

/** Which section a route belongs to; anything that is not Security, Verification or Display is Account. */
export function sectionFor(path: string): Section {
  const clean = path.split('?')[0];
  return clean === '/uc/safe' || clean?.startsWith('/uc/safe/')
    ? 'security'
    : clean === '/verification'
      ? 'verification'
      : clean === '/view'
        ? 'display'
        : 'account';
}
