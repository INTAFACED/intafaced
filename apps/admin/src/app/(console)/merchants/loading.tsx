import { Skeleton } from '@/components/merchants/ui';

/** Shown while a Merchants page reads its numbers. Loading is not an empty list and not zero. */
export default function Loading() {
  return (
    <div className="mp-page" aria-busy="true">
      <Skeleton rows={2} label="Loading merchants figures" />
      <div className="mp-skel mp-skel--tiles" aria-hidden="true">
        {Array.from({ length: 4 }, (_, i) => (
          <span key={i} className="mp-skel__bar" />
        ))}
      </div>
      <Skeleton rows={3} label="Loading table" />
    </div>
  );
}
