/**
 * INTAFACED — the sovereign platform client.
 * ----------------------------------------------------------------------------
 * Everything our own services expose reaches the browser through ONE door:
 * svc-edge. Nothing here names a service port, and nothing here talks to a
 * service directly — the dev-server proxy maps `/api/*` onto the edge (see
 * ../../config/index.js), and the edge owns the route table. An unlisted
 * prefix 404s there rather than falling through to the internal network.
 *
 * The services speak tRPC over HTTP. The wire shape is fixed and small:
 *
 *   query     GET  /api/<module>/trpc/<procedure>?input=<url-encoded JSON>
 *   mutation  POST /api/<module>/trpc/<procedure>   body: <JSON input>
 *   success   { "result": { "data": ... } }
 *   failure   { "error": { "message", "data": { "code", "httpStatus", ... } } }
 *
 * ONE EXCEPTION, AND IT IS A CONTRACT NOT A SHORTCUT. svc-trade also publishes
 * a CCXT-shaped REST surface under `/api/v1/*` (svc-edge routes that prefix to
 * the same service with `preservePath: true`). It is not tRPC: the body IS the
 * answer, and a failure is `{ code: <CcxtErrorCode>, message, intafacedCode }`
 * at the top level. `rest()` below speaks it, and `classify` reads both shapes,
 * so the screens keep exactly one client and exactly one failure taxonomy.
 *
 * WHY `fetch` AND NOT `this.$http`. main.js sets `Vue.http.options.emulateJSON`
 * globally, which form-encodes every POST body. tRPC needs a JSON body, and
 * main.js is owned elsewhere, so these calls use the platform's own transport
 * rather than quietly breaking the vendor's.
 *
 * Money never becomes a `number` on this path. Decimal strings arrive as
 * strings and are rendered as strings.
 *
 * WHAT A 200 IS, AND WHAT IT IS NOT. Until `ix-wire.js` existed, this file
 * treated `res.ok && body.result` as proof that the payload was the thing the
 * screen expected, and handed `body.result.data` over unread. A 200 is evidence
 * that a service answered; it is not evidence about what it said. Every call
 * here now takes an OPTIONAL `schema` — a validator from `../assets/js/ix-wire.js`
 * — and a payload that fails it comes back as `INVALID_RESPONSE` naming the
 * field and the rule, rather than as a float in an order form. Opt-in per call
 * site on purpose: a call that has not adopted a schema is exactly as safe as
 * it was before, and visibly not yet better.
 */

import wire from '../assets/js/ix-wire.js';
var authRefusal = require('../assets/js/auth-refusal.js');

/** Every prefix svc-edge's route table actually serves. Longest prefix wins there. */
export const EDGE_BASE = '/api';

/**
 * The failure taxonomy the screens render.
 *
 * A screen that cannot show data must say WHICH of these it hit, because they
 * mean completely different things to whoever reads the page: "sign in" is a
 * user action, "this scope is issued to nobody" is an engineering gap, and
 * "the router is not mounted" is a different engineering gap again. Collapsing
 * them into one "something went wrong" is how a half-built system starts
 * looking finished.
 */
