import { useId, useMemo, type ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { CopyButton, QrCode } from '@intafaced/ui/lit/templates';
import type { ApiResult } from '../../../shared/api';
import { useFailureWords } from '../../../shared/failure-words';
import { usePreferences } from '../../../shared/preferences';
import { stamp } from '../../../screens/money/time';
import { accountScreenCopy } from '../../../screens/account/copy';
import { personalCopy } from '../../../screens/pay/personal-copy';
import { encodeQr, qrPath } from '../../../screens/pay/deps';
import { Text } from '../copy';

/**
 * The deposit room's small parts, drawn with the Volt kit (volt/flow, #9570). Each keeps the words, roles and ids of the
 * money folder's part it stands in for (DepthPanel, Fact, DisabledAction, ReportedTime, Failure, CopyButton, QrCode), which
 * other rooms still use as they are.
 */

/** A titled block of the room: a section named by its heading, with its lead under it. */
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

/** One label and value of a `<dl className="lt-kv">`. */
export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A control that is on the screen but cannot be used, with the reason next to it in plain words. */
export function DisabledAction({ label, reason }: { label: ReactNode; reason: ReactNode }) {
  const id = useId();
  return (
    <div>
      <Button tone="secondary" disabled aria-describedby={id}>
        {label}
      </Button>
      <p id={id} className="lt-hint">
        {reason}
      </p>
    </div>
  );
}

/** Returned timestamps share the app's one look ("18 Oct, 01:05") in the viewer's zone, with a picked zone named. */
export function ReportedTime({ value }: { value: string }) {
  const { timeZone } = usePreferences();
  return Number.isFinite(Date.parse(value)) ? (
    <time dateTime={value} lang="en-GB" dir="auto">
      {stamp(value, timeZone)}
    </time>
  ) : (
    <Text k="components.date.unavailable" />
  );
}

/** A failed read, in the words the app's Failure says. */
export function FailureBox({ result, retry }: { result: Extract<ApiResult<unknown>, { ok: false }>; retry?: () => void }) {
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

/** Copies a value, with the account screen's words; `label` is the button's name. */
export function Copy({ value, label }: { value: string; label?: string }) {
  const { t } = accountScreenCopy.useCopy();
  return (
    <CopyButton
      value={value}
      label={label ?? t('Copy account ID')}
      words={{ copy: t('Copy'), copied: t('Copied'), failed: t('Copy failed') }}
    />
  );
}

/** The QR code of a deposit address or its payload, with the pay screen's words. */
export function AddressQr({ value }: { value: string }) {
  const { t } = personalCopy.useCopy();
  const drawn = useMemo(() => {
    try {
      return qrPath(encodeQr(value, 'M'), 2);
    } catch {
      return null;
    }
  }, [value]);
  return <QrCode data-testid="pay-qr" d={drawn?.d ?? null} size={drawn?.size ?? 0} label={t('qrLabel')} failed={t('qrFailed')} />;
}
