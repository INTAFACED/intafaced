/**
 * The studies' copy in one hook: `t` for messages with values, and `word` for a name or a label that is a copy key (a study
 * name, a series word, a field label). A text that is not a key, such as the formula notation "SMA 20", is returned as it is.
 */
import { studiesCopy, isWord } from './copy';

export type StudiesTranslate = ReturnType<typeof studiesCopy.useCopy>['t'];
export interface StudiesWords {
  t: StudiesTranslate;
  word: (text: string) => string;
}

export function useWords(): StudiesWords {
  const { t } = studiesCopy.useCopy();
  // A word has no values to fill in, so calling the translator with the key alone is always right for `word`.
  const plain = t as unknown as (key: string) => string;
  const word = (text: string): string => (isWord(text) ? plain(text) : text);
  return { t, word };
}
