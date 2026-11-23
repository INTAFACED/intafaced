import { direction, fmtPct, type Decimal } from './deps';

/**
 * A 24h change as the kit draws it: the signed percentage with its direction drawn beside it (the kit's lt-arrow-up /
 * lt-arrow-down, a second cue beside the sign and the colour), never a typed glyph.
 */
export function Pct({ value }: { value: Decimal | null | undefined }) {
  const dir = direction(value) ?? 'flat';
  const arrow = value == null || dir === 'flat' ? null : dir;
  return (
    <span data-slot="pct" data-direction={dir} data-dir={dir === 'flat' ? undefined : dir} dir="ltr" data-ltr="" className="lt-num">
      {arrow ? (
        <>
          <span className={`lt-arrow lt-arrow-${arrow}`} aria-hidden="true" data-arrow={arrow} />{' '}
        </>
      ) : null}
      {fmtPct(value)}
    </span>
  );
}
