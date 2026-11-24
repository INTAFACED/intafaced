import { shortReference } from './reference';

/**
 * A long id as a customer reads it: its short reference, with the whole id in the tooltip. A copy button beside it still
 * copies the whole id; body copy never prints one (app/render-record/customer-words.test.ts).
 */
export function ShortReference({ id, className }: { id: string | null | undefined; className?: string }) {
  if (!id) return null;
  return (
    <span lang="zxx" className={className} title={id} data-reference={id}>
      {shortReference(id)}
    </span>
  );
}
