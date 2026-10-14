import { useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import {
  Accordion,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
  Button,
  Card,
  isHiddenPath,
  publishedCopy,
  StateBlock,
  useResource,
  useSession,
} from './deps';
import { supportScreenCopy } from './copy';
import { searchArticles } from './support-api';
import { paragraphs, visibleArticles } from './support-view';

/** The help centre entry: search the published articles and read them in place. */
export function Articles() {
  const { t } = supportScreenCopy.useCopy();
  const { api } = useSession();
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const { resource, reload } = useResource((signal) => searchArticles(api, query, signal), `support-kb:${query}`);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setQuery(typed.trim());
  };
  const depositsHidden = isHiddenPath('/uc/recharge');
  const rows = resource.status === 'ready' ? visibleArticles(resource.data, (key) => publishedCopy(key), depositsHidden) : [];
  return (
    <Card title={t('Help articles')}>
      <form className="sup-search" role="search" onSubmit={submit}>
        <Search size={18} strokeWidth={1.75} aria-hidden="true" className="sup-search__icon" />
        <input
          className="sup-search__input"
          type="search"
          name="help-search"
          aria-label={t('Search help')}
          placeholder={t('Search placeholder')}
          maxLength={200}
          autoComplete="off"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
        <Button type="submit" variant="secondary" size={32}>
          {t('Search')}
        </Button>
      </form>
      {resource.status === 'loading' ? (
        <StateBlock kind="loading" rows={4} rowHeight={56} label={t('Help articles')} />
      ) : resource.status === 'failed' ? (
        <StateBlock kind="error" title={t('Could not load')} onRetry={reload} retryLabel={t('Try again')} />
      ) : rows.length === 0 ? (
        <StateBlock kind="empty" title={t('No articles')} body={t('No articles body')} />
      ) : (
        <Accordion className="sup-articles" multiple={false}>
          {rows.map((row) => (
            <AccordionItem key={row.id} value={row.id}>
              <AccordionTrigger>{row.title}</AccordionTrigger>
              <AccordionPanel>
                {paragraphs(row.body).map((part, index) => (
                  <p key={index} className="sup-p">
                    {part}
                  </p>
                ))}
              </AccordionPanel>
            </AccordionItem>
          ))}
        </Accordion>
      )}
    </Card>
  );
}
