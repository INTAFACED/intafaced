import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** A real Node process preserves production module installation order and disk IO. */
const nativeScript = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MatchingEngine } from './src/engine/engine.ts';
import { FileJournal, toWireAmend, fromWireAmend } from './src/engine/journal.ts';
import { MemoryEventBus } from '@intafaced/events';
import { parseAmount as p } from '@intafaced/ledger-client/money';
const startup = [['cod-fence','installCodFence'],['auction-uncross','installAuctionUncross'],['collars','installCollars'],['halt-law','installHaltLaw'],['bulk-items','installBulkItems'],['core-tif','installCoreTif'],['ifm-crash','installIfmCrash'],['l3-queue','installL3Queue'],['cert-refuse','installCertRefuse'],['combo-book','installComboBook'],['mass-quote','installMassQuote'],['mmp','installMmp'],['surveillance-persist','installSurveillancePersist'],['rulebook-refuse','installRulebookRefuse'],['liquidity','installLiquidity']];
for (const [file, name] of startup) (await import('./src/engine/' + file + '.ts'))[name]();
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const order = (n, accountId, side, patch = {}) => ({ orderId:id(n), accountId, type:'limit', side, qty:p('1'), price:p('100'), stopPrice:null, tif:'GTC', ...patch });
const dir = fs.mkdtempSync(join(tmpdir(),'matching-repair-native-'));
const path = join(dir,'journal.ndjson');
let journal = new FileJournal(path);
const bus = new MemoryEventBus('svc-matching');
let instant = '2026-10-11T00:00:00Z';
const clock = () => new Date(instant);
const engine = new MatchingEngine({ journal, bus, clock, snapshotEvery:0 });
const fillPayloads = b => b.emitted('orderFilled').map(e=>e.payload);
const reopen = async () => {
  journal.close(); journal = new FileJournal(path);
  const recoveredBus = new MemoryEventBus('svc-matching');
  const recovered = new MatchingEngine({ journal, bus:recoveredBus, clock, snapshotEvery:0 });
  await recovered.recover(); return { recovered, recoveredBus };
};
try {
  const scenario = process.env.MATCHING_REPAIR_SCENARIO;
  if (scenario === 'bracket') {
    await engine.submit('B',order(1,'unrelated','buy',{price:p('20')}));
    await engine.submit('B',order(2,'maker','sell'));
    assert.equal((await engine.submit('B',order(3,'desk','buy',{price:p('90'),bracket:true,takeProfit:p('110'),stopLoss:p('80'),takeProfitOrderId:id(4),stopLossOrderId:id(1)}))).accepted,true);
    const result = await engine.amend('B',{orderId:id(3),expectedVersion:1,price:p('100')});
    assert.equal(result.accepted,false);
    assert.equal(result.fills.length,1);
    assert.equal(result.rejected.code,'duplicate_order_id');
    assert.deepEqual(fillPayloads(bus).map(f=>[f.makerOrderId,f.takerOrderId,f.qty]),[[id(2),id(3),'1']]);
    const rollback = result.cancellations.find(c=>c.orderId===id(4));
    assert.ok(rollback,'rollback cancellation must be returned');
    assert.deepEqual(bus.emitted('orderCancelled').map(e=>e.payload.orderId),[id(4)]);
    assert.equal(engine.restingOrders('B').some(r=>r.orderId===id(1)),true);
    assert.equal(engine.restingOrders('B').some(r=>r.orderId===id(4)),false);
    assert.equal((await engine.amend('B',{orderId:id(3),expectedVersion:1,price:p('100')})).accepted,false);
    assert.equal(fillPayloads(bus).length,1);
    assert.equal(bus.emitted('orderCancelled').length,1);
    const state = engine.serialize();
    const { recovered, recoveredBus } = await reopen();
    assert.equal(recovered.serialize(),state);
    assert.deepEqual(fillPayloads(recoveredBus),fillPayloads(bus));
    assert.deepEqual(recoveredBus.emitted('orderFilled').map(e=>e.idempotencyKey),bus.emitted('orderFilled').map(e=>e.idempotencyKey));
    console.log(JSON.stringify({scenario,fillEvents:1,rollbackOrderId:rollback.orderId,rollbackSequence:rollback.sequence,replayEqual:true,noRepeatEffects:true}));
  } else if (scenario === 'quote') {
    const original = fs.fsyncSync;
    let outcome, error;
    try {
      fs.fsyncSync = fd => { original(fd); throw Error('actual fsync ACK lost'); };
      syncBuiltinESMExports();
      try { outcome = await engine.massQuote({setId:'original-quote',marketId:'Q',accountId:'desk',oneSided:true,bid:order(20,'desk','buy',{clientOrderId:'original-client',environment:'paper'})}); }
      catch (err) { error = err; }
    } finally { fs.fsyncSync=original; syncBuiltinESMExports(); }
    assert.equal(outcome,undefined,'unknown cannot return REFUSED');
    assert.match(error?.message ?? '',/actual fsync ACK lost/);
    assert.equal(engine.restingOrderCount,0);
    assert.equal(journal.length,0);
    assert.equal(bus.published.length,0);
    const { recovered } = await reopen();
    assert.deepEqual(recovered.restingOrders('Q').map(r=>r.orderId),[id(20)]);
    assert.equal(journal.read().filter(r=>r.kind==='submit').length,1);
    const originalRow=journal.read()[0];
    assert.equal(originalRow.order.clientOrderId,'original-client');
    assert.equal(originalRow.order.environment,'paper');
    assert.equal((await recovered.submit('Q',order(21,'desk','buy',{clientOrderId:'original-client',environment:'paper'}))).rejected.code,'client_order_id_reuse');
    assert.equal(journal.length,1);
    assert.deepEqual(recovered.restingOrders('Q').map(r=>r.orderId),[id(20)]);
    console.log(JSON.stringify({scenario,propagatedUnknown:true,originalOrderId:id(20),originalClientId:'original-client',durableInputs:1,noRetryEffects:true}));
  } else if (scenario === 'quote-pair') {
    await engine.submit('Q',order(61,'maker','sell'));
    const original = fs.fsyncSync;
    let count=0, outcome, error;
    try {
      fs.fsyncSync = fd => { original(fd); if (++count===2) throw Error('second quote fsync ACK lost'); };
      syncBuiltinESMExports();
      try { outcome=await engine.massQuote({setId:'original-pair',marketId:'Q',accountId:'desk',bid:order(62,'desk','buy',{qty:p('2'),clientOrderId:'pair-bid',environment:'paper'}),ask:order(63,'desk','sell',{price:p('110'),clientOrderId:'pair-ask',environment:'paper'})}); }
      catch(err) { error=err; }
    } finally { fs.fsyncSync=original; syncBuiltinESMExports(); }
    assert.equal(outcome,undefined);
    assert.match(error?.message ?? '',/second quote fsync ACK lost/);
    assert.equal(fillPayloads(bus).length,1);
    assert.equal(bus.emitted('orderCancelled').length,0);
    assert.deepEqual(engine.restingOrders('Q').map(r=>r.orderId),[id(62)]);
    assert.equal(journal.read().some(r=>r.kind==='cancel'),false);
    const {recovered,recoveredBus}=await reopen();
    assert.deepEqual(recovered.restingOrders('Q').map(r=>r.orderId).sort(),[id(62),id(63)]);
    assert.deepEqual(fillPayloads(recoveredBus),fillPayloads(bus));
    assert.deepEqual(recoveredBus.emitted('orderFilled').map(e=>e.idempotencyKey),bus.emitted('orderFilled').map(e=>e.idempotencyKey));
    for (const [n,side,clientOrderId] of [[64,'buy','pair-bid'],[65,'sell','pair-ask']]) {
      assert.equal((await recovered.submit('Q',order(n,'desk',side,{clientOrderId,environment:'paper'}))).rejected.code,'client_order_id_reuse');
    }
    assert.equal(journal.read().filter(r=>r.kind==='submit').length,3);
    console.log(JSON.stringify({scenario,propagatedUnknown:true,actualFills:1,noUndo:true,originalQuoteIds:[id(62),id(63)],noRetryEffects:true}));
  } else if (scenario === 'expiry' || scenario === 'gtt') {
    const tif = scenario==='expiry'?'GTD':'GTT';
    await engine.submit('E',order(31,'maker','sell',{tif,expireAt:'2026-10-11T02:00:00Z'}));
    const result=await engine.amend('E',{orderId:id(31),expectedVersion:1,expireAt:'2026-10-11T01:00:00Z'});
    assert.equal(result.accepted,true);
    instant='2026-10-11T01:30:00Z';
    const take=await engine.submit('E',order(32,'taker','buy'));
    assert.equal(take.fills.length,0);
    assert.deepEqual(take.cancellations.map(c=>c.orderId),[id(31)]);
    const amendRow=journal.read().find(r=>r.kind==='amend');
    assert.equal(amendRow.patch.expireAt,'2026-10-11T01:00:00Z');
    const state=engine.serialize();
    const {recovered,recoveredBus}=await reopen();
    assert.equal(recovered.serialize(),state);
    assert.deepEqual(fillPayloads(recoveredBus),[]);
    assert.equal(recovered.restingOrders('E').some(r=>r.orderId===id(31)),false);
    console.log(JSON.stringify({scenario,tif,deadline:amendRow.patch.expireAt,replayEqual:true,inventedFills:0}));
  } else if (scenario==='option') {
    const terms={strike:p('120'),expiry:'2026-12-31T00:00:00Z'};
    await engine.submit('O',order(41,'writer','sell',{price:p('11'),...terms}));
    await engine.submit('O',order(42,'holder','buy',{price:p('9'),...terms}));
    const amended=await engine.amend('O',{orderId:id(42),expectedVersion:1,price:p('11'),...terms});
    assert.equal(amended.accepted,true);
    assert.equal(amended.fills.length,1);
    const row=journal.read().find(r=>r.kind==='amend');
    assert.deepEqual(row.patch,{price:'11',strike:'120',expiry:terms.expiry});
    const state=engine.serialize();
    const {recovered,recoveredBus}=await reopen();
    assert.equal(recovered.serialize(),state);
    assert.deepEqual(fillPayloads(recoveredBus),fillPayloads(bus));
    assert.equal(recovered.restingOrderCount,0);
    console.log(JSON.stringify({scenario,patch:row.patch,actualFills:1,replayEqual:true,fillAttributionEqual:true}));
  } else if (scenario==='codec') {
    assert.deepEqual(toWireAmend({orderId:id(51),expectedVersion:1}),{});
    const patch={qty:p('0.000000000000000001'),price:p('12'),stopPrice:p('9'),tif:'GTD',expireAt:'2026-10-11T02:00:00Z',strike:p('120'),expiry:'2026-12-31T00:00:00Z'};
    assert.deepEqual(fromWireAmend(id(51),1,toWireAmend({orderId:id(51),expectedVersion:1,...patch})),{orderId:id(51),expectedVersion:1,...patch});
    const invalid={strike:null,expiry:null};
    assert.deepEqual(fromWireAmend(id(51),1,toWireAmend({orderId:id(51),expectedVersion:1,...invalid})),{orderId:id(51),expectedVersion:1,...invalid});
    await engine.submit('U',order(51,'maker','sell'));
    const before=journal.length;
    const result=await engine.amend('U',{orderId:id(51),expectedVersion:1,qty:p('2'),replace:true});
    assert.equal(result.rejected.code,'amend_field_unsupported');
    assert.equal(journal.length,before);
    const state=engine.serialize();
    const {recovered}=await reopen(); assert.equal(recovered.serialize(),state);
    console.log(JSON.stringify({scenario,omittedFields:{},explicitNulls:invalid,unsupportedNotJournaled:true,replayEqual:true}));
  } else throw Error('unknown test scenario');
} finally { journal.close(); fs.rmSync(dir,{recursive:true,force:true}); }
`;

// Native recovery replays run for several seconds under CI load; the 5 s default is too tight.
describe('native matching review repairs', { timeout: 30_000 }, () => {
  it.each(['bracket', 'quote', 'quote-pair', 'expiry', 'gtt', 'option', 'codec'])(
    '%s preserves actual effects and durable replay',
    (scenario) => {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type', 'module', '-e', nativeScript], {
        env: { ...process.env, MATCHING_REPAIR_SCENARIO: scenario },
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout).scenario).toBe(scenario);
    },
  );
});