export const REASON = {
    OK: 'ok',
    /** The edge could not be reached at all, or the upstream was down (502). */
    UNREACHABLE: 'unreachable',
    /** svc-edge has no route for this prefix — the module is not behind the front door. */
    NOT_ROUTED: 'not_routed',
    /** The edge routed it, but the service serves no such path — router not mounted. */
    NOT_MOUNTED: 'not_mounted',
    /**
     * There is nothing to call, anywhere — and that is a statement about the
     * platform, not about this request.
     *
     * The three reasons above all describe a call that was MADE and refused, so
     * each of them implies a service that exists. This one is different in kind:
     * the capability has never been built, so no call is issued at all and the
     * screen says so from local knowledge (config/sockets.js).
     *
     * It earns its own value because collapsing it into NOT_ROUTED would be a
     * lie of omission — "the prefix is not in the route table" invites someone
     * to add a route to a service that was never written. The honest sentence is
     * that the product does not exist yet, and the socket row names what would
     * have to be built for it to.
     *
     * It is also deliberately NOT reached by making a request. Calling a URL we
     * already know nothing serves, purely to render its 404, would cost a round
     * trip and would misreport a missing capability as a routing fault.
     *
     * Screens that use it MUST pass a reason to `noSurface()` so the page says
     * WHICH capability is missing and what would have to exist.
     */
    NO_SURFACE: 'no_surface',
    /** No platform session. */
    UNAUTHORIZED: 'unauthorized',
    /** Signed in, but the session does not carry the scope this procedure demands. */
    SCOPE_DENIED: 'scope_denied',
    /** Signed in and scoped, but the jurisdiction matrix wants a verification tier. */
    TIER_REQUIRED: 'tier_required',
    /** Signed in, scoped, and still refused. */
    FORBIDDEN: 'forbidden',
    /**
     * The venue mounts this route on purpose and will not serve it in this
     * shape — CCXT `NotSupported`, HTTP 501. Distinct from NOT_MOUNTED, which
     * is an engineering gap: this one is a deliberate answer and the client
     * should STOP asking. Funding rate on a spot market is the live example.
     */
    NOT_SUPPORTED: 'not_supported',
    /**
     * CCXT `BadSymbol` — the venue lists no such market. Distinct from an empty
     * answer: "BTC/USDT is not listed here" and "BTC/USDT has no orders" are
     * different sentences and only one of them is the reader's problem.
     */
    BAD_SYMBOL: 'bad_symbol',
    /**
     * THE SERVICE ANSWERED, AND THE ANSWER IS NOT THE SHAPE WE CONTRACTED FOR.
     *
     * Every reason above is a refusal — a system saying no, for a reason that
     * belongs to it. This one is the opposite: a 200, a body, and a field that
     * broke a rule the platform depends on. A price as a JSON number, a decimal
     * carrying a nineteenth place the ledger cannot reconcile, a protocol-plane
     * service claiming `custodial: true`.
     *
     * It is NOT `ERROR`. `ERROR` says the service explained itself and the
     * screen is quoting it; this says the service did not know it was wrong, so
     * the sentence has to be written here. `message` therefore names the field
     * and the rule it broke — `tickers.BTC/USDT.last expected an unsigned
     * decimal string, got the JSON number 42.5 …` — because the fault is ours
     * or the service's, never the reader's, and a generic "invalid response"
     * would send someone to read the whole payload by hand.
     *
     * Refusing rather than rendering is the point. The alternative is that the
     * float reaches the order form (`Exchange.vue` seeds the limit price from
     * `ticker.last`) or that a broken deployment gets to publish its own custody
     * claim under our sovereignty copy. Both are the screen telling a lie on
     * behalf of a service that never said it.
     */
    INVALID_RESPONSE: 'invalid_response',
    /** Anything else the service said no to. */
    ERROR: 'error'
};

function buildUrl(module, procedure, input) {
    var url = EDGE_BASE + '/' + module + '/trpc/' + procedure;
    if (input === undefined || input === null) return url;
    return url + '?input=' + encodeURIComponent(JSON.stringify(input));
}

function headers(token) {
    var h = { 'content-type': 'application/json' };
    // The edge exchanges this bearer for a signed principal the services will
    // believe. Without it every scopedProcedure answers UNAUTHORIZED, which is
    // the correct answer and what the screens will show.
    if (token) h['authorization'] = 'Bearer ' + token;
    return h;
}

/**
 * The CCXT error classes svc-trade puts on the wire (`ccxt-errors.ts`), mapped
 * onto our reason taxonomy.
 *
 * A CCXT client branches on the class to decide whether to retry; a SCREEN
 * branches on it to decide what sentence to print. The two questions have the
 * same answer, so the mapping stays here rather than being re-guessed per page.
 *
 * `ExchangeNotAvailable` / `OnMaintenance` are UNREACHABLE on purpose: from a
 * reader's seat "the matching engine is down" and "the edge is down" are the
 * same fact — the venue cannot tell them anything right now — and both are
 * temporary. What must never collapse into them is an EMPTY book, which is a
 * successful answer and never reaches this function.
 */
