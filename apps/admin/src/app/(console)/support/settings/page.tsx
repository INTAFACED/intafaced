import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { ContactPanel } from '@/components/support-contact-panel';
import { loadContact } from '@/lib/support/contact-server';

/** Support settings: the contact details the help centre shows. The first paint is svc-support's own answer, with its read time. */
export default async function SupportSettingsPage() {
  requireModulePage('support');
  const founder = await requireFounderPage();
  const initial = await loadContact(founder);
  return <ContactPanel initial={initial} />;
}
