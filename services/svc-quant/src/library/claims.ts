/**
 * The performance-claim check of a listing's text and of a review (AL-library-01): a sentence that promises or states a
 * return, a profit figure or safety from loss fails it, by the sentence. The stored backtest is shown beside the listing
 * with its simulated label; the text never restates it as a promise.
 */

/** A figure: a percent, a multiple ("3x") or a number of percent words. */
const FIGURE = /(\d+(?:[.,]\d+)?\s*(?:%|percent\b|per\s*cent\b|x\b|times\b|fold\b))/i;
/** Words that make a figure a claim about returns or the period it is earned over. */
const RETURN_WORD =
  /\b(return(?:s|ed|ing)?|profit(?:s|able)?|gain(?:s|ed)?|yield(?:s)?|earn(?:s|ed|ing)?|make(?:s)?|made|roi|apy|apr|cagr|growth|grow(?:s)?|doubl(?:e|es|ed)|annual(?:ly|ised|ized)?|yearly|monthly|weekly|daily|a\s+(?:year|month|week|day)|per\s+(?:year|annum|month|week|day))\b/i;
/** Phrases that claim safety or certainty with no figure at all. */
const SAFETY =
  /\b(guarantee(?:d|s)?|risk[-\s]?free|no[-\s]risk|can(?:not|'t|’t)\s+lose|never\s+lose(?:s)?|sure[-\s]?fire|always\s+(?:wins?|profits?))\b/i;

/** The text split into sentences, each trimmed; blank pieces are dropped. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((piece) => piece.trim())
    .filter(Boolean);
}

/** The sentences of `text` that make a performance claim, in order. Empty when none does. */
export function performanceClaims(text: string): string[] {
  return sentencesOf(text).filter((sentence) => (FIGURE.test(sentence) && RETURN_WORD.test(sentence)) || SAFETY.test(sentence));
}
