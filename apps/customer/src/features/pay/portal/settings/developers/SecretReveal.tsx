import { Button } from '@intafaced/ui/lit';
import { developersCopy as c } from './copy';
import { CopyReference } from '../../volt/parts';

/**
 * A secret the service shows exactly once. It lives only in the page's memory: Hide removes it, and so does leaving
 * the page. It is never written to the address, to storage or to a log.
 */
export function SecretReveal({ title, secret, what, onHide }: { title: string; secret: string; what: string; onHide: () => void }) {
  const { t } = c.useCopy();
  return (
    <section className="lt-region" aria-label={title} data-testid="secret-reveal">
      <h3>{title}</h3>
      <p className="lt-hint" role="alert">
        {t('secretOnce')}
      </p>
      <CopyReference value={secret} what={what} />
      <Button tone="secondary" onClick={onHide}>
        {t('secretHide')}
      </Button>
    </section>
  );
}
export type Revealed = { title: string; secret: string; what: string } | null;
