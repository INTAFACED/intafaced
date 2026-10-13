'use strict';

/*
 * Bazaar cancel-on-disconnect — client for svc-ws `/private/stream`.
 *
 * Server receipt + ttlMs is expiry. Client `expiresAt` / `clientNow` are never
 * sent as a decision and never compared to the wall clock. This file does not
 * invent a TTL or an owner lease range. Unconfigured → server
 * `cod.lease_range_unconfigured`.
 *
 * Heartbeat is `cod.heartbeat` on the live private socket, scheduled from the
 * last server `ttlMs` duration — not from Date.now() vs expiresAt.
 *
 * CommonJS for golden tests + webpack require.
 */

var COD_CHANNEL = 'cod';
var SCOPES = { session: 'session', account: 'account', market: 'market' };
var OUTCOMES = { APPLIED: 'APPLIED', REFUSED: 'REFUSED', OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN' };
var DISCONNECT_REASON = 'cod.disconnect_unconfirmed';

function emptyView() {
  return {
    socket: 'closed',
    armed: false,
    commandId: null,
    leaseCommandId: null,
    receivedAt: null,
    expiresAt: null,
    ttlMs: null,
    scope: null,
    marketId: null,
    cancelExecutable: false,
    lastType: null,
    lastCode: null,
    lastCompletion: null,
    lastCompletionReason: null,
    lastCompletionCommandId: null,
    lastCompletionReceivedAt: null,
    lastCompletionExpiresAt: null,
    lastCompletionScope: null,
    lastCompletionMarketId: null,
    lastActivation: null,
    lastTargets: [],
    complete: null,
    tradeReached: null,
    recoveryPolicy: null
  };
}

function cloneView(view) {
  var next = emptyView();
  var src = view || next;
  for (var key in next) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) continue;
    next[key] = src[key];
  }
  next.lastTargets = Array.isArray(src.lastTargets) ? src.lastTargets.slice() : [];
  return next;
}

function newCommandId() {
  return 'cod-' + Math.random().toString(36).slice(2, 10) + '-' + String(Date.now());
}

