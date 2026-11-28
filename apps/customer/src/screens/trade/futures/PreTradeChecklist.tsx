import { useState } from 'react';
import { Button, Checkbox, Field, Switch } from '@intafaced/ui/lit';
import { CHECKLIST_ITEMS, CHECKLIST_ITEM_MAX, deviceStore, saveChecklist, type Checklist } from './pre-trade-checklist';
import { checklistCopy } from './pre-trade-checklist-copy';

/** The ticket's checklist settings (J-derivatives-34 #4): three items and the switch, saved to this device. */
export function ChecklistSettings({ owner, checklist, onSaved }: { owner: string; checklist: Checklist; onSaved: (c: Checklist) => void }) {
  const { t } = checklistCopy.useCopy();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<string[]>(() => Array.from({ length: CHECKLIST_ITEMS }, (_, i) => checklist.items[i] ?? ''));
  const [on, setOn] = useState(checklist.on);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);

  function save() {
    const answer = saveChecklist(deviceStore(), owner, { on, items });
    if (!answer.ok) return setSaid({ ok: false, text: t(answer.reason === 'no_items' ? 'No items' : 'Not kept') });
    onSaved(answer.checklist);
    setSaid({ ok: true, text: t(answer.checklist.on ? 'Saved on' : 'Saved off') });
  }

  return (
    <div className="lt-stack-tight">
      <Button tone="quiet" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
        {t('Checklist settings')}
      </Button>
      {open ? (
        <section aria-label={t('Checklist title')} data-testid="checklist-settings" className="lt-callout lt-stack-tight">
          <h3 className="lt-strong">{t('Checklist title')}</h3>
          <p className="lt-note">{t('Checklist how')}</p>
          {items.map((value, i) => (
            <Field
              key={i}
              label={t('Checklist item', { n: String(i + 1) })}
              value={value}
              maxLength={CHECKLIST_ITEM_MAX}
              onChange={(e) => {
                const next = [...items];
                next[i] = e.target.value;
                setItems(next);
                setSaid(null);
              }}
            />
          ))}
          <div className="xd-switch-row">
            <span aria-hidden="true">{t('Checklist on')}</span>
            <Switch
              label={t('Checklist on')}
              checked={on}
              onChange={(next) => {
                setOn(next);
                setSaid(null);
              }}
            />
          </div>
          <Button tone="secondary" onClick={save}>
            {t('Save checklist')}
          </Button>
          {said ? (
            <p
              role={said.ok ? 'status' : 'alert'}
              className={said.ok ? 'lt-note' : 'lt-callout lt-callout-bad'}
              data-testid="checklist-saved"
            >
              {said.text}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/** The checklist above Confirm on an opening order (J-derivatives-34 #4 #5): each item ticked here, and what waits. */
export function ChecklistTicks({
  checklist,
  ticked,
  onTick,
  waiting,
}: {
  checklist: Checklist;
  ticked: ReadonlySet<number>;
  onTick: (index: number, checked: boolean) => void;
  waiting: string | null;
}) {
  const { t } = checklistCopy.useCopy();
  return (
    <section aria-label={t('Checklist title')} data-testid="pre-trade-checklist" className="lt-callout lt-stack-tight">
      <h3 className="lt-strong">{t('Tick before')}</h3>
      {checklist.items.map((item, i) => (
        <Checkbox key={`${i}:${item}`} checked={ticked.has(i)} onCheckedChange={(c) => onTick(i, c)}>
          {item}
        </Checkbox>
      ))}
      {waiting ? (
        <p role="alert" className="lt-callout lt-callout-bad" data-testid="checklist-wait">
          {t('Checklist waits', { item: waiting })}
        </p>
      ) : null}
    </section>
  );
}
