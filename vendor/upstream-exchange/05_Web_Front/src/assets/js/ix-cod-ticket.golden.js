/* Cancel-on-disconnect ticket — existing svc-ws lease; no flatten. */
'use strict';

var assert = require('assert');
var tradeWire = require('./ix-trade.js');
var cod = require('./ix-cod-ticket.js');

var arm = cod.buildCodArmCommand({ commandId: 'cmd-1', ttlMs: 15000, scope: 'account' });
assert.strictEqual(arm.type, 'cod.arm');
assert.strictEqual(arm.commandId, 'cmd-1');
assert.strictEqual(arm.ttlMs, 15000);
assert.strictEqual(arm.scope, 'account');
assert.strictEqual(Object.prototype.hasOwnProperty.call(arm, 'excludedOrderClasses'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(arm, 'expiresAt'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(arm, 'flatten'), false);
assert.strictEqual(JSON.stringify(arm).indexOf('flatten'), -1);
assert.strictEqual(JSON.stringify(arm).indexOf('close-position'), -1);

assert.throws(function () { cod.buildCodArmCommand({ commandId: '', ttlMs: 15000 }); });
assert.throws(function () { cod.buildCodArmCommand({ commandId: 'cmd-1', ttlMs: 15.5 }); });
assert.throws(function () { cod.buildCodArmCommand({ commandId: 'cmd-1', ttlMs: '15000' }); });

var frames = [];
function send(text) { frames.push(text); }
cod.armCodLease(send, arm);
assert.strictEqual(frames.length, 1);
assert.strictEqual(frames[0], JSON.stringify(arm));
assert.strictEqual(frames[0].indexOf('flatten'), -1);
assert.strictEqual(frames[0].indexOf('close-position'), -1);

cod.renewCodLease(send, 'cmd-1');
var renew = JSON.parse(frames[1]);
assert.ok(renew.type === 'cod.heartbeat' || renew.type === 'cod.renew');
assert.strictEqual(renew.commandId, 'cmd-1');

cod.disarmCodLease(send, 'cmd-1');
assert.deepStrictEqual(JSON.parse(frames[2]), { type: 'cod.disarm', commandId: 'cmd-1' });
assert.strictEqual(frames.join('\n').indexOf('flatten'), -1);
assert.strictEqual(frames.join('\n').indexOf('close-position'), -1);

var seat = cod.bindTicket({ send: send, commandId: 'cmd-2', ttlMs: 15000 });
seat.onToggle(true);
var armed = JSON.parse(frames[3]);
assert.strictEqual(armed.type, 'cod.arm');
assert.strictEqual(armed.scope, 'account');
seat.onToggle(false);
var last = JSON.parse(frames[frames.length - 1]);
assert.strictEqual(last.type, 'cod.disarm');
assert.strictEqual(frames.join('\n').indexOf('flatten'), -1);

assert.strictEqual(typeof cod.installBazaarCodTicket, 'function');
assert.strictEqual(cod.installBazaarCodTicket(null), false);
assert.strictEqual(cod.readTicketCancelOnDisconnect({}), false);
assert.strictEqual(cod.readTicketCancelOnDisconnect({ cancelOnDisconnect: true }), true);

var url = cod.privateStreamUrl('tok-a', { protocol: 'https:', host: 'desk.example' });
assert.strictEqual(url, 'wss://desk.example/ws/private/stream?access_token=tok-a');

var refuse = tradeWire.orderFailureMessage({ reason: 'cod.lease_range_unconfigured' }, 'place');
assert.ok(refuse.indexOf('lease range') !== -1);
assert.ok(refuse.indexOf('flatten') === -1);

console.log('ix-cod-ticket golden: PASS');
