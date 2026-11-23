import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { EnrolmentDesk } from '@/components/academy-enrolment-desk';
import { loadEnrolment } from '@/lib/academy/enrolment-server';

/** Enrolment and invitations (J-academy-15): enrol in bulk or one learner, invite an address, tag learners in bulk. */
export default async function Page() {
  requireModulePage('academy-ops');
  const founder = await requireFounderPage();
  return <EnrolmentDesk initial={await loadEnrolment(founder)} />;
}
