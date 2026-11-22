import { useId, type ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import type { ApiResult } from '../../../shared/api';
import { useFailureWords } from '../../../shared/failure-words';
import { uiCopy } from '../../../shared/ui-copy';

/**
 * The small parts Withdraw draws with the kit, each saying exactly what the shared part it replaces
 * said: `Failure` and `Loading` (shared/ui), `DisabledAction` and `Fact` (DepthParts).
 */

/** A failed read or change, in the words `Failure` says it. */
export function FailureNote({ result, retry }: { result: Extract<ApiResult<unknown>, { ok: false }>; retry?: () => void }) {
  const w = useFailureWords(result, Boolean(retry));
  return (
    <div data-testid="failure" role={w.alert ? 'alert' : 'status'}>
      <h3>{w.title}</h3>
      <p lang={w.bodyLang}>{w.body}</p>
      {w.action && (
        <a className="lt-link" href={w.action.href}>
          {w.action.label}
        </a>
      )}
      {w.reference && <small>{w.reference}</small>}
      {w.retry && retry && (
        <Button tone="secondary" onClick={retry}>
          {w.retry}
        </Button>
      )}
    </div>
  );
}

/** Data on its way, in `Loading`'s words. */
export function LoadingLine() {
  const { t } = uiCopy.useCopy();
  return <p role="status">{t('loading')}…</p>;
}

/** A control that is on the screen but cannot be used, with the reason next to it in plain words. */
export function DisabledAction({
  label,
  reason,
  tone = 'secondary',
}: {
  label: ReactNode;
  reason: ReactNode;
  tone?: 'primary' | 'secondary';
}) {
  const id = useId();
  return (
    <div>
      <Button tone={tone} disabled aria-describedby={id}>
        {label}
      </Button>
      <p id={id} className="lt-hint">
        {reason}
      </p>
    </div>
  );
}

/** One label and value row inside a `<dl className="lt-kv">`. */
export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A titled part of the room: a section with its heading and lead, as `DepthPanel` drew it. */
export function Panel({ title, lead, children }: { title: ReactNode; lead?: ReactNode; children: ReactNode }) {
  const heading = useId();
  return (
    <section aria-labelledby={heading}>
      <h3 id={heading}>{title}</h3>
      {lead && <p className="lt-hint">{lead}</p>}
      {children}
    </section>
  );
}