function parseTtlMs(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  if (typeof value !== 'string') return null;
  var trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  var n = parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

function toArmCommand(input) {
  var value = input || {};
  var commandId =
    typeof value.commandId === 'string' && value.commandId.length > 0 && value.commandId.length <= 128
      ? value.commandId
      : newCommandId();
  var ttlMs = parseTtlMs(value.ttlMs);
  if (ttlMs === null) return { ok: false, code: 'cod.malformed' };
  var scope = SCOPES[value.scope];
  if (!scope) return { ok: false, code: 'cod.scope_unsupported' };
  var marketId = typeof value.marketId === 'string' && value.marketId.length > 0 ? value.marketId : undefined;
  if (scope === 'market' && !marketId) return { ok: false, code: 'cod.scope_unsupported' };
  if (Array.isArray(value.excludedOrderClasses) && value.excludedOrderClasses.length > 0) {
    return { ok: false, code: 'cod.excluded_classes_unconfigured' };
  }
  var body = {
    type: 'cod.arm',
    commandId: commandId,
    ttlMs: ttlMs,
    scope: scope
  };
  if (marketId) body.marketId = marketId;
  return { ok: true, body: body };
}

function toRenewCommand(input) {
  var commandId =
    input && typeof input.commandId === 'string' && input.commandId.length > 0 && input.commandId.length <= 128
      ? input.commandId
      : newCommandId();
  var type = input && input.heartbeat ? 'cod.heartbeat' : 'cod.renew';
  return { ok: true, body: { type: type, commandId: commandId } };
}

function toDisarmCommand(input) {
  var commandId =
    input && typeof input.commandId === 'string' && input.commandId.length > 0 && input.commandId.length <= 128
      ? input.commandId
      : newCommandId();
  return { ok: true, body: { type: 'cod.disarm', commandId: commandId } };
}

function asRecord(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw;
}

function wouldInventCodMassSuccess(value) {
  var rec = asRecord(value);
  if (!rec) return false;
  if (rec.channel === COD_CHANNEL && rec.type === 'cod.fired') {
    if (rec.complete === true && rec.tradeReached !== true) return true;
  }
  if (rec.type === 'snapshot' && rec.channel === 'orders' && rec.codComplete === true) return true;
  return false;
}

function summarizeTargets(targets, complete, tradeReached) {
  if (complete !== true || tradeReached !== true) {
    return { outcome: OUTCOMES.OUTCOME_UNKNOWN, reason: null };
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    return { outcome: OUTCOMES.OUTCOME_UNKNOWN, reason: 'cod.trade_empty_complete' };
  }
  var applied = 0;
  var refused = 0;
  var unknown = 0;
  var reason = null;
  for (var i = 0; i < targets.length; i += 1) {
    var row = targets[i];
    if (!row || typeof row !== 'object') {
      unknown += 1;
      continue;
    }
    if (row.outcome === OUTCOMES.APPLIED) applied += 1;
    else if (row.outcome === OUTCOMES.REFUSED) {
      refused += 1;
      if (!reason && typeof row.reason === 'string') reason = row.reason;
    } else {
      unknown += 1;
      if (!reason && typeof row.reason === 'string') reason = row.reason;
    }
  }
  if (unknown > 0) return { outcome: OUTCOMES.OUTCOME_UNKNOWN, reason: reason };
  if (refused > 0 && applied === 0) return { outcome: OUTCOMES.REFUSED, reason: reason };
  if (applied > 0 && refused === 0) return { outcome: OUTCOMES.APPLIED, reason: null };
  return { outcome: OUTCOMES.OUTCOME_UNKNOWN, reason: reason };
}

function completionIdentity(rec) {
  return {
    commandId: typeof rec.commandId === 'string' ? rec.commandId : null,
    receivedAt: typeof rec.receivedAt === 'string' ? rec.receivedAt : null,
    expiresAt: typeof rec.expiresAt === 'string' ? rec.expiresAt : null,
    scope: SCOPES[rec.scope] || rec.scope || null,
    marketId: rec.marketId == null ? null : rec.marketId,
  };
}

function matchesActiveLease(view, result) {
  return (
    view.armed === true &&
    typeof result.commandId === 'string' &&
    result.commandId.length > 0 &&
    result.commandId === view.leaseCommandId &&
    typeof result.receivedAt === 'string' &&
    result.receivedAt.length > 0 &&
    result.receivedAt === view.receivedAt &&
    typeof result.expiresAt === 'string' &&
    result.expiresAt.length > 0 &&
    result.expiresAt === view.expiresAt &&
    Object.prototype.hasOwnProperty.call(SCOPES, result.scope) &&
    result.scope === view.scope &&
    result.marketId === view.marketId
  );
}

function attributeCompletion(view, result) {
  view.lastCompletionCommandId = result.commandId;
  view.lastCompletionReceivedAt = result.receivedAt;
  view.lastCompletionExpiresAt = result.expiresAt;
  view.lastCompletionScope = result.scope;
  view.lastCompletionMarketId = result.marketId;
}

function parseFrame(raw) {
  var rec = asRecord(raw);
  if (!rec) return { kind: 'ignore' };
  if (rec.channel !== COD_CHANNEL && rec.type !== 'cod.armed' && rec.type !== 'cod.renewed' && rec.type !== 'cod.disarmed' && rec.type !== 'cod.refused' && rec.type !== 'cod.fired') {
    return { kind: 'ignore' };
  }
  if (wouldInventCodMassSuccess(rec)) return Object.assign({ kind: 'lie' }, completionIdentity(rec));
  if (rec.type === 'cod.refused') {
    return {
      kind: 'refused',
      commandId: typeof rec.commandId === 'string' ? rec.commandId : null,
      code: typeof rec.code === 'string' && rec.code ? rec.code : 'cod.malformed'
    };
  }
  if (rec.type === 'cod.armed' || rec.type === 'cod.renewed') {
    if (typeof rec.receivedAt !== 'string' || !rec.receivedAt) return { kind: 'ignore' };
    if (typeof rec.expiresAt !== 'string' || !rec.expiresAt) return { kind: 'ignore' };
    if (typeof rec.ttlMs !== 'number' || !Number.isInteger(rec.ttlMs) || rec.ttlMs < 1) return { kind: 'ignore' };
    return {
      kind: rec.type === 'cod.armed' ? 'armed' : 'renewed',
      commandId: typeof rec.commandId === 'string' ? rec.commandId : null,
      leaseCommandId: typeof rec.leaseCommandId === 'string' ? rec.leaseCommandId : null,
      receivedAt: rec.receivedAt,
      expiresAt: rec.expiresAt,
      ttlMs: rec.ttlMs,
      scope: SCOPES[rec.scope] || rec.scope,
      marketId: rec.marketId == null ? null : rec.marketId,
      cancelExecutable: rec.cancelExecutable === true,
      recoveryPolicy: rec.recoveryPolicy === 'cod.replica_local' ? rec.recoveryPolicy : rec.recoveryPolicy || null
    };
  }
  if (rec.type === 'cod.disarmed') {
    return {
      kind: 'disarmed',
      commandId: typeof rec.commandId === 'string' ? rec.commandId : null,
      leaseCommandId: typeof rec.leaseCommandId === 'string' ? rec.leaseCommandId : null
    };
  }
  if (rec.type === 'cod.fired') {
    var targets = Array.isArray(rec.targets) ? rec.targets : [];
    var summary = summarizeTargets(targets, rec.complete, rec.tradeReached);
    return {
      kind: 'fired',
      commandId: typeof rec.commandId === 'string' ? rec.commandId : null,
      receivedAt: typeof rec.receivedAt === 'string' ? rec.receivedAt : null,
      expiresAt: typeof rec.expiresAt === 'string' ? rec.expiresAt : null,
      scope: SCOPES[rec.scope] || rec.scope || null,
      marketId: rec.marketId == null ? null : rec.marketId,
      activation: rec.activation === 'disconnect' || rec.activation === 'lease_expired' ? rec.activation : null,
      complete: rec.complete === true,
      tradeReached: rec.tradeReached === true,
      recoveryPolicy: rec.recoveryPolicy || null,
      targets: targets,
      lastCompletion: summary.outcome,
      lastCompletionReason: summary.reason
    };
  }
  return { kind: 'ignore' };
}

function applyFrame(view, raw) {
  var next = cloneView(view);
  var parsed = parseFrame(raw);
  if (parsed.kind === 'ignore') return next;
  if (parsed.kind === 'lie') {
    next.lastType = 'cod.fired';
    next.lastCode = 'cod.invented_mass_success';
    next.lastCompletion = OUTCOMES.OUTCOME_UNKNOWN;
    next.lastCompletionReason = 'cod.invented_mass_success';
    next.complete = false;
    next.tradeReached = false;
    next.lastTargets = [];
    next.lastActivation = null;
    attributeCompletion(next, parsed);
    return next;
  }
  if (parsed.kind === 'refused') {
    next.lastType = 'cod.refused';
    next.lastCode = parsed.code;
    next.commandId = parsed.commandId;
    if (parsed.code === 'cod.unarmed') next.armed = false;
    return next;
  }
  if (parsed.kind === 'armed' || parsed.kind === 'renewed') {
    next.armed = true;
    next.lastType = parsed.kind === 'armed' ? 'cod.armed' : 'cod.renewed';
    next.lastCode = null;
    next.commandId = parsed.commandId;
    next.leaseCommandId = parsed.leaseCommandId;
    next.receivedAt = parsed.receivedAt;
    next.expiresAt = parsed.expiresAt;
    next.ttlMs = parsed.ttlMs;
    next.scope = parsed.scope;
    next.marketId = parsed.marketId;
    next.cancelExecutable = parsed.cancelExecutable;
    next.recoveryPolicy = parsed.recoveryPolicy;
    return next;
  }
  if (parsed.kind === 'disarmed') {
    next.armed = false;
    next.lastType = 'cod.disarmed';
    next.lastCode = null;
    next.commandId = parsed.commandId;
    next.leaseCommandId = parsed.leaseCommandId;
    next.receivedAt = null;
    next.expiresAt = null;
    next.ttlMs = null;
    next.cancelExecutable = false;
    return next;
  }
  if (parsed.kind === 'fired') {
    // A result belongs to the original server receipt. It can arrive after
    // another scope arms, or after the same command id is reused on reconnect.
    // Display that result without changing the active lease or its heartbeat.
    if (matchesActiveLease(next, parsed)) next.armed = false;
    next.lastType = 'cod.fired';
    next.lastCode = null;
    attributeCompletion(next, parsed);
    next.lastActivation = parsed.activation;
    next.complete = parsed.complete;
    next.tradeReached = parsed.tradeReached;
    next.recoveryPolicy = parsed.recoveryPolicy;
    next.lastTargets = parsed.targets;
    next.lastCompletion = parsed.lastCompletion;
    next.lastCompletionReason = parsed.lastCompletionReason;
    if (parsed.scope === 'session' && (!parsed.lastCompletionReason || parsed.lastCompletion === OUTCOMES.OUTCOME_UNKNOWN)) {
      var sessionReason = null;
      for (var i = 0; i < parsed.targets.length; i += 1) {
        if (parsed.targets[i] && parsed.targets[i].reason === 'cod.session_scope_not_mapped') {
          sessionReason = 'cod.session_scope_not_mapped';
          break;
        }
      }
      next.lastCompletion = OUTCOMES.OUTCOME_UNKNOWN;
      if (sessionReason) next.lastCompletionReason = sessionReason;
    }
    return next;
  }
  return next;
}

function applyDisconnect(view) {
  var next = cloneView(view);
  next.socket = 'closed';
  if (next.armed) {
    // A prior completed result may belong to another lease. Socket death still
    // leaves this active lease unconfirmed; it never proves its cancel applied.
    attributeCompletion(next, {
      commandId: next.leaseCommandId,
      receivedAt: next.receivedAt,
      expiresAt: next.expiresAt,
      scope: next.scope,
      marketId: next.marketId
    });
    next.armed = false;
    next.lastCompletion = OUTCOMES.OUTCOME_UNKNOWN;
    next.lastCompletionReason = DISCONNECT_REASON;
    next.complete = false;
    next.tradeReached = false;
    next.lastActivation = 'disconnect';
    next.lastTargets = [];
  }
  return next;
}

function privateStreamUrl(accessToken) {
  var proto = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
  var host = typeof location !== 'undefined' ? location.host : 'localhost';
  var token = accessToken == null ? '' : String(accessToken);
  return proto + '//' + host + '/ws/private/stream?access_token=' + encodeURIComponent(token);
}

function defaultSchedule(fn, delayMs) {
  var timer = setTimeout(fn, Math.max(0, delayMs));
  return function () {
    clearTimeout(timer);
  };
}

/**
 * Live private socket used only for COD arm/renew/disarm + receipt frames.
 * Orders snapshots are ignored so a quiet/empty blotter cannot look cancelled.
 */
function createPrivateCodStream(opts) {
  var options = opts || {};
  var token = options.accessToken;
  var onView = options.onView;
  var onStatus = options.onStatus;
  var WS = options.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  var schedule = options.schedule || defaultSchedule;

  var socket = null;
  var closed = false;
  var view = emptyView();
  var lastArmBody = null;
  var cancelHeartbeat = null;
  var reconnectTimer = null;

  function publish() {
    if (typeof onView === 'function') onView(cloneView(view));
  }
  function status(s) {
    if (typeof onStatus === 'function') onStatus(s);
  }
  function stopHeartbeat() {
    if (cancelHeartbeat) {
      cancelHeartbeat();
      cancelHeartbeat = null;
    }
  }
  function armHeartbeat() {
    stopHeartbeat();
    if (!view.armed || typeof view.ttlMs !== 'number' || view.ttlMs < 1) return;
    var delay = Math.max(1, Math.floor(view.ttlMs / 2));
    cancelHeartbeat = schedule(function () {
      cancelHeartbeat = null;
      sendHeartbeat();
    }, delay);
  }
  function sendRaw(body) {
    if (closed || !socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(body));
      return true;
    } catch (e) {
      return false;
    }
  }
  function sendHeartbeat() {
    if (!view.armed) return;
    var cmd = toRenewCommand({ heartbeat: true });
    if (sendRaw(cmd.body)) status('heartbeat');
  }
  function applyAndPublish(raw) {
    var beforeArmed = view.armed;
    var beforeTtl = view.ttlMs;
    view = applyFrame(view, raw);
    if (view.armed && (view.ttlMs !== beforeTtl || view.armed !== beforeArmed || view.lastType === 'cod.renewed' || view.lastType === 'cod.armed')) {
      armHeartbeat();
    }
    if (!view.armed) stopHeartbeat();
    publish();
  }

  function onMessage(ev) {
    var msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'snapshot' && msg.channel === 'orders') return;
    applyAndPublish(msg);
  }

  function connect() {
    if (!WS || !token || closed) {
      view.socket = 'closed';
      publish();
      status('no-ws');
      return;
    }
    try {
      socket = new WS(privateStreamUrl(token));
    } catch (e) {
      view.socket = 'closed';
      publish();
      status('ws-construct-failed');
      return;
    }
    socket.onopen = function () {
      if (closed) return;
      view.socket = 'open';
      publish();
      status('open');
      if (lastArmBody) sendRaw(lastArmBody);
    };
    socket.onmessage = onMessage;
    socket.onerror = function () {
      status('error');
    };
    socket.onclose = function () {
      stopHeartbeat();
      socket = null;
      view = applyDisconnect(view);
      publish();
      status('closed');
      if (!closed) {
        reconnectTimer = schedule(function () {
          reconnectTimer = null;
          if (!closed && !socket) connect();
        }, 2000);
      }
    };
  }

  connect();

  return {
    arm: function (input) {
      var built = toArmCommand(input);
      if (!built.ok) {
        view.lastType = 'cod.refused';
        view.lastCode = built.code;
        publish();
        return built;
      }
      lastArmBody = built.body;
      if (!sendRaw(built.body)) status('arm-queued');
      return built;
    },
    renew: function (input) {
      var built = toRenewCommand(input);
      if (!sendRaw(built.body)) status('renew-queued');
      return built;
    },
    disarm: function (input) {
      lastArmBody = null;
      var built = toDisarmCommand(input);
      if (!sendRaw(built.body)) status('disarm-queued');
      return built;
    },
    stop: function () {
      closed = true;
      lastArmBody = null;
      stopHeartbeat();
      if (reconnectTimer) {
        reconnectTimer();
        reconnectTimer = null;
      }
      if (socket) {
        try {
          socket.close();
        } catch (e) {
          /* ignore */
        }
        socket = null;
      }
      view.socket = 'closed';
      view.armed = false;
      publish();
    },
    _view: function () {
      return cloneView(view);
    },
    _apply: function (msg) {
      applyAndPublish(msg);
    },
    _close: function () {
      if (socket && typeof socket.onclose === 'function') socket.onclose({});
    }
  };
}

module.exports = {
  COD_CHANNEL: COD_CHANNEL,
  OUTCOMES: OUTCOMES,
  DISCONNECT_REASON: DISCONNECT_REASON,
  emptyView: emptyView,
  cloneView: cloneView,
  newCommandId: newCommandId,
  parseTtlMs: parseTtlMs,
  toArmCommand: toArmCommand,
  toRenewCommand: toRenewCommand,
  toDisarmCommand: toDisarmCommand,
  parseFrame: parseFrame,
  applyFrame: applyFrame,
  applyDisconnect: applyDisconnect,
  wouldInventCodMassSuccess: wouldInventCodMassSuccess,
  summarizeTargets: summarizeTargets,
  privateStreamUrl: privateStreamUrl,
  createPrivateCodStream: createPrivateCodStream
};
