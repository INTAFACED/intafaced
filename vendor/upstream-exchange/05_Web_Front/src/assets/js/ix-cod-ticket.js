/**
 * Bazaar ticket: arm cancel-on-disconnect through the existing svc-ws lease.
 *
 * The trader turns it on. The ticket sends `cod.arm` on the private stream
 * (`account` scope). Disconnect cancels resting orders through that lease.
 * It does not flatten the position.
 */
'use strict';

var trade = require('./ix-trade.js');

var DEFAULT_TTL_MS = 15000;
var COD_REFUSE = {
  'cod.lease_range_unconfigured': 'Cancel-on-disconnect is not armed: the owner lease range is blank.',
  'cod.write_required': 'Cancel-on-disconnect needs a write session.',
  'cod.ttl_out_of_range': 'Cancel-on-disconnect lease TTL is outside the owner range.',
  'cod.unarmed': 'Cancel-on-disconnect is not armed.',
  'cod.malformed': 'Cancel-on-disconnect was refused as malformed.',
  'cod.scope_unsupported': 'Cancel-on-disconnect scope is not supported.',
  'cod.write_required': 'Cancel-on-disconnect needs a write session.'
};

function readTicketCancelOnDisconnect(input) {
  if (input && input.cancelOnDisconnect === true) return true;
  if (typeof document !== 'undefined') {
    var el = document.getElementById('ix-ticket-cancel-on-disconnect');
    if (el && el.checked === true) return true;
  }
  return false;
}

function buildCodArmCommand(input) {
  var commandId = input && typeof input.commandId === 'string' ? input.commandId : '';
  if (!commandId || commandId.length > 128) {
    var bad = new Error('cod.malformed');
    bad.code = 'cod.malformed';
    throw bad;
  }
  var ttlMs = input && input.ttlMs !== undefined ? input.ttlMs : DEFAULT_TTL_MS;
  if (typeof ttlMs !== 'number' || !isFinite(ttlMs) || Math.floor(ttlMs) !== ttlMs) {
    var ttlErr = new Error('cod.malformed');
    ttlErr.code = 'cod.malformed';
    throw ttlErr;
  }
  var scope = (input && input.scope) || 'account';
  if (scope !== 'account' && scope !== 'market' && scope !== 'session') {
    var scopeErr = new Error('cod.scope_unsupported');
    scopeErr.code = 'cod.scope_unsupported';
    throw scopeErr;
  }
  var command = {
    type: 'cod.arm',
    commandId: commandId,
    ttlMs: ttlMs,
    scope: scope
  };
  if (scope === 'market' && input && typeof input.marketId === 'string' && input.marketId) {
    command.marketId = input.marketId;
  }
  return command;
}

function armCodLease(send, command) {
  if (typeof send !== 'function') {
    var err = new Error('cod.unarmed');
    err.code = 'cod.unarmed';
    throw err;
  }
  send(JSON.stringify(command));
}

function renewCodLease(send, commandId) {
  if (typeof send !== 'function') return;
  send(JSON.stringify({ type: 'cod.heartbeat', commandId: commandId }));
}

function disarmCodLease(send, commandId) {
  if (typeof send !== 'function') return;
  send(JSON.stringify({ type: 'cod.disarm', commandId: commandId }));
}

function privateStreamUrl(token, locationLike) {
  var loc = locationLike || (typeof location !== 'undefined' ? location : null);
  var proto = loc && loc.protocol === 'https:' ? 'wss:' : 'ws:';
  var host = loc && loc.host ? loc.host : 'localhost';
  var q = token ? ('?access_token=' + encodeURIComponent(token)) : '';
  return proto + '//' + host + '/ws/private/stream' + q;
}

function readAccessToken(reader) {
  if (typeof reader === 'function') return reader() || '';
  try {
    var store = (typeof window !== 'undefined' && window.__IX_STORE__) || null;
    if (store && store.getters && store.getters.ixToken) return String(store.getters.ixToken);
  } catch (e) {}
  return '';
}

