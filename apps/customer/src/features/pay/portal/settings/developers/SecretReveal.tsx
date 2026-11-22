import { Button } from '@intafaced/ui';
import { CopyReference } from '../../ui/CopyReference';
import { developersCopy as c } from './copy';

/**
 * A secret the service shows exactly once. It lives only in the page's memory: Hide removes it, and so does leaving
 * the page. It is never written to the address, to storage or to a log.
 */
export function SecretReveal({ title, secret, what, onHide }: { title: string; secret: string; what: string; onHide: () => void }) {
  const { t } = c.useCopy();
  return (
    <section className="pp-secret" aria-label={title}>
      <h3>{title}</h3>
      <p className="pp-callout pp-callout--warn" role="alert">
        {t('secretOnce')}
      </p>
      <CopyReference value={secret} what={what} />
      <Button variant="secondary" onClick={onHide}>
        {t('secretHide')}
      </Button>
    </section>
  );
}
export type Revealed = { title: string; secret: string; what: string } | null;
