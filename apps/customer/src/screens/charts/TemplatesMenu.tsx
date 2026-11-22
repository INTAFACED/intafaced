import { useState, type FormEvent } from 'react';
import { Button, Popover, PopoverContent, PopoverTrigger } from '@intafaced/ui/lit';
import { templateRefusal, templatesCopy } from './templates-copy';
import { CHART_TEMPLATE_NAME_MAX, findTemplate, saveTemplate, useChartTemplates, type ChartTemplate } from './templates';
import type { StudyStore } from './studies/model';
import type { ChartStyle, ColourScheme } from './chart-style';

type SaveForm = { name: string; replacing: boolean; problem: string | null };

/**
 * The Templates button in the workbench head: the account's chart templates to apply, and Save as template for this chart's
 * studies and style. Applying is the page's: it knows the workbench.
 */
export function TemplatesMenu({
  current,
  onApply,
}: {
  /** The chart as it is now: its studies and style, read when the person saves. */
  current: () => { studies: StudyStore; style: ChartStyle; scheme: ColourScheme };
  onApply: (template: ChartTemplate) => void;
}) {
  const { t } = templatesCopy.useCopy();
  const { record, change } = useChartTemplates();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<SaveForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedName, setSavedName] = useState<string | null>(null);

  const submit = async (replace: boolean) => {
    if (!form) return;
    const name = form.name.trim();
    if (name === '') return setForm({ ...form, problem: t('Name needed') });
    if (name.length > CHART_TEMPLATE_NAME_MAX) return setForm({ ...form, problem: t('Name too long') });
    if (!replace && record.status === 'ready' && findTemplate(record.value, name))
      return setForm({ ...form, replacing: true, problem: null });
    // The menu closes at once, as a save is asked for; a refused save opens it again with the reason and the name kept.
    const asked = { ...form, replacing: false };
    const chart = current();
    setForm(null);
    setOpen(false);
    setBusy(true);
    const result = await change((value) => saveTemplate(value, { name, ...chart }, new Date()));
    setBusy(false);
    if (result.ok) setSavedName(name);
    else {
      setForm({ ...asked, problem: t(templateRefusal(result.code)) });
      setOpen(true);
    }
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit(false);
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setSavedName(null);
          if (!next) setForm(null);
        }}
      >
        <PopoverTrigger className="lt-button lt-button-secondary">{t('Templates')}</PopoverTrigger>
        <PopoverContent align="end" size="wide" aria-label={t('Chart templates')} className="lt-stack">
          {record.status === 'signed-out' ? (
            <p className="lt-note">{t('Templates signed out')}</p>
          ) : record.status === 'loading' ? (
            <p className="lt-note">{t('Templates loading')}</p>
          ) : record.status === 'failed' ? (
            <p className="lt-note">
              {t('Templates failed')}{' '}
              <button type="button" className="lt-link" onClick={record.reload}>
                {t('Try again')}
              </button>
            </p>
          ) : (
            <>
              {record.value.templates.length === 0 ? (
                <p className="lt-note">{t('No templates')}</p>
              ) : (
                <div role="menu" aria-label={t('Chart templates')} className="lt-stack-tight">
                  {record.value.templates.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      role="menuitem"
                      className="lt-menu-item"
                      onClick={() => {
                        setOpen(false);
                        onApply(template);
                      }}
                    >
                      <span className="lt-strong">{template.name}</span>{' '}
                      <span className="lt-note">{t('Template facts', { count: template.studies.length })}</span>{' '}
                      {template.drawings && template.drawings.items.length > 0 ? (
                        <span className="lt-note" data-testid="cw-template-drawings">
                          {t('Template drawings', { count: template.drawings.items.length, symbol: template.drawings.symbol })}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
              {form ? (
                <div className="lt-stack">
                  {form.replacing ? (
                    <div role="alertdialog" aria-label={t('Replace title', { name: form.name.trim() })} className="lt-stack">
                      <p>{t('Replace body', { name: form.name.trim() })}</p>
                      <div className="lt-actions">
                        <Button size="sm" disabled={busy} onClick={() => void submit(true)}>
                          {t('Replace')}
                        </Button>
                        <Button size="sm" tone="quiet" onClick={() => setForm({ ...form, replacing: false })}>
                          {t('Cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <form onSubmit={onSubmit} className="lt-stack">
                      <label className="lt-field">
                        {t('Template name')}
                        <input
                          value={form.name}
                          maxLength={CHART_TEMPLATE_NAME_MAX}
                          autoFocus
                          onChange={(event) => setForm({ ...form, name: event.target.value, problem: null })}
                        />
                      </label>
                      <p className="lt-note">{t('What it keeps')}</p>
                      <div className="lt-actions">
                        <Button type="submit" size="sm" disabled={busy}>
                          {t('Save template')}
                        </Button>
                        <Button size="sm" tone="quiet" onClick={() => setForm(null)}>
                          {t('Cancel')}
                        </Button>
                      </div>
                    </form>
                  )}
                  {form.problem ? (
                    <p role="alert" className="lt-note lt-note-bad">
                      {form.problem}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="lt-actions">
                  <Button size="sm" onClick={() => setForm({ name: '', replacing: false, problem: null })}>
                    {t('Save as template')}
                  </Button>
                </div>
              )}
            </>
          )}
        </PopoverContent>
      </Popover>
      {savedName ? (
        <p role="status" className="lt-note" data-testid="cw-template-saved" data-template={savedName}>
          {t('Saved template', { name: savedName })}
        </p>
      ) : null}
    </>
  );
}
