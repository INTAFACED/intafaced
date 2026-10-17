/** Matches the first line of a not-live card: what the part is waiting for. For tests that only need to know a card is there. */
export const notLiveWords =
  /not (?:connected|set|available) yet|Available after your business|Available to the account owner|Document checks not connected|aren’t switched on|isn’t switched on|hasn’t switched/i;
