// The TEST partner bank keeps each person's start across a svc-bank restart, as an outside bank would.
//
// svc-bank's TEST partner (services/svc-bank/src/partner/test-partner.ts) keeps its book in the process, so a restart
// of svc-bank emptied it: every person's switches went back off and their TEST pay-ins were gone. A journey that
// restarted svc-bank to blank an owner value then read "0 USDT" where it had paid in 100 (#8392 `0822ed95`, J-bank-01
// #3 and #7), unless it knew to put the start back. Now every `testPartner.set` and `testPartner.fund` a journey file
// sends from Node, through any helper, is noted in order, and after its svc-bank restarts they are sent again, in the
// same order and as the same person, before the file's next request. A fund id pays in once per svc-bank process, so a
// journey that puts its own start back with the same fund id changes nothing. Moves made at the partner since are not
// sent again: what comes back is the start, as each person set and paid it in.
//
// Each file's notes are its own (`partnerFile`); a restart through `tool` or `toolAwaited` (stack.mjs) marks them due.

const START = /\/api\/bank\/trpc\/testPartner\.(set|fund)(\?|$)/;
const LOGIN = /\/api\/identity\/trpc\/auth\.login(\?|$)/;

let file = null;
/** This file's starts, oldest first: { url, init, token }. */
let starts = [];
/** The sign-in each access token came from, so a start is sent again on a fresh session after the token has expired. */
let logins = new Map();
let restarts = 0;
let restored = 0;

const headerOf = (init, name) => {
  const h = init?.headers;
  if (!h) return undefined;
  if (typeof h.get === 'function') return h.get(name) ?? undefined;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name);
  return key ? h[key] : undefined;
};
const tokenOf = (init) => /^Bearer (.+)$/.exec(headerOf(init, 'authorization') ?? '')?.[1];
const urlOf = (input) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url);

/** The journey file now running: a new file starts with no notes. */
export function partnerFile(name) {
  if (name === file) return;
  file = name;
  starts = [];
  logins = new Map();
  restored = restarts;
}

/** A stack tool call (stack.mjs `tool`): a restart or start that takes svc-bank down and up marks the starts due. */
export function noteStackTool(script, args) {
  // Matched, not quoted: this helper only reads the call it is shown and runs no stack tool (journey-world.mjs).
  if (!/^local-test-stack\.mjs$/.test(script)) return;
  const [verb, ...rest] = args;
  if (verb === 'restart' && rest.includes('bank')) restarts += 1;
  else if (verb === 'start' && (rest.length === 0 || rest.includes('bank'))) restarts += 1;
}

/** Whether a restart has emptied the TEST partner since this file's starts were last sent. */
export const partnerDue = () => restarts !== restored && starts.length > 0;

/** After the response: a start the partner took is noted, and a sign-in's token is tied to the body that made it. */
export async function noteResponse(input, init, res) {
  const url = urlOf(input);
  if (typeof url !== 'string' || !res?.ok || typeof init?.body !== 'string') return;
  if (START.test(url)) {
    starts.push({ url, init: { ...init }, token: tokenOf(init) });
    return;
  }
  if (LOGIN.test(url)) {
    try {
      const token = (await res.clone().json())?.result?.data?.accessToken;
      if (token) logins.set(token, { url, init: { ...init } });
    } catch {
      /* a sign-in whose answer is not JSON made no session */
    }
  }
}

let restoring = null;
/** Before a request: the starts sent again first when a restart has emptied the partner, else nothing to wait for. */
export function beforeRequest(send) {
  if (!partnerDue()) return null;
  restoring ??= restorePartner(send).finally(() => {
    restoring = null;
  });
  return restoring;
}

/**
 * Sends this file's starts again after a svc-bank restart, before its next request. A start goes on a fresh sign-in
 * when the one it was sent on is known, else on its own token. One the partner refuses stops the test in one line.
 */
export async function restorePartner(send) {
  restored = restarts;
  const fresh = new Map();
  for (const start of starts) {
    let token = start.token;
    const login = token && logins.get(token);
    if (login) {
      if (!fresh.has(token)) {
        const res = await send(login.url, login.init).catch(() => null);
        const body = res?.ok ? await res.json().catch(() => null) : null;
        fresh.set(token, body?.result?.data?.accessToken ?? token);
      }
      token = fresh.get(token);
    }
    const headers = {
      ...Object.fromEntries(new Headers(start.init.headers ?? {})),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
    const res = await send(start.url, { ...start.init, headers });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(
        `svc-bank restarted and the TEST partner's start was not put back (${new URL(start.url).pathname.split('/').pop()} -> HTTP ${res.status} ${text}); send testPartner.set and testPartner.fund again after the restart`,
      );
    }
  }
}
