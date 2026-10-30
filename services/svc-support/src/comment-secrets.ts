/**
 * A comment that holds a payment card number or a wallet recovery phrase is refused before anything is stored
 * (J-support-public-20 #5). Support never needs either, and a secret written into a ticket is copied into every read,
 * export and case file of it. The refusal names what was found, never the secret itself.
 *
 * - A card number: 13 to 19 digits, written together or in groups split by single spaces or hyphens, starting with a
 *   card network's first digit (2 to 6) and passing the Luhn check. Order ids, references and amounts rarely pass all
 *   three.
 * - A recovery phrase: 12 or more words in a row that are all on the BIP39 English list, the shortest phrase a wallet
 *   makes. Plain sentences break such a run within a few words ("the", "is", "my" are not on the list).
 */
import { BIP39_ENGLISH } from './bip39-english.js';

export const SUPPORT_COMMENT_SECRET_REFUSED = 'support.comment_secret_refused' as const;
export type CommentSecret = 'card_number' | 'recovery_phrase';

const WORDS = new Set(BIP39_ENGLISH);
const PHRASE_MIN = 12;
// A run of digit groups split by single spaces or hyphens, not part of a longer word or hex string.
const DIGIT_RUN = /(?<![0-9A-Za-z])\d+(?:[ -]\d+)*(?![0-9A-Za-z])/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const isCard = (digits: string) => digits.length >= 13 && digits.length <= 19 && /^[2-6]/.test(digits) && luhn(digits);

/**
 * Every run of consecutive groups is tried, so a card number written next to other numbers ("4111 1111 1111 1111 123",
 * "2 cards: 4111111111111111") is still found inside the longer run.
 */
function hasCardNumber(text: string): boolean {
  for (const match of text.matchAll(DIGIT_RUN)) {
    const groups = match[0].split(/[ -]/);
    for (let start = 0; start < groups.length; start += 1) {
      let digits = '';
      for (let end = start; end < groups.length && digits.length < 19; end += 1) {
        digits += groups[end];
        if (isCard(digits)) return true;
      }
    }
  }
  return false;
}

function hasRecoveryPhrase(text: string): boolean {
  // Words are runs of letters; numbering ("1. abandon 2. ability") and punctuation between them do not break a run.
  let run = 0;
  for (const token of text.toLowerCase().split(/[^a-z]+/)) {
    if (token === '') continue;
    run = WORDS.has(token) ? run + 1 : 0;
    if (run >= PHRASE_MIN) return true;
  }
  return false;
}

/** What secret the text holds, or null. */
export function findCommentSecret(text: string): CommentSecret | null {
  if (hasCardNumber(text)) return 'card_number';
  if (hasRecoveryPhrase(text)) return 'recovery_phrase';
  return null;
}