var CCXT_REASON = {
    AuthenticationError: REASON.UNAUTHORIZED,
    PermissionDenied: REASON.FORBIDDEN,
    BadSymbol: REASON.BAD_SYMBOL,
    NotSupported: REASON.NOT_SUPPORTED,
    ExchangeNotAvailable: REASON.UNREACHABLE,
    OnMaintenance: REASON.UNREACHABLE,
    RateLimitExceeded: REASON.ERROR,
    InsufficientFunds: REASON.ERROR,
    InvalidOrder: REASON.ERROR,
    OrderNotFound: REASON.ERROR,
    OrderNotFillable: REASON.ERROR,
    BadRequest: REASON.ERROR,
    ExchangeError: REASON.ERROR,

    // ── The taxonomy the CURRENTLY DEPLOYED svc-trade still uses ────────────
    //
    // The service in the fleet predates the CCXT error mapping that is on main
    // and answers with its own internal codes: `Unauthorized` rather than
    // `AuthenticationError`, `MarketNotFound` rather than `BadSymbol`,
    // `MatchingUnavailable` rather than `ExchangeNotAvailable`.
    //
    // Both are listed because a screen has to be honest against the service
    // that is actually running, not the one in the source tree. Without these
    // rows every refusal from the live venue would fall through to the generic
    // arm and print "Request failed" instead of the sentence the service
    // actually wrote — which is precisely the collapse this taxonomy exists to
    // prevent. These rows become dead weight the day the fleet catches up, and
    // they are harmless then.
    Unauthorized: REASON.UNAUTHORIZED,
    Forbidden: REASON.FORBIDDEN,
    MarketNotFound: REASON.BAD_SYMBOL,
    MarketNotTradable: REASON.BAD_SYMBOL,
    MatchingUnavailable: REASON.UNREACHABLE,
    MarketClosed: REASON.UNREACHABLE,
    SpotDisabled: REASON.UNREACHABLE,
    InvalidTimeframe: REASON.ERROR,
    InvalidSince: REASON.ERROR,
    NotOwner: REASON.FORBIDDEN
};

/**
 * The tier the refusal named, if it named one.
 *
 * TIER_REQUIRED without the tier is half an answer: "you need to be verified"
 * leaves the reader with no next step, and "you need `full` and you are `basic`"
 * is a link to a form. Both wire shapes carry it — svc-trade's CCXT REST puts
 * `requiredTier` at the top level (`private-rest.ts`), and the tRPC error
 * formatter puts it in `error.data` (`packages/contracts/src/trpc.ts`) — and
 * before this, `classify` READ it to pick the reason and then dropped it, so no
 * screen could ever say which tier.
 */
function tierOf(body, data) {
    if (data && typeof data.requiredTier === 'string' && data.requiredTier) return data.requiredTier;
    if (body && typeof body.requiredTier === 'string' && body.requiredTier) return body.requiredTier;
    return null;
}

