/**
 * Bazaar ticket reduce-only rest through the trade place that landed in #3238.
 *
 * Forwards reduceOnly to the trade place. Matching owns position (net fills).
 * Trade does not invent a mark. Matching refuse would_increase_position
 * is the ticket refuse.
 */
'use strict';

var trade = require('./ix-trade.js');

function readTicketReduceOnly(input) {
  if (input && input.reduceOnly === true) return true;
  if (typeof document !== 'undefined') {
    var el = document.getElementById('ix-ticket-reduce-only');
    if (el && el.checked === true) return true;
  }
  return false;
}

function bindReduceOnly(input) {
  if (!readTicketReduceOnly(input)) return input;
  return Object.assign({}, input, { reduceOnly: true });
}

if (trade && typeof trade.toCreateOrderBody === 'function') {
  var origCreate = trade.toCreateOrderBody;
  trade.toCreateOrderBody = function (input) {
    var bound = bindReduceOnly(input);
    var body = origCreate(bound);
    if (bound && bound.reduceOnly === true) body.reduceOnly = true;
    return body;
  };
  trade.readTicketReduceOnly = readTicketReduceOnly;
}

if (trade && typeof trade.orderFailureMessage === 'function') {
  var origFail = trade.orderFailureMessage;
  trade.orderFailureMessage = function (result, action) {
    var reason = result && result.reason;
    var verb = action === 'cancel' ? 'The order was not cancelled.' : 'No order was placed.';
    if (reason === 'would_increase_position' || reason === 'trade.would_increase_position') {
      return 'This reduce-only would increase the position. ' + verb;
    }
    return origFail(result, action);
  };
}

function ensureReduceOnlyField(select) {
  if (typeof document === 'undefined') return;
  if (document.getElementById('ix-ticket-reduce-only')) return;
  if (!select || !select.parentNode) return;
  var field = document.createElement('div');
  field.className = 'ix-field';
  field.id = 'ix-ticket-reduce-only-wrap';
  var label = document.createElement('label');
  label.setAttribute('for', 'ix-ticket-reduce-only');
  label.textContent = 'Reduce only';
  var inputWrap = document.createElement('div');
  inputWrap.className = 'ix-input';
  var input = document.createElement('input');
  input.id = 'ix-ticket-reduce-only';
  input.type = 'checkbox';
  input.setAttribute('aria-label', 'Reduce only');
  inputWrap.appendChild(input);
  var note = document.createElement('p');
  note.className = 'ix-order-note';
  note.textContent = 'Matching refuses if this would increase the position. No invented mark.';
  field.appendChild(label);
  field.appendChild(inputWrap);
  field.appendChild(note);
  select.parentNode.appendChild(field);
}

function installBazaarReduceOnlyTicket(doc) {
  var root = doc || (typeof document !== 'undefined' ? document : null);
  if (!root || typeof root.getElementById !== 'function') return false;
  var select = root.getElementById('ix-ticket-tif');
  if (!select) return false;
  if (root === document) ensureReduceOnlyField(select);
  return true;
}

function start() {
  if (typeof document === 'undefined') return;
  var tries = 0;
  var timer = setInterval(function () {
    tries += 1;
    if (installBazaarReduceOnlyTicket(document) || tries > 40) clearInterval(timer);
  }, 250);
}

start();

module.exports = {
  installBazaarReduceOnlyTicket: installBazaarReduceOnlyTicket,
  readTicketReduceOnly: readTicketReduceOnly
};
