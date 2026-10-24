import { SEARCH_MAX } from '@/lib/search/cross-search';

/**
 * The cross-desk search box in the console shell (OPS-payments-desk-01). A plain GET form to `/search`, so it works before
 * the page's script has loaded and the address can be shared with another founder (who reads it again as themself).
 */
export function ConsoleSearch() {
  return (
    <form action="/search" method="get" role="search" className="adm-console-search" data-testid="console-search">
      <label className="adm-sr-only" htmlFor="adm-console-search-q">
        Search accounts, ledger and payments
      </label>
      <input
        id="adm-console-search-q"
        name="q"
        type="search"
        className="adm-input"
        placeholder="Email, handle, id or business key"
        maxLength={SEARCH_MAX}
        autoComplete="off"
        spellCheck={false}
        required
      />
      <button type="submit" className="adm-btn adm-btn--compact">
        Search
      </button>
    </form>
  );
}
