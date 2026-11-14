// Copy and screen rules that used to be unit tests reading source text. Each keeps the scope and word list of the test it
// replaced (named on each rule), and reads the file as that test did, line by line, so it reports what the test failed on.
// Scopes are decided here, from the path, because two of them need a file-name filter and a lane exclusion that an
// `overrides` glob cannot say; the plugin's own tests pin each scope.

/** The path below the repo root, with forward slashes (`apps/customer/src/...`), or null outside an app. */
const repoPath = (context) => {
  const file = String(context.filename ?? context.getFilename())
    .split('\\')
    .join('/');
  const i = file.lastIndexOf('/apps/');
  return i >= 0 ? file.slice(i + 1) : null;
};
const CUSTOMER = 'apps/customer/src/';
const TEST_TS = /\.test\.tsx?$/u;

/** The file's lines with every comment blanked (lines kept), so a word in a comment is not copy. */
function codeLines(sourceCode) {
  let text = sourceCode.text;
  for (const c of sourceCode.getAllComments()) {
    const [from, to] = c.range;
    text = text.slice(0, from) + text.slice(from, to).replace(/[^\n]/gu, ' ') + text.slice(to);
  }
  return text.split('\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// garden/no-promise-copy: two word lists, one per scope, as the two tests had them.
//
// (a) Trade lane, every non-test .ts/.tsx file (was apps/customer/src/screens/trade/copy-no-yet.test.ts).
const TRADE_LANE = [
  'apps/customer/src/screens/trade/',
  'apps/customer/src/features/trade/',
  'apps/admin/src/components/trade-ops/',
  'apps/admin/src/lib/trade-ops/',
  'apps/admin/src/app/(console)/trade-ops/',
  'apps/admin/src/app/api/trade-ops/',
];
const TRADE_BANNED = /\byet\b|\bcoming soon\b|\bsoon\b|check back|stay tuned|\b(?:later|future) (?:release|version|update)\b/iu;

// (b) Customer copy catalogues outside the Trade and merchant lanes (was apps/customer/src/shared/copy-promises.test.ts).
const PROMISES = [
  /\b(?:not|isn['’]t|aren['’]t|cannot|can['’]t)\b[^.]{0,60}\byet\b/i,
  /coming soon/i,
  /\bonce it is\b/i,
  /\bfor now\b/i,
  /\bthere (?:is|are) no\b[^.]{0,60}\byet\b/i,
  /\b(?:doesn['’]t|don['’]t|hasn['’]t|haven['’]t|won['’]t)\b[^.]{0,60}\byet\b/i,
  /\b(?:no|none)\b[^.]{0,60}\b(?:connected|service|issuer|partner|provider|available|way|lookup|switched|set up|supported)\b[^.]{0,40}\byet\b/i,
  /\b(?:no|none)\b[^.]{0,60}\b(?:can|could|may|market|exists?)\b[^.]{0,40}\byet\b/i,
  /\bonce\b[^.]{0,40}\b(?:is|are)\s+(?:connected|published|switched on|available|activated)\b/i,
  /\buntil\b[^.]{0,60}\b(?:connected|published|available|activated|activation|configured|supplied)\b/i,
  /\buntil (?:one|then) (?:is|are)\b/i,
  /\b(?:aún|todavía) no (?!tienes?\b|has\b|ha\b|se ha\b|hemos\b|hay (?!ning[úu]n (?:proveedor|socio|emisor)|ninguno|ninguna (?:red|vía)|forma|un |una ))/i,
  /\b(?:aún|todavía) no tiene (?:un|una) (?:servicio|consulta)/i,
  /\bhasta que [^.]{0,40}\b(?:active|conecte|publique|configure)\b/i,
  /\bhasta entonces\b/i,
  /\bhasta que (?:se |lo |la |los |las )?(?:esté|estén|conect|public|activ|configur|abra|proporcion)/i,
  /\bpas encore\b(?!\s+(?:choisi|créé))(?!\s+de (?!service|consultation|\p{L}+er\b))(?!\s+d[’'](?!\p{L}+er\b))/iu,
  /\bune fois (?:que )?(?:la |le |l[’'])?[^.]{0,40}\b(?:connect|activ|configur)/i,
  /\bd[’']ici là\b/i,
  /\btant que\b[^.]{0,60}\b(?:connect|publi|activ|configur|disponible|fournis|nommé)/i,
];
const OTHER_LANES = ['/screens/trade/', '/features/trade/', '/features/pay/portal/', '/features/pay/merchant'];
/** Phrases that state where one record or one request stands today; each is cut out of its line before the check. */
const FACTS = [
  ['Not signed out yet. Reloading would sign you back in.', 'the session is still active; says what a reload does'],
  ['Not chosen yet', 'the customer has not picked a value in this form'],
  ['You have not used an agent yet.', 'an empty list of the customer’s own sessions'],
  ['You do not hold any asset yet', 'an empty balance, with the step to fix it'],
  ['You have not sent us a request yet', 'an empty list of the customer’s own requests'],
  ['You can rate a request once it is resolved or closed.', 'a rule about the request’s status, not a feature'],
  ['Saved, but not confirmed yet.', 'one address has not been confirmed by its owner'],
  ['Not confirmed yet', 'one value has not been confirmed'],
  ['No assets you can spend yet', 'an empty list of assets the customer holds'],
  ['You don’t own any assets yet.', 'an empty portfolio'],
  ['You don’t hold anything yet.', 'an empty balance'],
  ['You haven’t made a request in this browser yet.', 'an empty list of the customer’s own requests'],
  ['Aún no se cerró la sesión.', 'Spanish of the allowed “Not signed out yet” line'],
  ['Vous n’êtes pas encore déconnecté.', 'French of the allowed “Not signed out yet” line'],
  ['Aún no se te ha pagado ningún crédito', 'Spanish: an empty payout list'],
  ['Ne l’enregistrez pas encore une deuxième fois.', 'French of the allowed “Do not save it again yet”'],
  ['Tu n’as pas encore de worker', 'French: an empty worker list'],
  ['Do not save it again yet.', 'an instruction while a duplicate check runs'],
  ['Bot policy: not yet published', 'a journey step’s own words: the owner’s policy has no text, and the page shows it once it has'],
];
const withoutFacts = (line) => FACTS.reduce((rest, [phrase]) => rest.split(phrase).join(' '), line);

/** Which word list applies to a repo path: 'trade', 'catalogue' or null. */
export function promiseScope(path) {
  if (!path || !/\.tsx?$/u.test(path) || TEST_TS.test(path)) return null;
  if (TRADE_LANE.some((root) => path.startsWith(root))) return 'trade';
  if (!path.startsWith(CUSTOMER)) return null;
  const rel = path.slice(CUSTOMER.length);
  if (OTHER_LANES.some((lane) => `/${rel}`.includes(lane))) return null;
  if (/copy[^/\\]*\.tsx?$/iu.test(rel) || rel === 'data/refusals.ts' || rel === 'app/feature-registry.ts') return 'catalogue';
  return null;
}

/** The promise phrases on one line of a catalogue (comment lines skipped, allowed facts cut out). */
export function cataloguePromises(line) {
  if (/^\s*(\/\/|\/\*|\*)/u.test(line)) return [];
  const rest = withoutFacts(line);
  return PROMISES.flatMap((p) => {
    const m = p.exec(rest);
    return m ? [m[0]] : [];
  });
}

const noPromiseCopy = {
  meta: { type: 'problem', docs: { description: 'Copy says what is true now and what blocks it; it never promises later.' } },
  create(context) {
    const scope = promiseScope(repoPath(context));
    if (!scope) return {};
    return {
      Program() {
        const sc = context.sourceCode;
        if (scope === 'trade') {
          codeLines(sc).forEach((line, i) => {
            const m = TRADE_BANNED.exec(line);
            if (m)
              context.report({
                loc: { start: { line: i + 1, column: m.index }, end: { line: i + 1, column: m.index + m[0].length } },
                message: `promise word “${m[0]}” in Trade copy: say what is true now and what blocks it (no "yet", "soon", "check back")`,
              });
          });
          return;
        }
        sc.text.split('\n').forEach((line, i) => {
          const hits = cataloguePromises(line);
          if (hits.length)
            context.report({
              loc: { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: line.length } },
              message: `copy promises a later capability (“${hits.join('”, “')}”): state why it is unavailable now, in the present tense`,
            });
        });
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// garden/pay-portal-copy: the merchant portal's English catalogues use plain business words
// (was the "uses no engineer words" part of apps/customer/src/features/pay/portal/copy-lint.test.ts).
const PORTAL = 'apps/customer/src/features/pay/portal/';
const PORTAL_BANNED = [
  ['a work-package code', /\bW\d+[a-z]?\d?\b/u],
  ['"backend"', /\bback-?end\b/iu],
  ['"stub"', /\bstubs?\b/iu],
  ['"cursor"', /\bcursors?\b/iu],
  ['"server"', /\bservers?\b/iu],
  ['"contract"', /\bcontracts?\b/iu],
  ['"loaded"', /\bloaded\b/iu],
  ['"procedure"', /\bprocedures?\b/iu],
  ['"projection"', /\bprojections?\b/iu],
  ['"fixture"', /\bfixtures?\b/iu],
  ['"arrives"', /\barrives?\b/iu],
  ['"coming soon"', /\bcoming soon\b/iu],
  [
    'a promise of later ("not connected yet", "available yet", "on the way", "soon"): say what is true now and what blocks it',
    /\b(not connected yet|available yet|on the way|coming soon|soon)\b/iu,
  ],
  ['a promise of what the person will be able to do, or a request to come back', /you(?:’|')ll be able to|check back later/iu],
  ['"soon" as a promise', /\b(?:available|here|open|live) soon\b/iu],
  [
    'a setting described as a future ("has not set … yet", "not set up yet", "no tier yet"): say what is true now',
    /\b(?:INTAFACED|we)\s+(?:has|have)\s+not\b[^.]*\byet\b|\bset(?!\s+aside)(?:\s+up)?\b[^.]*\byet\b|\bno tier yet\b|\b(?:switched on|published|configured)\b[^.]*\byet\b/iu,
  ],
  ['a snake_case word', /\b[a-z]+(?:_[a-z0-9]+)+\b/u],
  ['a service code', /\bpay\.[a-z_]+/u],
];
/** The engineer words in one portal message (placeholders like `{n}` are not words). */
export function portalWords(text) {
  const words = text.replace(/\{[A-Za-z]+\}/gu, '');
  return PORTAL_BANNED.filter(([, p]) => p.test(words)).map(([name]) => name);
}
export const isPortalCatalogue = (path) => !!path && path.startsWith(PORTAL) && path.endsWith('copy.ts') && !TEST_TS.test(path);

/** A string the code fixes at build time (literal, template without values, or `+` of those), else null. */
function staticString(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('');
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const a = staticString(node.left);
    const b = staticString(node.right);
    return a !== null && b !== null ? a + b : null;
  }
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'ParenthesizedExpression')
    return staticString(node.expression);
  return null;
}
const unwrap = (n) => (n && (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression') ? unwrap(n.expression) : n);

const payPortalCopy = {
  meta: { type: 'problem', docs: { description: 'Merchant portal copy is plain business English.' } },
  create(context) {
    if (!isPortalCatalogue(repoPath(context))) return {};
    return {
      VariableDeclarator(node) {
        if (node.id?.type !== 'Identifier' || node.id.name !== 'en') return;
        const obj = unwrap(node.init);
        if (obj?.type !== 'ObjectExpression') return;
        for (const prop of obj.properties) {
          if (prop.type !== 'Property') continue;
          const text = staticString(prop.value);
          if (text === null) {
            context.report({
              node: prop.value,
              message: 'portal copy value is not a fixed string: write the words out so they can be read',
            });
            continue;
          }
          const found = portalWords(text);
          if (found.length)
            context.report({
              node: prop.value,
              message: `merchant portal copy has ${found.join('; ')}: write plain business English (what happened, why, what to do next)`,
            });
        }
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// garden/no-hand-schema: customer files take service response types from @intafaced/contracts
// (was apps/customer/src/shared/no-new-hand-schemas.test.ts, which judged only the files a branch added).
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:'"`])\/\/.*$/gmu, '$1');
const DECLARES = /\bz\s*\.\s*(object|discriminatedUnion)\s*\(/u;
const CALLS_API = /\.(query|mutate|rest|scopedRest|plain)\s*(<[^>]*>)?\(|\bApiClient\b|\bApiResult\b|shared\/api['"]/u;
const NAMED_AS_API_FILE = /(^|[-./])(schemas?|api)\.tsx?$/u;
const FROM_CONTRACTS = /from\s+['"]@intafaced\/contracts(\/[a-z0-9-]+)?['"]/u;
const SCHEMA_EXEMPT = /hand-declared-ok:[ \t]*\S[^\n]{8,}/u;

/** The reason a customer file hand-declares a service response schema, or null when it is fine. */
export function handSchemaProblem(path, text) {
  if (!path || !path.startsWith(CUSTOMER) || !/\.tsx?$/u.test(path) || /\.d\.ts$|\.test\.tsx?$|\.spec\.tsx?$|__fixtures__\//u.test(path))
    return null;
  if (SCHEMA_EXEMPT.test(text)) return null;
  const code = stripComments(text);
  if (!DECLARES.test(code)) return null;
  if (!(CALLS_API.test(code) || NAMED_AS_API_FILE.test(path))) return null;
  if (FROM_CONTRACTS.test(code)) return null;
  return 'declares z.object schemas for a service answer without importing from @intafaced/contracts';
}

const noHandSchema = {
  meta: { type: 'problem', docs: { description: 'Service response schemas come from @intafaced/contracts.' } },
  create(context) {
    const path = repoPath(context);
    if (!path || !path.startsWith(CUSTOMER)) return {};
    return {
      Program() {
        const text = context.sourceCode.text;
        if (!handSchemaProblem(path, text)) return;
        const line = text.slice(0, Math.max(0, text.search(DECLARES))).split('\n').length;
        context.report({
          loc: { start: { line, column: 0 }, end: { line, column: 1 } },
          message:
            'this file declares a service response schema by hand: import the schema from @intafaced/contracts and narrow it, ' +
            'or, if the service has none that is browser-safe, add `// hand-declared-ok: <what is missing>`',
        });
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// garden/no-screen-literal: screen files take their words from a copy catalogue (Text, t() or defineCopy)
// (was apps/customer/src/shared/no-new-screen-literals.test.ts, which judged only the files a branch added).
const SCREENS = 'apps/customer/src/screens/';
const LITERAL_EXEMPT = /literal-text-ok:[ \t]*\S[^\n]{8,}/u;
const INLINE_TEXT = /(?<![=-])>([^<>{}=;()?:&|]{1,400})<(?=\/|[A-Za-z])/gu;
const STRING_CHILD = /(?<=>)\s*\{\s*(['"`])([^'"`\n]{1,300})\1\s*\}/gu;
const ATTRIBUTE =
  /\b(?:aria-label|title|placeholder|alt|aria-description|aria-placeholder)=(?:(["'])([^"'\n]{1,300})\1|\{\s*(["'`])([^"'`$\n]{1,300})\3\s*\})/gu;
const TEXT_LINE =
  /^\s*(?!(?:import|export|const|let|var|return|function|type|interface|async|await|else|case|default|break|continue|throw|new|class|extends|if|for|while|switch|try|catch|finally|declare|enum|namespace|as|of|in|void|typeof)\b)\p{L}[\p{L}\p{N}]*(?:[ \t]+[\p{L}\p{N}.,!'’\-–—%]+){1,60}[ \t]*$/u;
const WORD = /\p{L}{2,}/u;

/** The typed-in words a screen file renders outside a catalogue, as [line, text], or none. */
export function screenLiterals(path, text) {
  if (!path || !path.startsWith(SCREENS) || !path.endsWith('.tsx') || /\.test\.tsx$|\.spec\.tsx$|__fixtures__\//u.test(path)) return [];
  if (LITERAL_EXEMPT.test(text)) return [];
  const code = stripComments(text);
  const starts = [0];
  for (let at = code.indexOf('\n'); at !== -1; at = code.indexOf('\n', at + 1)) starts.push(at + 1);
  const lineOf = (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const found = new Map();
  const note = (index, value) => {
    if (!WORD.test(value)) return;
    const line = lineOf(index);
    if (!found.has(line)) found.set(line, value.trim().replace(/\s+/gu, ' ').slice(0, 60));
  };
  for (const m of code.matchAll(INLINE_TEXT)) {
    const words = m[1];
    if (WORD.test(words)) note(m.index + 1 + (words.length - words.trimStart().length), words);
  }
  for (const m of code.matchAll(STRING_CHILD)) note(m.index, m[2]);
  for (const m of code.matchAll(ATTRIBUTE)) note(m.index, m[2] ?? m[4]);
  code.split('\n').forEach((line, i) => {
    if (line.length <= 400 && TEXT_LINE.test(line)) note(starts[i], line);
  });
  return [...found].sort(([a], [b]) => a - b);
}

const noScreenLiteral = {
  meta: { type: 'problem', docs: { description: 'Screens take their words from a copy catalogue.' } },
  create(context) {
    const path = repoPath(context);
    if (!path || !path.startsWith(SCREENS)) return {};
    return {
      Program() {
        // Comment stripping keeps line breaks only for block comments that hold none; line numbers are read from the stripped
        // text, as the test did, so map them back by finding the words on the original lines when they drift.
        const text = context.sourceCode.text;
        const lines = text.split('\n');
        for (const [line, value] of screenLiterals(path, text)) {
          const probe = value.slice(0, 20);
          let at = line;
          if (!(lines[at - 1] ?? '').includes(probe)) {
            const i = lines.findIndex((l, n) => n >= line - 1 && l.includes(probe));
            if (i >= 0) at = i + 1;
          }
          context.report({
            loc: { start: { line: at, column: 0 }, end: { line: at, column: (lines[at - 1] ?? '').length } },
            message: `words typed into the screen (“${value}”): move them to a copy catalogue (Text, t() or defineCopy), or add \`// literal-text-ok: <why this is not a sentence>\``,
          });
        }
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// garden/own-gap-wording: in the shell, Home, notifications, public and Web3 copy, our own missing back end is never
// "not connected" (was apps/customer/src/shared/own-gap-wording.test.ts; its list of known lines is now a suppression with
// its reason on each line, so a reworded line leaves an unused suppression behind).
const OWN_GAP_FOLDERS = ['app/', 'screens/home/', 'screens/notifications/', 'features/public/', 'features/protocol/'].map(
  (f) => CUSTOMER + f,
);
const WORDING =
  /\b(?:is|are) not connected\b|\bisn[’']t connected\b|\bnot connected (?:here|on this platform|in this build)\b|\bis connected\b/iu;
const ENTRY = /^ {2}(?:(['"])((?:\\.|(?!\1).)+)\1|([\w.]+)):\s*\n?\s*(['"`])((?:\\.|(?!\4)[\s\S])*?)\4/gmu;

export const isOwnGapFile = (path) =>
  !!path && OWN_GAP_FOLDERS.some((f) => path.startsWith(f)) && path.endsWith('copy.ts') && !path.includes('.test.');

/** Every entry (`key: 'text'`) whose text uses own-gap "connected" wording, as { key, index }. */
export function ownGapEntries(text) {
  const out = [];
  for (const m of text.matchAll(ENTRY)) {
    if (WORDING.test(m[5].replace(/\\(.)/gu, '$1'))) out.push({ key: m[2] ?? m[3], index: m.index });
  }
  return out;
}

const ownGapWording = {
  meta: { type: 'problem', docs: { description: 'Our own missing back end is not "not connected".' } },
  create(context) {
    if (!isOwnGapFile(repoPath(context))) return {};
    return {
      Program() {
        const text = context.sourceCode.text;
        for (const { key, index } of ownGapEntries(text)) {
          const line = text.slice(0, index).split('\n').length;
          context.report({
            loc: { start: { line, column: 2 }, end: { line, column: 2 + key.length } },
            message: `“${key}” says "not connected" about our own gap: "connected" is for an outside dependency (ServiceOffNotice); say what is not served or not built`,
          });
        }
      },
    };
  },
};

export const copyRules = {
  'no-promise-copy': noPromiseCopy,
  'pay-portal-copy': payPortalCopy,
  'no-hand-schema': noHandSchema,
  'no-screen-literal': noScreenLiteral,
  'own-gap-wording': ownGapWording,
};
