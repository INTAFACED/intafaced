import { useId, useState } from 'react';
import { alertsCopy } from './alerts-copy';
import { editDiff, editStart, expiryProblem, priceProblem } from './alerts-model';
import { Button } from './deps';
import { ALERT_CONDITIONS, type AlertCondition, type AlertEdit, type PriceAlert } from './notify-api';

const CONDITION_KEY = {
  greater_than: 'above',
  less_than: 'below',
  crossing_up: 'crossingUp',
  crossing_down: 'crossingDown',
  crossing: 'crossing',
} as const satisfies Record<AlertCondition, string>;

/**
 * Change an active or stopped alert. Only what the person changed is sent. Added conditions are shown as they are and are not
 * edited here. The panel sends nothing on its own: Save hands the changes to the page, which owns the one-at-a-time gate.
 */
export function AlertEditPanel({
  alert,
  quote,
  busy,
  onSave,
  onClose,
}: {
  alert: PriceAlert;
  quote: string;
  busy: boolean;
  onSave: (edit: AlertEdit) => void;
  onClose: () => void;
}) {
  const copy = alertsCopy.useCopy();
  const id = useId();
  const [form, setForm] = useState(() => editStart(alert));
  const [touched, setTouched] = useState(false);
  const priceBad = priceProblem(form.price) !== null;
  const expiryBad = expiryProblem(form.expires) !== null;
  const edit = editDiff(alert, form);
  const nothing = Object.keys(edit).length === 0;

  return (
    <form
      className="nf-alertask nf-alertform"
      aria-label={copy.t('editTitle')}
      data-testid="alert-edit"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (busy || priceBad || expiryBad || nothing) return;
        onSave(edit);
      }}
    >
      <label className="nf-field">
        <span>{copy.t('editConditionLabel')}</span>
        <select
          value={form.condition}
          disabled={busy}
          onChange={(event) => {
            const next = ALERT_CONDITIONS.find((value) => value === event.target.value);
            if (next) setForm({ ...form, condition: next });
          }}
        >
          {ALERT_CONDITIONS.map((value) => (
            <option key={value} value={value}>
              {copy.t(CONDITION_KEY[value])}
            </option>
          ))}
        </select>
      </label>
      <label className="nf-field">
        <span>{copy.t('priceLabel', { quote })}</span>
        <input
          inputMode="decimal"
          autoComplete="off"
          maxLength={64}
          value={form.price}
          disabled={busy}
          aria-invalid={priceBad}
          aria-describedby={`${id}-price`}
          onChange={(event) => setForm({ ...form, price: event.target.value })}
        />
        <small id={`${id}-price`} className={priceBad ? 'nf-error' : 'nf-muted'}>
          {priceBad ? copy.t(form.price.trim() === '' ? 'priceEmpty' : 'priceInvalid') : copy.t('priceHint')}
        </small>
      </label>
      <label className="nf-field">
        <span>{copy.t('nameLabel')}</span>
        <input autoComplete="off" value={form.name} disabled={busy} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </label>
      <label className="nf-field">
        <span>{copy.t('messageLabel')}</span>
        <input
          autoComplete="off"
          value={form.message}
          disabled={busy}
          onChange={(event) => setForm({ ...form, message: event.target.value })}
        />
      </label>
      <label className="nf-field">
        <span>{copy.t('expiresLabel')}</span>
        <input
          type="datetime-local"
          value={form.expires}
          disabled={busy}
          aria-invalid={expiryBad}
          onChange={(event) => setForm({ ...form, expires: event.target.value })}
        />
        <small className={expiryBad ? 'nf-error' : 'nf-muted'}>{expiryBad ? copy.t('expiresInvalid') : copy.t('expiresHint')}</small>
      </label>
      {(alert.extras ?? []).length > 0 ? <p className="nf-muted">{copy.t('editExtrasKept')}</p> : null}
      {touched && nothing && !priceBad && !expiryBad ? (
        <p className="nf-muted" role="status">
          {copy.t('editNothing')}
        </p>
      ) : null}
      <div className="nf-address__actions">
        <Button variant="secondary" size={32} disabled={busy} onClick={onClose}>
          {copy.t('editClose')}
        </Button>
        <Button type="submit" size={32} loading={busy} disabled={busy}>
          {copy.t(busy ? 'editSaving' : 'editSave')}
        </Button>
      </div>
    </form>
  );
}
