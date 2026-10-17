import { Button, Panel } from '../../shared/ui';
import { quantDraftCopy } from './quant-draft-copy';

/** "Save to library" stays on the form, off, with the reason beside it. Nothing typed in Studio is sent to the service. */
export function QuantSaveOff() {
  const { Copy, t, languageFor, directionFor } = quantDraftCopy.useCopy();
  return (
    <div className="quant-save-off" lang={languageFor('reason')} dir={directionFor('reason')}>
      <Button type="submit" disabled aria-describedby="quant-save-off-reason" data-testid="quant-save-library">
        {t('save')}
      </Button>
      <p className="muted" id="quant-save-off-reason">
        <Copy k="reason" /> <Copy k="draftNote" />
      </p>
    </div>
  );
}

/** The library panel in Studio: shown, closed, with the reason and no rows. */
export function QuantLibraryClosed() {
  const { t, languageFor, directionFor } = quantDraftCopy.useCopy();
  return (
    <Panel title={t('libraryTitle')}>
      <p className="muted" role="status" lang={languageFor('libraryClosed')} dir={directionFor('libraryClosed')}>
        {t('libraryClosed')}
      </p>
    </Panel>
  );
}
