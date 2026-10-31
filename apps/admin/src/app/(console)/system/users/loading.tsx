import { Skeleton } from '@/components/merchants/ui';

/** Reading svc-identity. Loading is not an empty roster and not a successful zero-row answer. */
export default function Loading() {
  return <Skeleton rows={5} label="Reading the staff roster from svc-identity" />;
}
