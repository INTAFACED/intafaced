import { academyLmsCopy as copy } from '../academy-lms-copy';
import { AcademySignIn } from '../academy-kit-parts';
import { EmptyNote, Section } from '../volt-parts';

/** A section a visitor with no account cannot use yet: its heading, why, and Sign in back to this page. */
export function SignInNeeded({
  title,
  reason,
}: {
  title: string;
  reason: 'publicRoomsSignIn' | 'publicProgrammesSignIn' | 'publicCertificatesSignIn';
}) {
  const { t } = copy.useCopy();
  return (
    <Section title={title}>
      <EmptyNote title={t(reason)} action={<AcademySignIn />} />
    </Section>
  );
}
