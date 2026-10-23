import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Customer copy states why something is unavailable, in the present tense. It never promises that it will be later
 * ("isn't connected yet", "coming soon", "for now", "once it is"). A refusal names the real cause instead.
 *
 * This reads every copy catalogue outside the Trade and merchant-portal lanes (they have their own checks) and fails on
 * a promise phrase. A line is allowed only when it states a fact about a record or a request, not about a feature, and
 * each allowed phrase below says why.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));

const PROMISES: RegExp[] = [
  // English: "isn't connected yet", "coming soon", "for now", "once it is".
  /\b(?:not|isn['’]t|aren['’]t|cannot|can['’]t)\b[^.]{0,60}\byet\b/i,
  /coming soon/i,
  /\bonce it is\b/i,
  /\bfor now\b/i,
  // English: "There is no store app yet", "No card issuer is connected yet", "doesn't let customers … yet".
  /\bthere (?:is|are) no\b[^.]{0,60}\byet\b/i,
  /\b(?:doesn['’]t|don['’]t|hasn['’]t|haven['’]t|won['’]t)\b[^.]{0,60}\byet\b/i,
  /\b(?:no|none)\b[^.]{0,60}\b(?:connected|service|issuer|partner|provider|available|way|lookup|switched|set up|supported)\b[^.]{0,40}\byet\b/i,
  /\b(?:no|none)\b[^.]{0,60}\b(?:can|could|may|market|exists?)\b[^.]{0,40}\byet\b/i,
  // English: "once custody is connected", "until one is", "until the minimum is published".
  /\bonce\b[^.]{0,40}\b(?:is|are)\s+(?:connected|published|switched on|available|activated)\b/i,
  /\buntil\b[^.]{0,60}\b(?:connected|published|available|activated|activation|configured|supplied)\b/i,
  /\buntil (?:one|then) (?:is|are)\b/i,
  // Spanish: "aún no está conectado", "hasta que se active", "hasta entonces". "Aún no hay …" and "Todavía no tienes …" are empty states.
  /\b(?:aún|todavía) no (?!tienes?\b|has\b|ha\b|se ha\b|hemos\b|hay (?!ning[úu]n (?:proveedor|socio|emisor)|ninguno|ninguna (?:red|vía)|forma|un |una ))/i,
  /\b(?:aún|todavía) no tiene (?:un|una) (?:servicio|consulta)/i,
  /\bhasta que [^.]{0,40}\b(?:active|conecte|publique|configure)\b/i,
  /\bhasta entonces\b/i,
  /\bhasta que (?:se |lo |la |los |las )?(?:esté|estén|conect|public|activ|configur|abra|proporcion)/i,
  // French: "pas encore connecté", "une fois la conservation connectée", "d'ici là". Empty states ("… pour l'instant") pass.
  /\bpas encore\b(?!\s+(?:choisi|créé))(?!\s+de (?!service|consultation|\p{L}+er\b))(?!\s+d[’'](?!\p{L}+er\b))/iu,
  /\bune fois (?:que )?(?:la |le |l[’'])?[^.]{0,40}\b(?:connect|activ|configur)/i,
  /\bd[’']ici là\b/i,
  /\btant que\b[^.]{0,60}\b(?:connect|publi|activ|configur|disponible|fournis|nommé)/i,
];

/** Other lanes: Trade, and the merchant portal and merchant rooms of Pay. */
const OTHER_LANES = [
  `${sep}screens${sep}trade${sep}`,
  `${sep}features${sep}trade${sep}`,
  `${sep}features${sep}pay${sep}portal${sep}`,
  `${sep}features${sep}pay${sep}merchant`,
];

/** Phrases that state where one record or one request stands today. Each one names a thing the customer can see change. */
const FACTS: Array<[phrase: string, why: string]> = [
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
];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === 'node_modules' || name === 'vendor' ? [] : walk(path)) : [path];
  });

const isCopyFile = (path: string): boolean => {
  const rel = relative(SRC, path);
  if (!/\.tsx?$/.test(rel) || /\.test\.tsx?$/.test(rel)) return false;
  if (OTHER_LANES.some((lane) => `${sep}${rel}`.includes(lane))) return false;
  return /copy[^/\\]*\.tsx?$/i.test(rel) || ['data/refusals.ts', 'app/feature-registry.ts'].includes(rel.split(sep).join('/'));
};

const files = walk(SRC).filter(isCopyFile);

/** The line with every allowed phrase cut out, so a second promise on the same line still counts. */
const withoutFacts = (line: string): string => FACTS.reduce((rest, [phrase]) => rest.split(phrase).join(' '), line);

const promisesIn = (text: string): string[] =>
  text
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .flatMap(({ line, number }) => {
      const rest = withoutFacts(line);
      return PROMISES.flatMap((pattern) => {
        const hit = pattern.exec(rest);
        return hit ? [`${number}: “${hit[0]}” in ${line.trim().slice(0, 140)}`] : [];
      });
    });

describe('customer copy never promises a later capability', () => {
  it('reads the copy catalogues outside the Trade and merchant-portal lanes', () => {
    const rels = files.map((file) => relative(SRC, file).split(sep).join('/'));
    expect(files.length).toBeGreaterThan(40);
    expect(rels).toContain('data/refusals.ts');
    expect(rels).toContain('app/app-copy.ts');
    expect(rels).toContain('app/feature-registry.ts');
    expect(
      rels.some((rel) => rel.startsWith('screens/trade/') || rel.startsWith('features/trade/') || rel.startsWith('features/pay/portal/')),
    ).toBe(false);
  }, 30_000); // reads ~90 files; CI runs many suites at once

  it('has no "not … yet", "coming soon", "once it is" or "for now" outside the stated facts', () => {
    const found = files.flatMap((file) => promisesIn(readFileSync(file, 'utf8')).map((hit) => `${relative(SRC, file)}:${hit}`));
    expect(found).toEqual([]);
  }, 30_000); // reads ~90 files; CI runs many suites at once

  it('catches a reintroduced promise', () => {
    for (const bad of [
      "  body: 'Sale subscriptions cannot be read yet, so nothing is counted.',",
      "  body: 'Bill pay isn’t connected yet',",
      "  body: 'Coming soon',",
      "  body: 'These are the steps you will see once it is.',",
      "  body: 'That balance is locked for now.',",
      "  appNoneTitle: 'There is no store app yet',",
      "  blockNone: 'No card issuer is connected yet, so cards cannot be ordered.',",
      "  workerRegisterReason: 'The pool doesn’t let customers register a worker yet.',",
      "  assessmentReason: 'Academy has no assessment service yet.',",
      "  pendingBody: 'Deposits on their way will show here once custody is connected.',",
      "  addReason: 'Nothing is charged and no rate is shown until one is.',",
      "  inactive: 'Payout is unavailable until an eligible live rail is connected.',",
      "  blockNone: 'Todavía no hay un emisor de tarjetas conectado.',",
      "  fReason: 'Enviar dinero fuera de INTAFACED aún no está conectado.',",
      "  warning2: 'El mínimo se mostrará aquí hasta entonces.',",
      "  blockNone: 'Aucun émetteur n’est connecté pour le moment : pas encore disponible.',",
      "  addressBlocked: 'Une adresse ne peut être affichée qu’une fois la conservation connectée. D’ici là, rien.',",
    ])
      expect(promisesIn(bad), bad).not.toHaveLength(0);
    // The allowed phrase is cut out of the line, so a second promise beside it still fails.
    expect(promisesIn("  a: 'Not chosen yet. Bill pay isn’t connected yet.',")).toHaveLength(1);
    expect(promisesIn("  a: 'Not chosen yet',")).toEqual([]);
    expect(promisesIn("  empty: 'No trades yet',")).toEqual([]);
  }, 30_000); // reads ~90 files; CI runs many suites at once

  it('keeps every allowed phrase in use, so the list cannot go stale', () => {
    const all = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    for (const [phrase] of FACTS) expect(all, phrase).toContain(phrase);
  }, 30_000); // reads ~90 files; CI runs many suites at once
});
