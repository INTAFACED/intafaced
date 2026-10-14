import type { Metadata } from 'next';
import { FounderReset } from '@/components/founder-reset';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'INTAFACED · Reset password', robots: { index: false, follow: false } };

/** Outside the (console) group, like /login: the founder has no session when they have forgotten their password. */
export default function ResetPage() {
  return (
    <main className="adm-login">
      <div className="adm-brand">
        <img src="/intafaced-logo.svg" alt="INTAFACED" width="164" height="30" />
        <small>Founder console</small>
      </div>
      <FounderReset />
    </main>
  );
}
