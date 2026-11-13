import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASELINE } from '../../src/restart/config.js';
import { BtcSignal } from '../../src/restart/signal.js';
import { BookHistory, makeFeatures, encodeFeatures } from '../../src/ai-shadow/history.js';
import { ShadowEngine, candidates, candidateChecks, metadataIdentity, validatedStreamBooks, verifyStreamSnapshot, risk } from '../../src/ai-shadow/engine.js';
import { ShadowStore, archiveActivePeriod } from '../../src/ai-shadow/store.js';
import { summarize } from '../../src/ai-shadow/report.js';
import { DEADLINE } from '../../src/ai-shadow/config.js';
import { compactInput, expandInput } from '../../src/ai-shadow/encoding.js';

function fixture() {
    let now=Date.parse('2026-10-14T00:03:30Z');
    const config={id:'test',sources:[],deadline:DEADLINE,slots:[90,60,30],slotToleranceMs:2000,capital:20,shares:5,
        entryCap:5,gasUsd:0.05,latencyMs:250,settlementMs:2500,dataAgeMs:5000,decisionMs:3000,drawdownStop:10,shadowDrawdownStop:2,
        limitSlippageTicks:1,limitSlippageUsd:0.01,
        control:{...BASELINE,paperGasUsd:0.05,lateSignal:{...BASELINE.lateSignal,calibration:null},fingerprint:'fixture',dataDir:'/nonexistent'}};
    const signal=new BtcSignal(config.control.lateSignal);
    for(let i=-185;i<=0;i++)signal.ingest({topic:'prices.crypto',type:'update',payload:{symbol:'btcusd',timestamp:now+i*1000,value:83020}},now+i*1000);
    signal.ingest({topic:'prices.crypto.twap',type:'update',payload:{symbol:'btcusd',timestamp:now,value:83020,windowSeconds:60}},now);
    const market={slug:'btc-updown-5m-test',conditionId:'condition',open:now-210000,end:now+90000,minimum:5,tick:0.01,ticks:[0.01,0.01],
        accepting:true,tokens:['up','down'],fee:{rate:0.07,exponent:1,takerOnly:true}};
    const opening={at:market.open,value:83000,receivedAt:market.open+100};signal.openings.set(market.open,opening);
    market.reference={source:'chainlink_twap_60s',open:market.open,end:market.end,value:83000,observedAt:market.open,receivedAt:opening.receivedAt};
    let price=0.78,size=10,payout=null;
    const getBooks=()=>[{tokenId:'up',conditionId:'condition',tick:market.ticks[0],timestamp:now,fetchedAt:now,bids:[{price:price-0.01,size:10}],asks:[{price,size}]},
        {tokenId:'down',conditionId:'condition',tick:market.ticks[1],timestamp:now,fetchedAt:now,bids:[{price:0.21,size:10}],asks:[{price:0.22,size:10}]}];
    const ws={generation:1,tokens:market.tokens,snapshot:()=>getBooks(),watch(){},close(){},socket:{readyState:1}};
    const arm=()=>({cash:20,peak:20,drawdown:0,shadowStop:null,stopped:null,seen:{},position:null,completed:[],outcomes:{}});
    const state={id:'test',startedAt:now,deadline:DEADLINE,frozenAt:null,slots:{[market.slug+':90']:{status:'reserved'}},snapshots:[],
        markets:{[market.slug]:{end:market.end}},providers:{},errors:{},arms:{control:arm(),laya:arm(),'9router':arm()}};
    const store={state,save(){},event(){},error(stage,e){state.errors[stage+':'+e.message]=(state.errors[stage+':'+e.message]||0)+1;},
        freeze(at){if(at>=config.deadline)state.frozenAt=config.deadline;}};
    const seen=[];
    const providers={async predict(name,s){seen.push({name,s});return {snapshotId:s.snapshotId,status:'ok',action:'BUY_UP',latencyMs:0,cost:0};},close(){}};
    const client={btc:signal,async books(){return getBooks();},async payout(){return payout;},startBtcFeed(){},close(){}};
    const engine=new ShadowEngine(config,store,client,ws,providers,{clock:()=>now});
    return {config,market,signal,ws,state,store,providers,client,engine,seen,getBooks,get now(){return now;},
        advance(ms){now+=ms;},price(p){price=p;},size(s){size=s;},payout(p){payout=p;}};
}
test('history is causal, spans 180 seconds and includes all six OHLC bars',()=>{
    const f=fixture(),feature=makeFeatures(f.signal,f.market,f.getBooks(),f.ws,f.now);
    assert.equal(feature.state.bars_30s_OHLC_oldest_first.length,6);
    f.signal.spot.push({at:f.now+1000,receivedAt:f.now+1000,value:99000});
    assert.deepEqual(makeFeatures(f.signal,f.market,f.getBooks(),f.ws,f.now).state,feature.state);
    f.signal.spot=f.signal.spot.slice(-50,-1);
    assert.throws(()=>makeFeatures(f.signal,f.market,f.getBooks(),f.ws,f.now),/history_not_ready/);
});
test('missing opening, history gap and future TWAP refuse a snapshot',()=>{
    for(const mutate of [f=>f.signal.openings.clear(),f=>f.signal.spot.splice(40,10),f=>f.signal.twap.at=f.now+1]){
        const f=fixture();mutate(f);assert.throws(()=>makeFeatures(f.signal,f.market,f.getBooks(),f.ws,f.now));
    }
});
test('both providers receive the identical snapshot while AI can bypass the old model gate',async()=>{
    const f=fixture();f.signal.openings.get(f.market.open).value=83018;f.market.reference.value=83018;
    await f.engine.observe(f.market,90,f.market.slug+':90');
    assert.equal(f.seen.length,2);assert.equal(f.seen[0].s,f.seen[1].s);
    assert.equal(f.state.snapshots[0].decisions.control.action,'SKIP');
    assert.equal(f.state.arms.laya.position.status,'pending');
});
test('FAK retains precommitted capped limit and makes no fill beyond its allowance',async()=>{
    const f=fixture();await f.engine.observe(f.market,90,f.market.slug+':90');f.price(0.80);f.advance(300);
    await f.engine.manage(f.now);assert.equal(f.state.arms.laya.position,null);
    assert.equal(f.state.arms.laya.outcomes[f.market.slug].reason,'no_fill');assert.equal(f.state.arms.laya.cash,20);
});
test('partial FAK stays matched until simulated settlement, never chases remaining shares',async()=>{
    const f=fixture();await f.engine.observe(f.market,90,f.market.slug+':90');f.size(2);f.advance(300);
    await f.engine.manage(f.now);assert.equal(f.state.arms.laya.position.status,'matched');assert.equal(f.state.arms.laya.cash,20);
    f.advance(2600);await f.engine.manage(f.now);assert.equal(f.state.arms.laya.position.holdings,2);
    const count=f.state.arms.laya.seen[f.market.slug];assert.ok(count);assert.equal(Object.keys(f.state.arms.laya.seen).length,1);
});
test('settlement remains open without official payout and closes with official payout only',async()=>{
    const f=fixture();await f.engine.observe(f.market,90,f.market.slug+':90');f.advance(300);await f.engine.manage(f.now);
    f.advance(2600);await f.engine.manage(f.now);f.advance(90000);await f.engine.manage(f.now);
    assert.equal(f.state.arms.control.completed.length,0);assert.ok(f.state.arms.control.position);
    f.payout([0,1]);f.advance(16000);await f.engine.manage(f.now);
    assert.equal(f.state.arms.control.completed.length,1);assert.ok(f.state.arms.control.completed[0].pnl<0);
    assert.ok(f.state.arms.control.shadowStop);
});
test('minimum, budget, spread and last-20-second price checks remain mandatory',()=>{
    const f=fixture();assert.equal(candidates(f.market,f.getBooks(),f.config,20,f.now).length,1);
    assert.equal(candidates({...f.market,minimum:6},f.getBooks(),f.config,20,f.now).length,0);
    assert.equal(candidates(f.market,f.getBooks(),f.config,1,f.now).length,0);
    assert.equal(candidates(f.market,f.getBooks(),f.config,20,f.market.end-19000).length,0);
    assert.equal(candidates(f.market,f.getBooks(),{...f.config,entryCap:3},20,f.now).length,0);
});
test('late decisions and decisions at the deadline cannot reserve an entry',()=>{
    const f=fixture(),allowed=candidates(f.market,f.getBooks(),f.config,20,f.now);
    const snapshot={snapshotId:'s',at:f.now-3001,observedAt:f.now-3001};
    f.engine.apply('laya',{status:'ok',action:'BUY_UP'},snapshot,f.market,allowed);assert.equal(f.state.arms.laya.position,null);
    f.config.deadline=f.now;f.engine.apply('laya',{status:'ok',action:'BUY_UP'},{...snapshot,at:f.now,observedAt:f.now},f.market,allowed);
    assert.equal(f.state.arms.laya.position,null);
});
test('shadow and research loss stops persist separately',()=>{
    const f=fixture(),a=f.state.arms.control;risk(a,f.config,17,f.now);assert.ok(a.shadowStop);assert.equal(a.stopped,null);
    risk(a,f.config,9,f.now);assert.ok(a.stopped);risk(a,f.config,20,f.now);assert.ok(a.stopped);assert.ok(a.shadowStop);
});
test('restart cancels only unexecuted virtual pending entries and disables unknown inference',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ai-shadow-test-'));
    try{const f=fixture(),config={...f.config,dataDir:dir};let s=new ShadowStore(config);
        s.state.arms.control.position={status:'pending',market:{slug:'old'}};s.state.arms.laya.position={status:'filled',market:{slug:'filled'},holdings:5};
        s.state.arms.control.stopped={reason:'prior_loss'};s.state.providers.laya={pending:{snapshotId:'unknown'}};s.save();
        s=new ShadowStore(config);assert.equal(s.state.arms.control.position,null);assert.equal(s.state.arms.laya.position.holdings,5);
        assert.equal(s.state.providers.laya.disabled,'restart_with_unknown_inference');assert.equal(s.state.arms.control.stopped.reason,'prior_loss');
        s.state.arms['9router'].position={status:'pending',market:{slug:'pending'}};s.freeze(DEADLINE);
        assert.equal(s.state.arms['9router'].position,null);assert.equal(s.state.arms.laya.position.holdings,5);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('report separates unknown AI costs, open inventory and all cohort skips',()=>{
    const f=fixture();f.state.snapshots=[{market:f.market.slug,decisions:{control:{status:'ok',action:'SKIP',cost:0},
        laya:{status:'decision_timeout',action:'SKIP',cost:0,latencyMs:3000},'9router':{status:'ok',action:'SKIP',cost:null,latencyMs:2000}}}];
    const report=summarize(f.state,f.config,f.market.end+1000);
    assert.equal(report.arms['9router'].apiCostUnknownRequests,1);assert.equal(report.arms['9router'].netAfterAllAiCost,null);
    assert.equal(report.differences.laya.matchedMarkets,1);assert.equal(report.arms.laya.latencyMs.p95,null);
    assert.equal(report.arms.laya.decisionWaitingMs.p95,3000);
    assert.equal(report.liveDecision,'belum_layak_pilot');
});
test('WebSocket book deltas update depth and a disconnect/gap resets direct warmup',()=>{
    let now=1000000;const ws=new BookHistory({clock:()=>now});ws.tokens=['up','down'];
    for(const asset_id of ws.tokens)ws.ingest({event_type:'book',asset_id,timestamp:now,bids:[{price:'.77',size:'10'}],asks:[{price:'.78',size:'10'}]},now);
    assert.equal(ws.snapshot(now),null);assert.equal(ws.snapshot(now,false).length,2);
    now+=1000;ws.ingest({event_type:'price_change',timestamp:now,price_changes:[{asset_id:'up',side:'SELL',price:'.78',size:'2'}]},now);
    assert.equal(ws.snapshot(now,false)[0].asks[0].size,2);
    now+=6000;ws.ingest({event_type:'book',asset_id:'up',timestamp:now,bids:[],asks:[]},now);
    assert.equal(ws.snapshot(now,false),null);assert.equal(ws.readyAt,null);
});
test('REST validation finishing after the slot tolerance makes no AI request',async()=>{
    const f=fixture();f.advance(2001);
    await assert.rejects(f.engine.observe(f.market,90,f.market.slug+':90'),/slot_late_after_validation/);assert.equal(f.seen.length,0);
});
test('stale and future orderbooks cannot appear in a causal AI input',()=>{
    const f=fixture();for(const time of [f.now-5001,f.now+1]){const b=f.getBooks();b[0].timestamp=time;
        assert.throws(()=>makeFeatures(f.signal,f.market,b,f.ws,f.now),/snapshot_book_stale_or_future/);}
});
test('post-deadline pending execution never fills even if the quote is executable',async()=>{
    const f=fixture();await f.engine.observe(f.market,90,f.market.slug+':90');f.config.deadline=f.now+200;f.advance(300);
    await f.engine.manage(f.now);assert.equal(f.state.arms.laya.position,null);assert.equal(f.state.arms.laya.cash,20);
});
test('model change never silently creates a replacement ledger or resets a stop',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ai-shadow-period-'));
    try{const f=fixture();const original=new ShadowStore({...f.config,dataDir:dir});original.state.arms.control.stopped={reason:'loss'};original.save();
        assert.throws(()=>new ShadowStore({...f.config,dataDir:dir,id:'changed'}),/shadow_baseline_changed/);
        assert.equal(new ShadowStore({...f.config,dataDir:dir}).state.arms.control.stopped.reason,'loss');
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('shutdown prevents a still-running AI task from reserving a new order',()=>{
    const f=fixture(),allowed=candidates(f.market,f.getBooks(),f.config,20,f.now);
    f.engine.close();f.engine.apply('laya',{status:'ok',action:'BUY_UP'},{snapshotId:'s',at:f.now,observedAt:f.now},f.market,allowed);
    assert.equal(f.state.arms.laya.position,null);
});
test('compact encoding preserves every numeric feature and fractional tick/depth precision',()=>{
    const f=fixture(),state=makeFeatures(f.signal,f.market,f.getBooks(),f.ws,f.now).state;
    state.allowed=['BUY_UP'];state.books_up_down[0].asks[0]=[0.7357,10.25];
    state.returns_bps_5_15_30_60_180=[-0.003,0.049,1.254,-1.1,0];
    state.volatility_usd_sqrt_s=0.998;
    // The independently rounded TWAP distance can differ from subtracting
    // rounded absolute prices. Preserve it rather than recomputing it.
    state.margin_usd=20.01;
    const encoded=expandInput(encodeFeatures(state));
    const price=v=>Number((encoded.open_usd+v/100).toFixed(2));
    assert.deepEqual(encoded.spot_twap_delta_cents.map(price),[state.spot,state.twap]);
    assert.equal(encoded.margin_cents/100,state.margin_usd);
    assert.deepEqual(encoded.bars_30s_OHLC_delta_cents_oldest_first.map(b=>b.map(price)),state.bars_30s_OHLC_oldest_first);
    assert.deepEqual(encoded.returns_millibps_5_15_30_60_180.map(v=>v/1000),state.returns_bps_5_15_30_60_180);
    assert.equal(encoded.sigma_milliusd_sqrt_s/1000,state.volatility_usd_sqrt_s);
    assert.deepEqual(encoded.books_price_cents_up_down[0].asks[0],[73.57,10.25]);
    assert.deepEqual(encoded.fee,[state.fee_rate,state.fee_exponent]);assert.deepEqual(encoded.allowed,state.allowed);
    assert.equal(encoded.seconds,state.seconds);assert.equal(encoded.shares,state.shares);assert.equal(encoded.cap_usd,state.entry_cap);
});
test('exact mirrored books round trip; a differing level or quantity keeps both full books',()=>{
    const f=fixture(),state=makeFeatures(f.signal,f.market,f.getBooks(),f.ws,f.now).state;
    state.allowed=['BUY_UP'];state.limit_cost_up_down=[[79,4.1],null];
    state.books_up_down=[{bids:[[.7357,10.25],[.73,4]],asks:[[.74,9],[.75,8]]},
        {bids:[[.26,9],[.25,8]],asks:[[.2643,10.25],[.27,4]]}];
    const input=encodeFeatures(state),encoded=JSON.parse(input);
    assert.equal(encoded.down,'mirror_up');
    assert.deepEqual(expandInput(compactInput(expandInput(input))),expandInput(input));
    assert.deepEqual(expandInput(input).books_price_cents_up_down[1],{bids:[[26,9],[25,8]],asks:[[26.43,10.25],[27,4]]});
    for(const change of [s=>s.books_up_down[1].asks[0][1]=10.26,s=>s.books_up_down[1].asks[0][0]=.2644,
        s=>s.books_up_down[1].asks.pop(),s=>s.books_up_down[1].asks.reverse()]){
        const next=structuredClone(state);change(next);const row=JSON.parse(encodeFeatures(next));
        assert.ok(Array.isArray(row.down));
        assert.equal(expandInput(row).books_price_cents_up_down[1].asks.length,next.books_up_down[1].asks.length);
    }
});
function ageFeed(f,ms=2500) {
    f.signal.spot=f.signal.spot.filter(p=>p.at<=f.now-ms);
    f.signal.twap={...f.signal.twap,at:f.now-ms,receivedAt:f.now-ms+1000};
    f.config.snapshotWaitMs=1000;f.config.snapshotAgeTargetMs=1650;f.config.snapshotSlotReserveMs=100;
}
test('snapshot waits for a real fresh update within the slot, with identical causal input for both engines',async()=>{
    const f=fixture(),start=f.now;ageFeed(f);
    f.engine.sleep=async ms=>{f.advance(ms);if(f.now-start===400){
        f.signal.ingest({topic:'prices.crypto',type:'update',payload:{symbol:'btcusd',timestamp:f.now-1000,value:83021}},f.now);
        f.signal.ingest({topic:'prices.crypto.twap',type:'update',payload:{symbol:'btcusd',timestamp:f.now-1000,value:83020,windowSeconds:60}},f.now);
    }};
    await f.engine.observe(f.market,90,f.market.slug+':90');
    const snapshot=f.state.snapshots[0];
    assert.equal(snapshot.timing.waitMs,400);assert.equal(snapshot.timing.beforeAgeMs,3000);
    assert.equal(snapshot.timing.inputAgeMs,1000);assert.equal(snapshot.timing.targetMet,true);
    assert.equal(snapshot.observedAt,start-600);assert.equal(snapshot.at,start+400);
    assert.equal(snapshot.state.seconds,89.6);assert.equal(snapshot.state.spot,83021);
    assert.equal(f.seen[0].s,f.seen[1].s);assert.equal(snapshot.timing.feedIngestLagMs.spot,1000);
});
test('fresh data incurs no wait and the 3s decision plus 5s freshness guards still reject late input',async()=>{
    const f=fixture();f.config.snapshotWaitMs=1000;f.config.snapshotAgeTargetMs=1650;
    f.engine.sleep=()=>assert.fail('fresh source should not wait');
    await f.engine.observe(f.market,90,f.market.slug+':90');assert.equal(f.state.snapshots[0].timing.waitMs,0);
    const g=fixture();ageFeed(g);g.engine.sleep=async ms=>g.advance(ms);
    g.providers.predict=async(name,s)=>{if(name==='laya')g.advance(1600);return {snapshotId:s.snapshotId,status:'ok',action:'BUY_UP'};};
    await g.engine.observe(g.market,90,g.market.slug+':90');
    assert.equal(g.state.snapshots[0].timing.waitMs,1000);
    assert.equal(g.state.snapshots[0].decisions.laya.entryDisposition,'stale_input');
    assert.equal(g.state.snapshots[0].decisions['9router'].entryDisposition,'stale_input');
    assert.equal(g.state.arms.laya.position,null);assert.equal(g.state.arms['9router'].position,null);
});
test('freshness wait reserves slot headroom and never extends the decision/deadline window',async()=>{
    const f=fixture();f.advance(1800);ageFeed(f);f.engine.sleep=async ms=>f.advance(ms);
    await f.engine.observe(f.market,90,f.market.slug+':90');
    assert.equal(f.state.snapshots[0].timing.waitMs,100);assert.equal(f.state.snapshots[0].at,f.market.end-88100);
    const g=fixture();ageFeed(g);g.config.deadline=g.now+100;
    g.engine.sleep=async ms=>g.advance(ms+200);
    await assert.rejects(g.engine.observe(g.market,90,g.market.slug+':90'),/slot_late_after_validation/);
    assert.equal(g.seen.length,0);assert.equal(g.state.snapshots.length,0);
});
test('a stream gap, metadata change or invalid clock during the wait cannot trigger a request',async()=>{
    for(const mutate of [f=>f.ws.generation++,f=>f.market.minimum=6,f=>f.engine.clockValid=false]){
        const f=fixture();ageFeed(f);f.engine.sleep=async ms=>{f.advance(ms);mutate(f);};
        await assert.rejects(f.engine.observe(f.market,90,f.market.slug+':90'));
        assert.equal(f.seen.length,0);assert.equal(f.state.snapshots.length,0);
    }
});
test('actual late inference latency is reported separately from the decision timeout',()=>{
    const f=fixture();f.state.snapshots=[{market:f.market.slug,decisions:{laya:{status:'decision_timeout',latencyMs:3000,actualLatencyMs:8400,cost:0}}}];
    const r=summarize(f.state,f.config,f.market.end+1000).arms.laya;
    assert.equal(r.latencyMs.p95,8400);assert.equal(r.latencyMs.completedResponses,1);assert.equal(r.decisionWaitingMs.p95,3000);
});
test('explicit archive preserves losses and stops, then starts a separate virtual period',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ai-shadow-archive-'));
    try {const f=fixture(),s=new ShadowStore({...f.config,dataDir:dir});
        s.state.arms.laya.cash=9;s.state.arms.laya.stopped={reason:'prior_loss'};s.save();
        const archived=archiveActivePeriod(dir,'latency-optimization',f.now+1000);
        assert.equal(archived.deadline,DEADLINE);assert.equal(archived.frozenAt,f.now+1000);
        assert.equal(archived.arms.laya.cash,9);assert.equal(archived.arms.laya.stopped.reason,'prior_loss');
        assert.ok(fs.existsSync(path.join(dir,'test','archived-active.json')));
        const next=new ShadowStore({...f.config,dataDir:dir,id:'next'});
        assert.equal(next.state.arms.laya.cash,20);assert.equal(next.state.arms.laya.stopped,null);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'test','ledger.json'))).arms.laya.cash,9);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('archive refuses inventory or an undrained inference and keeps the active marker',()=>{
    for(const kind of ['position','inference']){
        const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ai-shadow-archive-block-'));
        try {const f=fixture(),s=new ShadowStore({...f.config,dataDir:dir});
            if(kind==='position')s.state.arms.laya.position={status:'filled',holdings:5};
            else s.state.providers.laya={pending:{snapshotId:'pending'}};
            s.save();assert.throws(()=>archiveActivePeriod(dir,'latency-optimization'),/shadow_archive_/);
            assert.ok(fs.existsSync(path.join(dir,'active.json')));
        }finally{fs.rmSync(dir,{recursive:true,force:true});}
    }
});

test('FAK fills a one-tick move with its original limit and reports the worst cost to both AIs',async()=>{
    const f=fixture();await f.engine.observe(f.market,90,f.market.slug+':90');
    const p=f.state.arms.laya.position;
    assert.equal(p.order.snapshotPrice,.78);assert.equal(p.order.price,.79);
    const input=JSON.parse(f.state.snapshots[0].input);
    assert.deepEqual(input.limit_cost_up_down,[[79,p.order.cost],null]);
    f.price(.79);f.advance(300);await f.engine.manage(f.now);
    assert.equal(p.status,'matched');assert.equal(p.order.price,.79);assert.equal(p.fill.notional,3.95);
    assert.equal(p.executionBookSource,'websocket');
});

test('slippage is bounded by one tick, one cent, the 90-cent ceiling and worst-case budget',()=>{
    const f=fixture();f.price(.90);
    assert.equal(candidates(f.market,f.getBooks(),f.config,20,f.now)[0].price,.90);
    f.price(.78);f.market.ticks=[.001,.01];
    assert.equal(candidates(f.market,f.getBooks(),f.config,20,f.now)[0].price,.781);
    f.market.ticks=[.02,.01];
    assert.equal(candidates(f.market,f.getBooks(),f.config,20,f.now)[0].price,.78);
    f.market.ticks=[.01,.01];
    const exact=candidates(f.market,f.getBooks(),{...f.config,limitSlippageTicks:0},20,f.now)[0].cost;
    assert.equal(candidateChecks(f.market,f.getBooks(),{...f.config,entryCap:exact},20,f.now)[0].reason,'entry_budget_exceeded');
});

test('pending execution uses fresh validated WebSocket depth without another REST read',async()=>{
    const f=fixture();await f.engine.observe(f.market,90,f.market.slug+':90');
    let calls=0;f.client.books=async()=>{calls++;throw new Error('REST_must_not_block_execution');};
    f.advance(300);await f.engine.manage(f.now);
    assert.equal(calls,0);assert.equal(f.state.arms.laya.position.status,'matched');
    assert.equal(f.state.arms.laya.position.executionLatencyMs,300);
});

test('fresher WebSocket book determines the initial fixed limit after REST validation',async()=>{
    const f=fixture();f.client.books=async()=>f.getBooks().map(b=>({...b,timestamp:f.now-1000,
        asks:b.tokenId==='up'?[{price:.76,size:10}]:b.asks}));
    await f.engine.observe(f.market,90,f.market.slug+':90');
    assert.equal(f.state.snapshots[0].bookSource,'websocket');
    assert.equal(f.state.arms.laya.position.order.snapshotPrice,.78);
    assert.equal(f.state.arms.laya.position.order.price,.79);
});

test('stream identity, tick, generation, metadata age and future/stale data fail closed',()=>{
    for(const mutate of [
        (f,v)=>{f.ws.tokens=['other','down'];},
        (f,v)=>{f.ws.generation++;},
        (f,v)=>{f.market.minimum=6;},
        (f,v)=>{f.market.fee={...f.market.fee,rate:.08};},
        (f,v)=>{v.at=f.now-5001;},
        (f,v)=>{v.at=f.now+1;},
        (f,v)=>{f.ws.snapshot=()=>f.getBooks().map(b=>({...b,conditionId:'other'}));},
        (f,v)=>{f.ws.snapshot=()=>f.getBooks().map(b=>({...b,tick:.001}));},
        (f,v)=>{f.ws.snapshot=()=>f.getBooks().map(b=>({...b,timestamp:f.now+1}));},
        (f,v)=>{f.ws.snapshot=()=>f.getBooks().map(b=>({...b,timestamp:f.now-5001}));},
        (f,v)=>{f.ws.snapshot=()=>f.getBooks().map(b=>({...b,fetchedAt:f.now+1}));},
        (f,v)=>{f.ws.snapshot=()=>f.getBooks().map(b=>({...b,asks:[{price:.785,size:5}]}));},
    ]){
        const f=fixture(),validation={at:f.now,generation:f.ws.generation,identity:metadataIdentity(f.market)};
        mutate(f,validation);assert.throws(()=>validatedStreamBooks(f.ws,f.market,validation,f.now));
    }
});

test('a stream gap after inference never fills or repeats the reserved attempt',async()=>{
    const f=fixture();await f.engine.observe(f.market,90,f.market.slug+':90');f.ws.generation++;f.advance(300);
    await f.engine.manage(f.now);
    const arm=f.state.arms.laya;
    assert.equal(arm.position,null);assert.equal(arm.cash,20);
    assert.equal(arm.outcomes[f.market.slug].code,'execution_metadata_changed_or_expired');
    f.engine.apply('laya',{status:'ok',action:'BUY_UP'},f.state.snapshots[0],f.market,
        candidates(f.market,f.getBooks(),f.config,20,f.now));
    assert.equal(arm.position,null);assert.equal(Object.keys(arm.seen).length,1);
});

test('an arm waiting for valuation HTTP cannot delay another pending arm',async()=>{
    const f=fixture();await f.engine.observe(f.market,90,f.market.slug+':90');
    const control=f.state.arms.control;
    Object.assign(control.position,{status:'filled',holdings:5,entryCost:4,fees:0});control.cash=16;
    let release;f.client.books=()=>new Promise(resolve=>{release=resolve;});
    f.advance(300);const task=f.engine.manage(f.now);
    assert.equal(f.state.arms.laya.position.status,'matched');
    assert.equal(f.state.arms['9router'].position.status,'matched');
    release(f.getBooks());await task;
});

test('no-fill opportunities report price-range reasons separately from transport errors',async()=>{
    const f=fixture();f.price(.95);
    await assert.rejects(f.engine.observe(f.market,90,f.market.slug+':90'),/no_valid_side/);
    assert.deepEqual(f.state.opportunitySkips,{ask_above_entry_maximum:1,ask_below_entry_minimum:1});
    const report=summarize(f.state,f.config,f.now);
    assert.deepEqual(report.opportunitySkips,f.state.opportunitySkips);
    assert.equal(f.seen.length,0);
});

test('entry reports distinguish late decisions from stale inputs and execution failures',()=>{
    const f=fixture(),allowed=candidates(f.market,f.getBooks(),f.config,20,f.now);
    const late={status:'ok',action:'BUY_UP'};
    f.engine.apply('laya',late,{snapshotId:'late',at:f.now-3001,observedAt:f.now-3001},f.market,allowed);
    assert.equal(late.entryDisposition,'late_response');
    const stale={status:'ok',action:'BUY_UP'};
    f.engine.apply('laya',stale,{snapshotId:'stale',at:f.now,observedAt:f.now-5001},f.market,allowed);
    assert.equal(stale.entryDisposition,'stale_input');
    f.state.snapshots=[{market:f.market.slug,decisions:{laya:stale}}];
    f.state.arms.laya.seen[f.market.slug]={};
    f.state.arms.laya.outcomes[f.market.slug]={pnl:0,reason:'execution_expired',code:'execution_tick_mismatch'};
    const report=summarize(f.state,f.config,f.now);
    assert.equal(report.arms.laya.entryDispositions.stale_input,1);
    assert.equal(report.arms.laya.executionFailureReasons.execution_tick_mismatch,1);
    assert.equal(report.arms.laya.attempts,1);
});

test('a lagging coarser WebSocket tick requires matching authoritative endpoints and aligned levels',async()=>{
    const f=fixture();f.market.ticks=[.001,.001];
    f.ws.snapshot=()=>f.getBooks().map(b=>({...b,tick:.01}));
    const validation={at:f.now,generation:f.ws.generation,identity:metadataIdentity(f.market)};
    assert.throws(()=>validatedStreamBooks(f.ws,f.market,validation,f.now),/execution_tick_mismatch/);
    f.client.tickSize=async()=>.001;
    assert.equal((await verifyStreamSnapshot(f.client,f.ws,f.market,validation,()=>f.now)).length,2);
    f.client.tickSize=async()=>.01;
    await assert.rejects(verifyStreamSnapshot(f.client,f.ws,f.market,{...validation},()=>f.now),/execution_tick_mismatch/);
});

test('a tick verification arriving after the snapshot slot produces no inference or fill',async()=>{
    const f=fixture();f.ws.snapshot=()=>f.getBooks().map(b=>({...b,tick:.1}));
    f.client.tickSize=async()=>{f.advance(1100);return .01;};
    await assert.rejects(f.engine.observe(f.market,90,f.market.slug+':90'),/slot_late_after_validation/);
    assert.equal(f.seen.length,0);assert.equal(f.state.arms.laya.position,null);
});

test('a tick-change message closes the stream and invalidates prior warmup',()=>{
    let terminated=0;const ws=new BookHistory({clock:()=>1000000});
    ws.tokens=['up','down'];ws.socket={terminate(){terminated++;}};
    for(const asset_id of ws.tokens)ws.ingest({event_type:'book',asset_id,market:'m',tick_size:'.01',timestamp:1000000,
        bids:[{price:'.77',size:'10'}],asks:[{price:'.78',size:'10'}]});
    const generation=ws.generation;ws.ingest({event_type:'tick_size_change',timestamp:1000000});
    assert.equal(terminated,1);assert.ok(ws.generation>generation);assert.equal(ws.snapshot(1000000,false),null);
});

test('full WebSocket updates may omit tick_size without erasing a previously advertised tick',()=>{
    let now=1000000;const ws=new BookHistory({clock:()=>now});ws.tokens=['up','down'];
    const row={event_type:'book',market:'m',tick_size:'.01',timestamp:now,bids:[{price:'.77',size:'10'}],asks:[{price:'.78',size:'10'}]};
    for(const asset_id of ws.tokens)ws.ingest({...row,asset_id});
    now+=1000;const {tick_size,...update}=row;
    ws.ingest({...update,asset_id:'up',timestamp:now});
    assert.equal(ws.snapshot(now,false)[0].tick,.01);
});

test('a book without an advertised tick still needs CLOB verification and legal prices',async()=>{
    const f=fixture();f.ws.snapshot=()=>f.getBooks().map(b=>({...b,tick:undefined}));
    const validation={at:f.now,generation:f.ws.generation,identity:metadataIdentity(f.market)};
    assert.throws(()=>validatedStreamBooks(f.ws,f.market,validation,f.now),/execution_tick_mismatch/);
    f.client.tickSize=async()=>.01;
    assert.equal((await verifyStreamSnapshot(f.client,f.ws,f.market,validation,()=>f.now)).length,2);
    f.ws.snapshot=()=>f.getBooks().map(b=>({...b,tick:undefined,asks:[{price:.785,size:5}]}));
    assert.throws(()=>validatedStreamBooks(f.ws,f.market,validation,f.now),/execution_book_invalid/);
});

test('an entry arriving during another arm HTTP read executes on the next management tick',async()=>{
    const f=fixture();await f.engine.observe(f.market,90,f.market.slug+':90');
    const laya=f.state.arms.laya,waiting=laya.position;laya.position=null;f.state.arms['9router'].position=null;
    const control=f.state.arms.control;
    Object.assign(control.position,{status:'filled',holdings:5,entryCost:4,fees:0});control.cash=16;
    let release,calls=0;f.client.books=()=>new Promise(resolve=>{calls++;release=resolve;});
    const first=f.engine.manage(f.now);assert.equal(calls,1);
    laya.position=waiting;f.advance(300);await f.engine.manage(f.now);
    assert.equal(laya.position.status,'matched');assert.equal(laya.position.executionLatencyMs,300);assert.equal(calls,1);
    release(f.getBooks());await first;assert.equal(f.engine.managingArms.size,0);
});
