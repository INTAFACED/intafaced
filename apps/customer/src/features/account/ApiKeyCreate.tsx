import { useEffect, useState } from 'react';
import type { ApiKeyCreateOutput } from '@intafaced/contracts/api-keys';
import { Button } from '../../shared/ui';
import { apiKeysCopy as copy } from './api-keys-copy';
import { environmentFile } from './developer-keys-api';

// The shown-once panel of a key rotation (RotateKey, RotationRequest). The create form itself is on the flow template in
// ./api-key-create/ApiKeyCreateRoom.tsx, which draws its own panel from the kit.

/** The key, once: copy, download as an environment file, and a box to tick before the panel can close. */
export function ShownOnce({ made, onDone }: { made: ApiKeyCreateOutput & { key: string }; onDone: () => void }) {
  const { t } = copy.useCopy();
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([environmentFile(made.key, made.signingSecret)], { type: 'text/plain' }));
    setHref(url);
    return () => URL.revokeObjectURL(url);
  }, [made.key, made.signingSecret]);
  return (
    <section data-testid="security__card" className="api-keys__secret security__card" aria-labelledby="api-key-secret">
      <h2 id="api-key-secret">{t('createdTitle')}</h2>
      <p className="api-keys__warning" role="alert">
        {t('createdOnce')}
      </p>
      <p>
        <bdi lang="und">{made.record.name}</bdi> · <code lang="und">{made.record.prefix}</code>
      </p>
      <output data-testid="api-keys__key" className="api-keys__key" aria-label={t('createdTitle')}>
        <code lang="und">{made.key}</code>
      </output>
      {made.signingSecret && (
        <>
          <h3 id="api-key-signing-secret">{t('signingTitle')}</h3>
          <p>{t('signingOnce')}</p>
          <output data-testid="api-keys__signing-secret" className="api-keys__key" aria-labelledby="api-key-signing-secret">
            <code lang="und">{made.signingSecret}</code>
          </output>
        </>
      )}
      <div className="api-keys__actions">
        <Button
          variant="secondary"
          onClick={() => {
            const write = navigator.clipboard?.writeText(made.key) ?? Promise.reject(new Error('no clipboard'));
            write.then(
              () => setCopied('yes'),
              () => setCopied('failed'),
            );
          }}
        >
          {copied === 'yes' ? t('copied') : t('copy')}
        </Button>
        {href && (
          <a
            className="button button--secondary"
            href={href}
            download={`${made.record.name.replace(/[^A-Za-z0-9_-]+/g, '-') || 'api-key'}.env`}
          >
            {t('download')}
          </a>
        )}
      </div>
      {copied === 'failed' && <p className="error-text">{t('copyFailed')}</p>}
      <label className="api-keys__stored">
        <input type="checkbox" checked={stored} onChange={(event) => setStored(event.currentTarget.checked)} />
        <span>{t('stored')}</span>
      </label>
      <Button disabled={!stored} onClick={onDone}>
        {t('done')}
      </Button>
    </section>
  );
}
