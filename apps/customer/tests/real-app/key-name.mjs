/**
 * A trade key's accessible name, with or without the size the spot ticket puts in it once one is typed ("Buy BTC" and
 * "Buy 0.10283 BTC" both match `keyName('Buy BTC')`). `exact` matches the whole name, as Playwright's `exact: true`;
 * otherwise the name only has to contain it, as Playwright's default.
 */
export function keyName(text, exact = false) {
  const [verb, ...rest] = text.split(' ');
  const tail = rest.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = `${verb} (\\S+ )?${tail}`;
  return new RegExp(exact ? `^${body}$` : body);
}
