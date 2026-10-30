import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { LaunchDraftDesk } from '@/components/launch-issuers/launch-draft-form';
import { readIssuerLens } from '@/lib/launch-issuers/server';

/** A new launch draft for an issuer (J-more-catalogue-14 #1), and the drafts svc-token holds. */
export const dynamic = 'force-dynamic';

export default async function NewLaunchPage() {
  requireModulePage('launch');
  const founder = await requireFounderPage();
  const read = await readIssuerLens(founder);
  return (
    <main>
      {read.events.kind === 'failed' && (
        <p role="alert" className="dk-muted">
          {read.events.message}
        </p>
      )}
      <LaunchDraftDesk
        issuers={read.issuers.kind === 'ok' ? read.issuers.data : []}
        drafts={read.events.kind === 'ok' ? read.events.data.filter((e) => e.status === 'draft') : []}
        issuersFailed={
          read.issuers.kind === 'failed' ? `${read.issuers.message} No draft can be saved until the issuers can be read.` : null
        }
        userId={founder.session.userId}
      />
    </main>
  );
}
