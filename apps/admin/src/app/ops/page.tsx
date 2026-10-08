import { BusinessOps } from '@/components/business-ops';

/** No PII is server-rendered before the authenticated proxy passes the BFF gate. */
export default function BusinessOperationsPage() {
  return <BusinessOps />;
}
