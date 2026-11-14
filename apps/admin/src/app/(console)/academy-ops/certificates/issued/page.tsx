import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AcademyIssuedCerts } from '@/components/academy-cert-designs';
import { loadIssuedCerts } from '@/lib/academy/cert-designs-server';

const CERT_ID = /^[a-z0-9:_-]{1,64}$/;

/** Issued certificates (AC-certificates-03): counts by certificate and status, the newest rows and stored exports. */
export default async function Page({ searchParams }: { searchParams: Promise<{ certificate?: string }> }) {
  requireModulePage('academy-ops');
  const founder = await requireFounderPage();
  const asked = (await searchParams).certificate;
  const certificate = asked && CERT_ID.test(asked) ? asked : null;
  return <AcademyIssuedCerts initial={await loadIssuedCerts(founder, certificate)} />;
}