function newCommandId() {
  return 'cod-' + String(Date.now()) + '-' + String(Math.floor(Math.random() * 1e9));
}

function ensureCodField(select) {
  if (typeof document === 'undefined') return;
  if (document.getElementById('ix-ticket-cancel-on-disconnect')) return;
  if (!select || !select.parentNode) return;
  var field = document.createElement('div');
  field.className = 'ix-field';
  field.id = 'ix-ticket-cancel-on-disconnect-wrap';
  var label = document.createElement('label');
  label.setAttribute('for', 'ix-ticket-cancel-on-disconnect');
  label.textContent = 'Cancel on disconnect';
  var inputWrap = document.createElement('div');
  inputWrap.className = 'ix-input';
  var input = document.createElement('input');
  input.id = 'ix-ticket-cancel-on-disconnect';
  input.type = 'checkbox';
  input.setAttribute('aria-label', 'Cancel on disconnect');
  inputWrap.appendChild(input);
  var note = document.createElement('p');
  note.className = 'ix-order-note';
  note.textContent = 'Cancels resting orders on disconnect. Does not flatten the position.';
  field.appendChild(label);
  field.appendChild(inputWrap);
  field.appendChild(note);
  select.parentNode.appendChild(field);
}

function installBazaarCodTicket(doc) {
  var root = doc || (typeof document !== 'undefined' ? document : null);
  if (!root || typeof root.getElementById !== 'function') return false;
  var select = root.getElementById('ix-ticket-tif');
  if (!select) return false;
  if (typeof document !== 'undefined' && root === document) ensureCodField(select);
  return true;
}

function bindTicket(opts) {
  var options = opts || {};
  var send = options.send;
  var armedId = null;
  var cancelHeartbeat = null;
  var schedule = typeof options.schedule === 'function' ? options.schedule : null;

  function stopHeartbeat() {
    if (typeof cancelHeartbeat === 'function') cancelHeartbeat();
    cancelHeartbeat = null;
  }

  function arm() {
    var command = buildCodArmCommand({
      commandId: options.commandId || newCommandId(),
      ttlMs: options.ttlMs || DEFAULT_TTL_MS,
      scope: 'account'
    });
    armCodLease(send, command);
    armedId = command.commandId;
    stopHeartbeat();
    if (schedule) {
      cancelHeartbeat = schedule(function () {
        if (armedId) renewCodLease(send, armedId);
      }, Math.max(1, Math.floor(command.ttlMs / 2)));
    }
  }

  function disarm() {
    stopHeartbeat();
    if (armedId) disarmCodLease(send, armedId);
    armedId = null;
  }

  return {
    onToggle: function (on) {
      if (on) arm();
      else disarm();
    },
    disarm: disarm,
    armedCommandId: function () { return armedId; }
  };
}

if (trade && typeof trade.orderFailureMessage === 'function') {
  var origFail = trade.orderFailureMessage;
  trade.orderFailureMessage = function (result, action) {
    var reason = result && result.reason;
    if (reason && COD_REFUSE[reason]) {
      return COD_REFUSE[reason] + ' Resting orders were not cancelled.';
    }
    return origFail(result, action);
  };
}

function start() {
  if (typeof document === 'undefined') return;
  var tries = 0;
  var timer = setInterval(function () {
    tries += 1;
    if (installBazaarCodTicket(document) || tries > 40) clearInterval(timer);
  }, 250);
}

start();

module.exports = {
  installBazaarCodTicket: installBazaarCodTicket,
  readTicketCancelOnDisconnect: readTicketCancelOnDisconnect,
  buildCodArmCommand: buildCodArmCommand,
  armCodLease: armCodLease,
  renewCodLease: renewCodLease,
  disarmCodLease: disarmCodLease,
  privateStreamUrl: privateStreamUrl,
  readAccessToken: readAccessToken,
  bindTicket: bindTicket,
  DEFAULT_TTL_MS: DEFAULT_TTL_MS
};