function classify(status, body) {
    var data = (body && body.error && body.error.data) || {};
    var code = data.code || '';
    var message = (body && body.error && body.error.message) || 'Request failed';
    var requiredTier = tierOf(body, data);

    if (body && body.code === 'edge.no_route') return { reason: REASON.NOT_ROUTED, message: 'svc-edge has no route for this module' };
    if (body && body.code === 'edge.upstream_unavailable') return { reason: REASON.UNREACHABLE, message: 'The service behind the edge did not answer' };

    // CCXT REST failure (`/api/v1/*`). The class is top-level, not nested in
    // `error`, and `intafacedCode` carries our finer-grained reason — a
    // PermissionDenied from the scope gate and one from the jurisdiction matrix
    // are the same class on the wire and different sentences on the page.
    if (body && typeof body.code === 'string' && CCXT_REASON[body.code]) {
        var ccxtMessage = body.message || 'Request failed';
        var reason = CCXT_REASON[body.code];
        if (body.code === 'PermissionDenied') {
            if (body.intafacedCode === 'scope.denied') reason = REASON.SCOPE_DENIED;
            else if (body.intafacedCode === 'tier.insufficient' || body.requiredTier) reason = REASON.TIER_REQUIRED;
        }
        return { reason: reason, message: ccxtMessage, intafacedCode: body.intafacedCode || null };
    }

    // Fastify's own 404 shape, not tRPC's — the service is up and the path is
    // simply not served, which for our routers means the tRPC plugin was never
    // registered.
    if (status === 404 && body && body.error === 'Not Found') return { reason: REASON.NOT_MOUNTED, message: body.message || 'The service does not serve this path' };

    // tRPC's OWN "this router has no such procedure", which is a different
    // sentence from every other NOT_FOUND it emits.
    //
    // Both arrive as `code: 'NOT_FOUND', httpStatus: 404`: the one below is a
    // deployed service that is older than the router in the source tree, and
    // `resolveLink` answering `pay.link_not_found` is a service that is exactly
    // current and was asked about a link that does not exist. Collapsing them
    // sends a reader to look for a missing payment link when what is missing is
    // half the service, so the discriminator is tRPC's own fixed prefix rather
    // than the code — a business NOT_FOUND never writes that sentence, because
    // tRPC writes it before any resolver runs.
    //
    // NOT_MOUNTED, not NOT_ROUTED: the edge routed it and the service answered.
    // The gap is the router, and that is where somebody has to go and look.
    if (code === 'NOT_FOUND' && /^No procedure found on path/.test(message)) {
      return { reason: REASON.NOT_MOUNTED, message: message };
    }
    if (code === 'UNAUTHORIZED' || status === 401) return { reason: REASON.UNAUTHORIZED, message: message };
    if (code === 'FORBIDDEN' || status === 403) {
        if (data.intafacedCode === 'scope.denied') return { reason: REASON.SCOPE_DENIED, message: message };
        if (/verification tier/i.test(message)) return { reason: REASON.TIER_REQUIRED, message: message };
        return { reason: REASON.FORBIDDEN, message: message };
    }
    // Last resort. Prefer whatever sentence the service actually wrote —
    // top-level `message` is where both the CCXT shape and Fastify's own 404
    // put it — over the placeholder, so a screen quotes the venue rather than
    // saying "Request failed" about a service that explained itself.
    if (message === 'Request failed' && body && typeof body.message === 'string' && body.message) {
        message = body.message;
    }
    return { reason: REASON.ERROR, message: message };
}

function send(url, options, raw) {
    return fetch(url, options).then(function(res) {
        return res.text().then(function(text) {
            var body = null;
            try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }

            // `raw` is for the handful of plain Fastify routes (a service's own
            // /health), which answer with the object itself rather than tRPC's
            // { result: { data } } envelope.
            if (res.ok && raw) {
                return { ok: true, reason: REASON.OK, status: res.status, data: body };
            }
            if (res.ok && body && body.result) {
                return { ok: true, reason: REASON.OK, status: res.status, data: body.result.data };
            }
            var verdict = classify(res.status, body);
            if (verdict.reason === REASON.UNAUTHORIZED) {
                authRefusal.signal({ status: res.status, url: url });
            }
            return { ok: false, reason: verdict.reason, status: res.status, message: verdict.message, data: null, intafacedCode: verdict.intafacedCode || null };
        });
    }, function() {
        // A rejected fetch is the network, not the service: the dev proxy is
        // missing, the edge is down, or nothing is listening on 4000.
        return { ok: false, reason: REASON.UNREACHABLE, status: 0, message: 'Could not reach svc-edge', data: null };
    });
}

/** A tRPC query. Resolves — never rejects — so screens branch on `reason`. */
export function query(module, procedure, input, token) {
    return send(buildUrl(module, procedure, input), { method: 'GET', headers: headers(token) });
}

/** A tRPC mutation. Same contract. */
export function mutate(module, procedure, input, token) {
    return send(EDGE_BASE + '/' + module + '/trpc/' + procedure, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify(input === undefined ? {} : input)
    });
}

