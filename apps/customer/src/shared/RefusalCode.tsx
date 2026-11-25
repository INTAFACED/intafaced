import { shownCode } from './reference';

/**
 * A refusal's code line ("Reference: rail.bank"), drawn only when the page shows that code (`shownCode`): a Bank refusal
 * no step names ends in plain words, its code kept on `data-code` for support and tests.
 */
export function RefusalCode({
  code,
  line,
  className,
}: {
  code: string | null | undefined;
  line: (code: string) => string;
  className?: string;
}) {
  if (!code) return null;
  const shown = shownCode(code);
  return (
    <small className={className} data-code={code}>
      {shown ? line(shown) : null}
    </small>
  );
}
