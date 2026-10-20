import { redirect } from 'next/navigation';
import { requireModulePage } from '@/lib/module-page-guard';

/** The identity desks share one nav entry. Signing keys come first; the OAuth app queue sits beside it. */
export default function Page() {
  requireModulePage('identity-ops');
  redirect('/identity-ops/keys');
}
