/**
 * Process-local notification that an authenticated platform request was
 * refused. The transport cannot import the Vuex store without turning the
 * platform client into UI infrastructure (and creating an import cycle), so
 * main.js owns the one subscriber that destroys browser authority.
 *
 * This carries no credential or member data. Repeated/concurrent 401s are
 * expected; the subscriber decides whether a live session still exists.
 */
'use strict';

var listeners = [];

function subscribe(listener) {
  if (typeof listener !== 'function') return function () {};
  listeners.push(listener);
  var active = true;
  return function unsubscribe() {
    if (!active) return;
    active = false;
    listeners = listeners.filter(function (candidate) {
      return candidate !== listener;
    });
  };
}

function signal(details) {
  listeners.slice().forEach(function (listener) {
    listener(details || {});
  });
}

module.exports = {
  subscribe: subscribe,
  signal: signal,
};
