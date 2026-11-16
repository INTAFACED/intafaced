// garden/no-shared-market-on-book: a journey step that prices off a book trades on a market of its own.
// J-cex-spot-02 #7 read the TEST venue maker's bids on 'BTC-USDC' and priced a buy one tick over them; on the shared
// stack a bid J-bank-13 had left resting above filled the second trader's sell at once, and #7 failed only when J-bank-13
// ran first (issue #8546, 420 minutes of red full runs on #8509). The fix is a market no other file trades:
// ownSpotMarket(J, prefix, tag) from apps/customer/tests/real-app/own-market.mjs.
//
// What is judged, in journey files (apps/customer/tests/real-app/*.pw.mjs), per step (`test(...)` callback):
// - it reads a book: a string naming a book or resting-order route (`/book`, `/orderbook`, `/best-prices`), directly or
//   through a function of the same file that does, or a call whose name says it (`venueBook`, `awayBid`, `bestAsk`);
// - it prices or places an order: a `price` field, the ticket's 'Price' box, or a call such as `placeOrder`, `restBuy`
//   (a step that only compares the desk's book with the venue's, as J-cex-spot-01 #5 does on the market its words name,
//   prices nothing and is not judged);
// - and its title does not name the market: a step whose words say "opens /trade/spot/BTC-USDC" trades it on purpose;
// - and it names a shared market: a quoted symbol such as 'BTC-USDC' (or a path ending in one), directly, through a
//   module-level constant holding one, or through a function of the same file that does (a default parameter counts).
// Judged by the lint ratchet: a new copy fails, the copies on main are the baseline (tooling/ci/lint-ratchet.mjs).
const JOURNEY = /(?:^|\/)apps\/customer\/tests\/real-app\/[^/]+\.pw\.mjs$/u;
// A quoted market symbol is one the stack seeds for every file; a market of a step's own is built at run time.
const SHARED = /(?:^|\/)[A-Z][A-Z0-9]{1,9}-(?:USDC|USDT|USD)$/u;
const NAMED = /\b[A-Z][A-Z0-9]{1,9}-(?:USDC|USDT|USD)\b/u;
const BOOK_ROUTE = /\/(?:book|orderbook|best-prices)\b/u;
// `venueBook`, `awayBid`, `restingBid`, `bestAsk`, `book`: never `ask(` (a question to an agent) or `bidding`.
const BOOK_NAME = /^(?:book|books)$|[a-z](?:Book|Books|Bid|Bids|Ask|Asks)$/u;
// The step prices something: a `price` field, the ticket's 'Price' box, or a call that places or rests an order.
const ORDER_NAME = /^(?:place|rest|buy|sell)|(?:Order|Orders|Buy|Sell)$/u;

const isFn = (n) => n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration');
const strings = (n) => {
  if (n.type === 'Literal' && typeof n.value === 'string') return [n.value];
  if (n.type === 'TemplateLiteral') return n.quasis.map((q) => q.value.cooked ?? q.value.raw);
  return [];
};
const calleeName = (call) => {
  const c = call.callee;
  if (c?.type === 'Identifier') return c.name;
  if (c?.type === 'MemberExpression' && !c.computed) return c.property?.name ?? null;
  return null;
};

/** What a function body touches directly: shared-market literals, book reads, module constants and local calls. */
function scan(root, sharedConsts) {
  const out = { shared: null, book: false, order: false, calls: new Set() };
  const walk = (n, top) => {
    if (!n || typeof n !== 'object') return;
    if (!top && n.type === 'FunctionDeclaration') return;
    for (const s of strings(n)) {
      if (!out.shared && SHARED.test(s)) out.shared = n;
      if (BOOK_ROUTE.test(s)) out.book = true;
      if (s === 'Price') out.order = true;
    }
    if (n.type === 'Identifier' && sharedConsts.has(n.name) && !out.shared) out.shared = n;
    if (n.type === 'Property' && !n.computed && (n.key?.name ?? n.key?.value) === 'price') out.order = true;
    if (n.type === 'CallExpression') {
      const name = calleeName(n);
      if (name && n.callee.type === 'Identifier') out.calls.add(name);
      if (name && BOOK_NAME.test(name)) out.book = true;
      if (name && ORDER_NAME.test(name)) out.order = true;
    }
    for (const k in n) {
      if (k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((x) => walk(x, false));
      else if (v && typeof v.type === 'string') walk(v, false);
    }
  };
  walk(root, true);
  return out;
}

const noSharedMarketOnBook = {
  meta: { type: 'problem', docs: { description: 'A journey step that prices off a book owns its market: ownSpotMarket().' } },
  create(context) {
    const file = String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/');
    if (!JOURNEY.test(file)) return {};
    const sharedConsts = new Set();
    const locals = new Map();
    const steps = [];
    return {
      Program(program) {
        for (const st of program.body) {
          const decl = st.type === 'ExportNamedDeclaration' ? st.declaration : st;
          if (decl?.type === 'VariableDeclaration') {
            for (const d of decl.declarations) {
              if (d.id?.type !== 'Identifier' || !d.init) continue;
              if (strings(d.init).some((s) => SHARED.test(s))) sharedConsts.add(d.id.name);
              else if (isFn(d.init)) locals.set(d.id.name, d.init);
            }
          } else if (decl?.type === 'FunctionDeclaration' && decl.id) locals.set(decl.id.name, decl);
        }
      },
      CallExpression(node) {
        const c = node.callee;
        const isTest =
          (c?.type === 'Identifier' && c.name === 'test') ||
          (c?.type === 'MemberExpression' &&
            c.object?.type === 'Identifier' &&
            c.object.name === 'test' &&
            ['only', 'skip', 'fixme', 'fail'].includes(c.property?.name));
        const fn = node.arguments.find(isFn);
        // A step whose own words name the market ("opens /trade/spot/BTC-USDC", J-cex-spot-01 #5) trades it on purpose.
        const title = node.arguments[0] ? strings(node.arguments[0]).join('') : '';
        if (isTest && fn && !NAMED.test(title)) steps.push(fn);
      },
      'Program:exit'() {
        const facts = new Map();
        const factsOf = (name, seen = new Set()) => {
          if (facts.has(name)) return facts.get(name);
          if (seen.has(name) || !locals.has(name)) return { shared: false, book: false, order: false };
          seen.add(name);
          const s = scan(locals.get(name), sharedConsts);
          const f = { shared: !!s.shared, book: s.book, order: s.order };
          for (const callee of s.calls) {
            const g = factsOf(callee, seen);
            f.shared ||= g.shared;
            f.book ||= g.book;
            f.order ||= g.order;
          }
          facts.set(name, f);
          return f;
        };
        for (const fn of steps) {
          const s = scan(fn, sharedConsts);
          let shared = s.shared;
          let book = s.book;
          let order = s.order;
          let via = null;
          for (const callee of s.calls) {
            const g = factsOf(callee);
            if (g.book) book = true;
            if (g.order) order = true;
            if (g.shared && !shared) via = callee;
          }
          if (!book || !order || (!shared && !via)) continue;
          context.report({
            node: shared ?? fn,
            message:
              `this step reads a book on a shared market${via ? ` (through ${via}())` : ''}, which other journeys trade, so ` +
              'what they leave resting decides what this step meets: price on a market of its own, ' +
              "`const market = await ownSpotMarket(J, '<prefix>', '<tag>')` from ./own-market.mjs, as J-cex-spot-02 #7 does",
          });
        }
      },
    };
  },
};

export const sharedMarketRules = { 'no-shared-market-on-book': noSharedMarketOnBook };
