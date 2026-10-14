import type { Metadata } from 'next';
import { FounderEnrolment } from '@/components/founder-enrolment';
import { enrolmentIsOpen } from '@/lib/enrolment-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'INTAFACED · Founder enrolment', robots: { index: false, follow: false } };

/** Outside the (console) group, like /login: nothing here is a console session. Closed unless ADMIN_FOUNDER_ENROLMENT is `open`. */
export default function EnrolPage() {
  const open = enrolmentIsOpen();
  return (
    <main className="adm-login adm-enrol">
      <div className="adm-brand adm-enrol__no-print">
        <img src="/intafaced-logo.svg" alt="INTAFACED" width="164" height="30" />
        <small>Founder enrolment</small>
      </div>
      {open ? (
        <FounderEnrolment />
      ) : (
        <>
          <h1>Enrolment is closed.</h1>
          <p>
            This page is only open while the two founder accounts are being set up. <a href="/login">Go to sign in</a>
          </p>
        </>
      )}
    </main>
  );
}
