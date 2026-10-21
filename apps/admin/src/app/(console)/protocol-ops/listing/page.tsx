import Link from 'next/link';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { ProtocolListingPanel } from '@/components/protocol-listing/panel';
import { ReasonCodeList } from '@/components/protocol-listing/reason-codes';
import { ListingState } from '@/components/protocol-listing/state';
import { readProtocolListing } from '@/lib/protocol-listing/read';
import '@/components/desk.css';

/**
 * Pool and market control for the Protocol Plane: what INTAFACED has hidden or delisted, and the two-founder request to change it.
 * The decisions live in svc-ops; svc-dex reads them on every quote and refuses a delisted market.
 */
export const dynamic = 'force-dynamic';

export default async function ProtocolListingPage() {
  requireModulePage('protocol-ops');
  const founder = await requireFounderPage();
  const read = await readProtocolListing(founder);
  return (
    <main className="dk-stack" data-testid="protocol-listing">
      <p>
        <Link href="/protocol-ops">Protocol operations</Link>
      </p>
      <h2>Pool and market control</h2>
      <ListingState asOf={read.asOf} pools={read.pools} markets={read.markets} />
      <ProtocolListingPanel
        userId={founder.session.userId}
        reasonCodes={read.reasonCodes.kind === 'ok' ? read.reasonCodes.data.codes : null}
      />
      {read.reasonCodes.kind === 'ok' ? (
        <ReasonCodeList {...read.reasonCodes.data} />
      ) : (
        <div className="adm-callout" data-tone="warn" role="status" data-testid="reason-codes-failed">
          <strong>Could not load the reason codes</strong>
          <p>{read.reasonCodes.message}</p>
          <p className="dk-muted">Type the code in the form above; svc-ops refuses one that is not in force.</p>
        </div>
      )}
    </main>
  );
}
