import type { ReactNode } from 'react';
import { IdentityOpsNav } from '@/components/identity-ops-nav';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <IdentityOpsNav />
      {children}
    </>
  );
}
