import { publishedCopy, publishedLanguageFor } from '../../shared/copy';
import type { UiLocale } from '../../shared/i18n';

type KbTextSource = { titleKey: string; bodyKey: string; title?: string; body?: string; language?: string };

/**
 * The words a reader sees for one answer. One typed in the desk carries its own text in its own language; a
 * catalogue-keyed one is looked up in the reader's language, falling back as the catalogue does.
 */
export function kbArticleText(article: KbTextSource, locale?: UiLocale) {
  if (article.title && article.body)
    return { title: article.title, body: article.body, titleLanguage: article.language, bodyLanguage: article.language, stored: true };
  return {
    title: publishedCopy(article.titleKey, locale),
    body: publishedCopy(article.bodyKey, locale),
    titleLanguage: publishedLanguageFor(article.titleKey, locale),
    bodyLanguage: publishedLanguageFor(article.bodyKey, locale),
    stored: false,
  };
}