/** A plain (non-tRPC) route on a service, e.g. svc-protocol's `/health`. */
export function plain(module, path, token) {
    return send(EDGE_BASE + '/' + module + path, { method: 'GET', headers: headers(token) }, true);
}

/** The CCXT REST base. svc-edge forwards this prefix to svc-trade unchanged. */
export const REST_BASE = EDGE_BASE + '/v1';

/**
 * A call against svc-trade's CCXT REST contract (`/api/v1/...`).
 *
 * Same contract as `query`/`mutate`: it RESOLVES with `{ ok, reason, message,
 * data }` and never rejects, so a screen branches on `reason` instead of
 * wrapping every call in a try/catch that would flatten the taxonomy back into
 * "something went wrong".
 *
 * `raw` is true because this surface answers with the value itself — an array
 * of markets, an order book object — and not tRPC's `{ result: { data } }`.
 *
 * A SUCCESSFUL EMPTY ANSWER IS `ok: true` WITH AN EMPTY ARRAY. That is the
 * distinction the whole trading half of this shell rests on: the books are
 * empty and OHLCV returns `[]` today, and those are answers, not failures. A
 * screen that renders them as a spinner or as a zero is lying about a system
 * that is telling the truth.
 *
 * @param {string} path   e.g. '/markets' or '/orderbook/BTC%2FUSDT'
 * @param {object} [opts] { method, body, token, query }
 */
export function rest(path, opts) {
    var o = opts || {};
    var url = REST_BASE + path;

    if (o.query) {
        var parts = [];
        for (var key in o.query) {
            if (!Object.prototype.hasOwnProperty.call(o.query, key)) continue;
            var value = o.query[key];
            if (value === undefined || value === null || value === '') continue;
            parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
        }
        if (parts.length) url += '?' + parts.join('&');
    }

    var init = { method: o.method || 'GET', headers: headers(o.token) };
    if (o.body !== undefined) init.body = JSON.stringify(o.body);
    return send(url, init, true);
}

/**
 * Percent-encode a unified symbol for a path segment (`BTC/USDT` → `BTC%2FUSDT`).
 *
 * The slash is the whole reason this exists: unencoded it becomes a path
 * separator and `/api/v1/orderbook/BTC/USDT` reaches a route that does not
 * exist, which surfaces as a 404 that reads like a missing market rather than a
 * malformed URL.
 */
export function symbolPath(symbol) {
    return encodeURIComponent(String(symbol == null ? '' : symbol));
}

/**
 * A §13 SOCKET, in the same shape every other call resolves to.
 *
 * For a capability the vendored shell has a screen for and the platform has no
 * service for. It resolves immediately with `NO_SURFACE` and the supplied
 * reason, so the screen renders a stated absence rather than a spinner that
 * never resolves, a fabricated list, or a request to the dead Java backend —
 * which, with nothing listening, renders as a hang.
 *
 * `message` is shown verbatim under "the service said". Write it as the honest
 * engineering fact: what is missing, and what would have to exist.
 *
 *   this.load('notices', noSurface('No announcements service is behind the edge…'));
 */
export function noSurface(message) {
    return Promise.resolve({
        ok: false,
        reason: REASON.NO_SURFACE,
        status: 0,
        message: message,
        data: null
    });
}

/**
 * The `sub` claim, read from an access token.
 *
 * Two procedures (`token.stakeOf`, `token.accessOf`) take a userId as input
 * rather than reading it from the principal, so the caller has to know its own
 * id. This decodes, it does not verify — the signature is the edge's business,
 * and a browser that lied to itself here would only be shown its own data.
 */
export function subjectOf(token) {
    if (!token) return null;
    var parts = String(token).split('.');
    if (parts.length !== 3) return null;
    try {
        var payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (payload.length % 4) payload += '=';
        var claims = JSON.parse(decodeURIComponent(escape(window.atob(payload))));
        return claims.sub || null;
    } catch (e) {
        return null;
    }
}

