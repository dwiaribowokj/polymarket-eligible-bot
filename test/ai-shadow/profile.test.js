import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { StageProfiler, safeWindow, percentiles } from '../../scripts/lib/ai-shadow-profile.js';
import { ProviderManager } from '../../src/ai-shadow/providers.js';

const base=Date.parse('2026-10-14T10:00:00Z');
const config={id:'frozen',deadline:base+3600000,layaDrainMs:30000};
const ledger=now=>({id:'frozen',lastHeartbeatAt:now,providers:{laya:{pending:null},'9router':{pending:null}}});
test('probe schedule reserves full drain plus 60s before production snapshots',()=>{
    for(const phase of [0,14999,120001,209000,240000,270000,299999]){
        const at=base+phase;assert.equal(safeWindow(at,ledger(at),config),'outside_quiet_window');
    }
    for(const phase of [15000,60000,120000]){const at=base+phase;assert.equal(safeWindow(at,ledger(at),config),null);}
});
test('probe blocks a pending inference, changed baseline, stale heartbeat and cutoff',()=>{
    const at=base+30000;
    assert.equal(safeWindow(at,{...ledger(at),id:'changed'},config),'baseline_changed');
    assert.equal(safeWindow(at,{...ledger(at),lastHeartbeatAt:at-90001},config),'heartbeat_stale');
    assert.equal(safeWindow(at,{...ledger(at),lastHeartbeatAt:at-60000},config),null);
    assert.equal(safeWindow(at,{...ledger(at),frozenAt:at},config),'deadline_or_frozen');
    assert.equal(safeWindow(at,ledger(at),{...config,deadline:at}),'deadline_or_frozen');
    assert.equal(safeWindow(at,{...ledger(at),providers:{laya:{pending:{snapshotId:'real'}}}},config),'production_inference_pending');
    assert.equal(safeWindow(at,{...ledger(at),providers:{laya:{disabled:'inference_unresolved'}}},config),'production_provider_disabled');
});
test('timing stages keep HTTP, tokenizer, body and local work separate without secrets',async()=>{
    let clock=0;
    const p=new StageProfiler({now:()=>clock,counter:{async count(){clock+=7;return {valid:true};}},pin:()=> 'cx/model',
        fetch:async()=>{clock+=25;return {ok:true,status:200,headers:new Headers({'server-timing':'infer;dur=23;desc="secret", queue;dur=1',Authorization:'secret'}),
            async text(){clock+=4;return JSON.stringify({model:'typed-decisions',usage:{input_tokens:9},secret:'do-not-store'});}};}});
    p.begin('laya',{snapshotId:'same'});clock+=2;await p.counter.count('private-input');clock+=1;
    const response=await p.fetch('http://secret:password@router.example/v1/systemone',{method:'POST',body:'secret'});
    await response.json();clock+=3;p.event('provider_drained',{provider:'laya'});
    const row=p.finish('laya',{status:'ok',latencyMs:42});
    assert.equal(row.localPreparationMs,3);assert.equal(row.tokenizerMs,7);assert.equal(row.httpHeadersWaitMs,25);
    assert.equal(row.bodyReadMs,4);assert.equal(row.jsonParseMs,0);assert.equal(row.responseValidationMs,3);assert.equal(row.totalMs,42);
    assert.deepEqual(row.serverTiming,[{metric:'infer',durationMs:23},{metric:'queue',durationMs:1}]);
    assert.doesNotMatch(JSON.stringify(row),/secret|password|private-input|do-not-store/);
});
test('invalid JSON records parsing and drain failure without storing response',async()=>{
    const p=new StageProfiler({counter:{},pin:()=>'',fetch:async()=>({ok:true,status:200,async text(){return 'private-invalid-json';}})});
    p.begin('laya',{snapshotId:'x'});
    const response=await p.fetch('http://local/v1/systemone',{method:'POST'});
    await assert.rejects(response.json(),SyntaxError);
    p.event('provider_drain_error',{provider:'laya',reason:'request_failed'});p.event('provider_drained',{provider:'laya'});
    const row=p.finish('laya',{status:'provider_error',latencyMs:0});
    assert.ok(Number.isFinite(row.jsonParseMs));assert.equal(row.drainError,true);
    assert.doesNotMatch(JSON.stringify(row),/private-invalid-json/);
});
test('late inference is measured through real drain and a second POST is not queued',async()=>{
    const cfg={layaUrl:'http://local',decisionMs:10,layaDrainMs:200};
    const profiler=new StageProfiler({pin:()=>'',counter:{async count(){return {valid:true,identity:'same'};},close(){}},
        fetch:async()=>{await delay(35);return {ok:true,status:200,async text(){return JSON.stringify({model:'typed-decisions',answers:{action:{choice:'SKIP'}}});}};}});
    const p=new ProviderManager(cfg,{laya:{tokenizerIdentity:'same'}},(type,detail)=>profiler.event(type,detail),
        {fetch:profiler.fetch,counter:profiler.counter,pin:profiler.pin});
    profiler.begin('laya',{snapshotId:'x'});const decision=await p.predict('laya',{snapshotId:'x',input:'same'});
    assert.equal(decision.status,'decision_timeout');assert.equal((await p.predict('laya',{snapshotId:'y'})).status,'provider_busy');
    assert.throws(()=>profiler.finish('laya',decision),/not_drained/);
    await Promise.allSettled([...p.active.values()]);await delay(0);
    const row=profiler.finish('laya',decision);assert.equal(row.submits,1);assert.equal(row.lateStatus,'ok');
    assert.ok(row.actualProviderLatencyMs>=30);assert.ok(row.httpHeadersWaitMs>=30);assert.equal(p.state.laya.pending,null);p.close();
});
test('unresolved probe aborts after fixed drain and preserves disabled evidence',async()=>{
    const cfg={layaUrl:'http://local',decisionMs:5,layaDrainMs:20};
    const profiler=new StageProfiler({pin:()=>'',counter:{async count(){return {valid:true,identity:'same'};},close(){}},
        fetch:(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('private-network-message'))))});
    const p=new ProviderManager(cfg,{laya:{tokenizerIdentity:'same'}},(type,detail)=>profiler.event(type,detail),
        {fetch:profiler.fetch,counter:profiler.counter});
    profiler.begin('laya',{snapshotId:'x'});const decision=await p.predict('laya',{snapshotId:'x',input:'same'});
    await Promise.allSettled([...p.active.values()]);await delay(0);
    const row=profiler.finish('laya',decision);assert.equal(row.disabled,'inference_unresolved');assert.equal(row.transportFailed,true);
    assert.doesNotMatch(JSON.stringify(row),/private-network-message/);assert.equal(p.state.laya.disabled,'inference_unresolved');p.close();
});
test('small samples use nearest-rank p95 and ignore missing measurements',()=>{
    assert.deepEqual(percentiles([null,1,2,3,4,5,undefined]),{n:5,p50:3,p95:5});
});
