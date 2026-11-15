import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { MailDesk } from '@/components/academy-enrolment-desk';
import { loadMail } from '@/lib/academy/enrolment-server';

/** Course email (J-academy-15): write to a course's learners; every send is recorded first. */
export default async function Page() {
  requireModulePage('academy-ops');
  const founder = await requireFounderPage();
  return <MailDesk initial={await loadMail(founder, null)} />;
}
