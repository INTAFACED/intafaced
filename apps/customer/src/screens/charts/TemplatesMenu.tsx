import { useState, type FormEvent } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from './deps';
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
        <PopoverTrigger className="cw-templates-btn">{t('Templates')}</PopoverTrigger>
        <PopoverContent align="end" aria-label={t('Chart templates')} className="cw-templates">
          {record.status === 'signed-out' ? (
            <p className="cw-templates-note">{t('Templates signed out')}</p>
          ) : record.status === 'loading' ? (
            <p className="cw-templates-note">{t('Templates loading')}</p>
          ) : record.status === 'failed' ? (
            <p className="cw-templates-note">
              {t('Templates failed')}{' '}
              <button type="button" className="cw-templates-link" onClick={record.reload}>
                {t('Try again')}
              </button>
            </p>
          ) : (
            <>
              {record.value.templates.length === 0 ? (
                <p className="cw-templates-note">{t('No templates')}</p>
              ) : (
                <div role="menu" aria-label={t('Chart templates')} className="cw-templates-list">
                  {record.value.templates.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      role="menuitem"
                      className="cw-templates-item"
                      onClick={() => {
                        setOpen(false);
                        onApply(template);
                      }}
                    >
                      <span className="cw-templates-name">{template.name}</span>
                      <span className="cw-templates-facts">{t('Template facts', { count: template.studies.length })}</span>
                    </button>
                  ))}
                </div>
              )}
              {form ? (
                <div className="cw-templates-form">
                  {form.replacing ? (
                    <div role="alertdialog" aria-label={t('Replace title', { name: form.name.trim() })} className="cw-templates-form">
                      <p>{t('Replace body', { name: form.name.trim() })}</p>
                      <div className="cw-templates-actions">
                        <button type="button" disabled={busy} onClick={() => void submit(true)}>
                          {t('Replace')}
                        </button>
                        <button type="button" onClick={() => setForm({ ...form, replacing: false })}>
                          {t('Cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <form onSubmit={onSubmit} className="cw-templates-form">
                      <label className="cw-templates-field">
                        {t('Template name')}
                        <input
                          value={form.name}
                          maxLength={CHART_TEMPLATE_NAME_MAX}
                          autoFocus
                          onChange={(event) => setForm({ ...form, name: event.target.value, problem: null })}
                        />
                      </label>
                      <p className="cw-templates-note">{t('What it keeps')}</p>
                      <div className="cw-templates-actions">
                        <button type="submit" disabled={busy}>
                          {t('Save template')}
                        </button>
                        <button type="button" onClick={() => setForm(null)}>
                          {t('Cancel')}
                        </button>
                      </div>
                    </form>
                  )}
                  {form.problem ? (
                    <p role="alert" className="cw-templates-problem">
                      {form.problem}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="cw-templates-actions">
                  <button type="button" onClick={() => setForm({ name: '', replacing: false, problem: null })}>
                    {t('Save as template')}
                  </button>
                </div>
              )}
            </>
          )}
        </PopoverContent>
      </Popover>
      {savedName ? (
        <p role="status" className="cw-templates-saved" data-testid="cw-template-saved" data-template={savedName}>
          {t('Saved template', { name: savedName })}
        </p>
      ) : null}
    </>
  );
}
