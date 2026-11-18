import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { ContactPanel } from '@/components/support-contact-panel';
import { loadContact } from '@/lib/support/contact-server';
import { AttachmentsPanel } from '@/components/support-attachments-panel';
import { loadAttachments } from '@/lib/support/attachments-server';
import { HelpCentrePanel } from '@/components/support-help-centre-panel';
import { loadHelpCentre } from '@/lib/support/help-centre-server';

/** Support settings: the help centre's name, theme, languages and missing translations, the contact details it shows and the ticket attachment limits. The first paint is svc-support's own answer, with its read time. */
export default async function SupportSettingsPage() {
  requireModulePage('support');
  const founder = await requireFounderPage();
  const [helpCentre, initial, attachments] = await Promise.all([loadHelpCentre(founder), loadContact(founder), loadAttachments(founder)]);
  return (
    <>
      <HelpCentrePanel view={helpCentre} />
      <ContactPanel initial={initial} />
      <AttachmentsPanel initial={attachments} />
    </>
  );
}
