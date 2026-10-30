import { usePreferences } from '../../../shared/preferences';
import { explorerCopy, type ExplorerTranslate } from '../explorer/copy';

/** The explorer's own words for why the indexer gave no answer, so the pool pages name a refusal the same way. */
export function useExplorerWords(): ExplorerTranslate {
  const { language } = usePreferences();
  return explorerCopy.forLocale(language).t;
}