/** Scopes carried by an access token, for the honest "what can this session do" panel. */
export function scopesOf(token) {
    if (!token) return [];
    var parts = String(token).split('.');
    if (parts.length !== 3) return [];
    try {
        var payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (payload.length % 4) payload += '=';
        var claims = JSON.parse(decodeURIComponent(escape(window.atob(payload))));
        return claims.scopes || [];
    } catch (e) {
        return [];
    }
}

/**
 * THE MODULE MANIFEST.
 *
 * One row per feature area, and the row states what is TRUE today rather than
 * what is planned. `state` is not decoration — the screens render it, and the
 * hub totals it. Three values, and the difference between them matters:
 *
 *   live      a procedure on this module answers with real data today
 *   partial   the module is behind the edge, but the surface a user wants is refused
 *   absent    there is nothing to call — no route, no mount, or no service
 *
 * Kept beside the client rather than inside a component so the hub and each
 * screen cannot drift into telling the user two different stories.
 *
 * `edge` is the prefix svc-edge actually serves for this module, or null when
 * the edge has no route for it at all. Copy lives in assets/lang/en.js under
 * `intafaced.modules.<key>` — nothing user-facing is written here.
 */
export const MODULES = [
    { key: 'bank', route: '/bank', edge: 'bank', service: 'svc-bank', state: 'partial' },
    { key: 'pay', route: '/pay', edge: 'pay', service: 'svc-pay', state: 'live' },
    { key: 'market', route: '/market', edge: 'market', service: 'svc-market', state: 'live' },
    { key: 'support', route: '/support', edge: 'support', service: 'svc-support', state: 'partial' },
    { key: 'portfolio', route: '/portfolio', edge: 'ledger', service: 'svc-ledger', state: 'partial' },
    { key: 'p2p', route: '/p2p', edge: 'p2p', service: 'svc-p2p', state: 'partial' },
    { key: 'token', route: '/token', edge: 'token', service: 'svc-token', state: 'live' },
    { key: 'agents', route: '/agents', edge: 'agents', service: 'svc-agents', state: 'live' },
    { key: 'blueprint', route: '/blueprint', edge: 'blueprint', service: 'svc-blueprint', state: 'partial' },
    // Router mounted on main (#210/#217). Public health/chainStatus/launch.status answer.
    { key: 'protocol', route: '/protocol', edge: 'protocol', service: 'svc-protocol', state: 'partial' },
    { key: 'dex', route: '/dex', edge: 'dex', service: 'svc-dex', state: 'partial' },
    // Edge route /api/indexer exists on main (#218). Read models need a live chain.
    { key: 'chain', route: '/chain', edge: 'indexer', service: 'svc-indexer', state: 'partial' },
    // svc-academy on main (#208); lobbies need academy:* scopes + fleet.
    { key: 'academy', route: '/academy', edge: 'academy', service: 'svc-academy', state: 'partial' },
    // Token factory status lives on svc-protocol as launch.* (#217) — not a separate svc-launch.
    { key: 'launch', route: '/launch', edge: 'protocol', service: 'svc-protocol', state: 'partial' },
    { key: 'quant', route: '/quant', edge: 'quant', service: 'svc-quant', state: 'partial' },
    { key: 'execution', route: '/execution', edge: 'execution', service: 'svc-execution', state: 'partial' },
    { key: 'predict', route: '/predict', edge: 'trade', service: 'svc-trade', state: 'live' },
    { key: 'mining', route: '/mining', edge: 'mining', service: 'svc-mining-pool', state: 'live', probePath: '/api/mining/health' }
];

export function moduleByKey(key) {
    for (var i = 0; i < MODULES.length; i++) {
        if (MODULES[i].key === key) return MODULES[i];
    }
    return null;
}

export default {
    query: query,
    mutate: mutate,
    plain: plain,
    noSurface: noSurface,
    rest: rest,
    symbolPath: symbolPath,
    REST_BASE: REST_BASE,
    MODULES: MODULES,
    REASON: REASON,
    subjectOf: subjectOf,
    scopesOf: scopesOf,
    moduleByKey: moduleByKey
};
