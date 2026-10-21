import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { ContactPanel } from '@/components/support-contact-panel';
import { loadContact } from '@/lib/support/contact-server';
import { AttachmentsPanel } from '@/components/support-attachments-panel';
import { loadAttachments } from '@/lib/support/attachments-server';

/** Support settings: the contact details the help centre shows and the ticket attachment limits. The first paint is svc-support's own answer, with its read time. */
export default async function SupportSettingsPage() {
  requireModulePage('support');
  const founder = await requireFounderPage();
  const [initial, attachments] = await Promise.all([loadContact(founder), loadAttachments(founder)]);
  return (
    <>
      <ContactPanel initial={initial} />
      <AttachmentsPanel initial={attachments} />
    </>
  );
}
