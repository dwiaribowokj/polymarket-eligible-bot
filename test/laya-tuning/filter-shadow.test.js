import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { hash, RULES, createExperiment, validateExperiment, observe, report } from '../../src/laya-filter-shadow/evaluation.js';
import { parseArgs } from '../../scripts/laya-filter-shadow.js';

const registeredAt = 1_800_000, at = 2_310_000, marketEnd = 2_400_000;
const protocol = { protocolVersion: 'v1', variantId: 'candidate-v2', promptVersion: 'p1', promptHash: 'a'.repeat(64), questionsHash: 'b'.repeat(64) };
const id = '1'.repeat(24), epoch = 'epoch1', market = 'btc-updown-5m-2100';
const conditionId='0x'+'c'.repeat(64);
function source() {
    return { baseline: 'financial1', mode: 'pilot', strategy: 'late-entry', decisionProvider: 'laya',
        ai: { currentEvaluationEpochId: epoch, evaluationEpochs: [{ id: epoch, protocol }],
            providers: { laya: { tokenizerIdentity: 'tokenizer1' } }, snapshots: [] }, completed: [], position: null };
}
function snap({ price = .84, delta = [100,50], action = 'BUY_UP', snapshotId = id } = {}) {
    const index = action === 'BUY_UP' ? 0 : 1, cost = price * 5 + .1;
    const limits = [null,null]; limits[index] = [Math.round(price * 100 * 100) / 100,cost];
    const input = JSON.stringify({ seconds: 90, shares: 5, cap_usd: 5, delta_cents: delta,
        limit_cost_up_down: limits, allowed: [action] });
    return { snapshotId, market, at, observedAt: at - 500, slot: 90, evaluationEpochId: epoch,
        decisionProtocol: protocol, input, inputHash: hash(input), validation:{identity:JSON.stringify([conditionId])},
        allowed: [{ index, price, shares: 5, cost }] };
}
function register(s = source()) {
    return createExperiment(s, { now: registeredAt, sourcePath: '/private/source.json', codeHash: 'code1', sourceHash: 'source1' });
}
function decide(snapshot, action = 'BUY_UP', status = 'ok') {
    snapshot.decisionReceivedAt = at + 2800;
    snapshot.decision = { action, status, model: 'typed-decisions', receivedAt: at + 2800, latencyMs: 2700 };
}
function complete(s, { pnl = 1, uncertain = false, partial = false } = {}) {
    const snapshot = s.ai.snapshots[0];
    s.completed = [{ slug: market, conditionId, closedAt: marketEnd + 10000, traded: true, pnl, fees: .1, gas: .01,
        entryCost: 4.3, uncertain, partial, payout: pnl > 0 ? [1,0] : [0,1],
        entrySignal: { snapshotId: snapshot.snapshotId, inputHash: snapshot.inputHash, evaluationEpochId: epoch,
            action: snapshot.decision.action, model: 'typed-decisions' } }];
}
function captured(options) {
    const s = source(), e = register(s), snapshot = snap(options);
    s.ai.snapshots.push(snapshot); observe(e,s,at + 100);
    return { s,e,snapshot };
}

test('registration excludes historical inputs and starts at a fresh whole market', () => {
    const s = source(); s.ai.snapshots.push(snap());
    const e = register(s); validateExperiment(e,'code1');
    observe(e,s,at + 100);
    assert.equal(e.captures.length,0); assert.equal(e.manifest.firstMarketOpenAt,2_100_000);
    assert.equal(e.manifest.automaticLiveChanges,false);
    const altered = structuredClone(e); altered.manifest.rules.priceCap = .9;
    assert.throws(() => validateExperiment(altered,'code1'), /experiment_changed/);
    assert.throws(() => validateExperiment(e,'othercode'), /experiment_changed/);
});

test('captures both sides before inference outcome, freezes alignment and price verdicts', () => {
    const { e,s } = captured();
    assert.equal(e.captures.length,1); assert.equal(e.captures[0].decision,null);
    assert.deepEqual(e.captures[0].sides.BUY_UP.verdicts,{ control: true, 'spot-twap': true, 'price-cap-085': true, combined: true });
    assert.equal(JSON.stringify(e).includes('confidence'),false);
    const before = JSON.stringify(s); report(e,at + 100); assert.equal(JSON.stringify(s),before);
    const down = captured({ action:'BUY_DOWN',delta:[-100,-50],price:.88 });
    assert.deepEqual(down.e.captures[0].sides.BUY_DOWN.verdicts,{ control:true, 'spot-twap':true, 'price-cap-085':false, combined:false });
});

test('zero and disagreement veto alignment; fixed boundary .85 is inclusive', () => {
    for (const delta of [[0,100],[100,-1],[-1,-1]]) {
        const {e}=captured({delta,price:.85});
        assert.equal(e.captures[0].sides.BUY_UP.verdicts['spot-twap'],false);
        assert.equal(e.captures[0].sides.BUY_UP.verdicts['price-cap-085'],true);
    }
});

test('fractional cent ticks keep exact limit price and compact cents consistent', () => {
    const {e}=captured({price:.748});
    assert.equal(e.captures.length,1);
    assert.equal(e.captures[0].sides.BUY_UP.limitPrice,.748);
    assert.equal(e.captures[0].sides.BUY_UP.verdicts['price-cap-085'],true);
});

test('late observer, stale/future input, wrong hash and malformed costs never backfill', () => {
    const variants = [
        s => { decide(s.ai.snapshots[0]); return at + 3000; },
        s => { decide(s.ai.snapshots[0]); s.ai.snapshots[0].decisionReceivedAt=at+999999; return at+100; },
        s => at + 6000,
        s => { s.ai.snapshots[0].observedAt = at + 1; return at + 100; },
        s => { s.ai.snapshots[0].inputHash = 'wrong'; return at + 100; },
        s => { s.ai.snapshots[0].allowed[0].cost = NaN; return at + 100; },
        s => marketEnd + 10,
    ];
    for (const change of variants) {
        const s=source(),e=register(s);s.ai.snapshots.push(snap());
        observe(e,s,change(s)); assert.equal(e.captures.length,0);assert.equal(e.excluded.length,1);
        observe(e,s,Math.max(e.lastPollAt,marketEnd + 100));assert.equal(e.captures.length,0);
    }
});

test('known payout and completed market prohibit prospective capture', () => {
    for(const change of [s => s.completed.push({ slug:market }),s => s.position={market:{slug:market},payout:[1,0]}]) {
        const s=source(),e=register(s);s.ai.snapshots.push(snap());change(s);observe(e,s,at + 100);
        assert.equal(e.captures.length,0);assert.equal(e.excluded[0].reason,'outcome_already_known');
    }
});

test('paired PnL counts fees and gas once; missed win and avoided loss are explicit', () => {
    const {s,e,snapshot}=captured({delta:[100,-50],price:.88});
    decide(snapshot);observe(e,s,at + 3000);complete(s,{pnl:-4.3,partial:true});observe(e,s,marketEnd + 11000);
    let v=report(e,marketEnd + 11000);
    assert.equal(v.candidates.control.conditionalPnl,-4.3);
    assert.equal(v.candidates.combined.conditionalPnl,0);
    assert.equal(v.candidates.combined.differenceFromControl,4.3);
    assert.equal(v.candidates.combined.avoidedLosses,1);
    assert.equal(e.scores[0].partial,true);assert.equal(v.candidates.control.aiComputeCost,null);
    assert.equal(v.minimumEvidence,false);assert.equal(v.candidates.control.uncertainty,null);
    const winner=captured({delta:[100,-50],price:.88});decide(winner.snapshot);complete(winner.s,{pnl:.8});observe(winner.e,winner.s,marketEnd + 11000);
    v=report(winner.e,marketEnd + 11000);assert.equal(v.candidates.combined.missedWins,1);
    assert.equal(v.candidates.combined.differenceFromControl,-.8);
});

test('restart and repeated polls preserve manifest and score once; uncertainty waits', () => {
    const {s,e,snapshot}=captured();decide(snapshot);complete(s,{uncertain:true});observe(e,s,marketEnd + 11000);
    assert.equal(e.scores.length,0);assert.equal(e.captures[0].status,'uncertain_completion');
    const resumed=JSON.parse(JSON.stringify(e));validateExperiment(resumed,'code1');
    s.completed[0].uncertain=false;observe(resumed,s,marketEnd + 12000);observe(resumed,s,marketEnd + 13000);
    assert.equal(resumed.scores.length,1);assert.equal(resumed.id,e.id);
    assert.equal(resumed.captures[0].status,'scored');
});

test('pending official payout, no fill, SKIP and timeout stay separate from filled PnL', () => {
    for (const mode of ['no-fill','no-payout','timeout','skip']) {
        const {s,e,snapshot}=captured();decide(snapshot,mode==='skip'?'SKIP':'BUY_UP',mode==='timeout'?'timeout':'ok');complete(s);
        if(mode==='no-fill')s.completed[0].traded=false;
        if(mode==='no-payout')s.completed[0].payout=null;
        observe(e,s,marketEnd + 11000);assert.equal(e.scores.length,0,mode);
    }
});

test('snapshot mutations, scored result changes and deleted evidence taint results', () => {
    for(const mutation of [s=>s.ai.snapshots[0].input+=' ',s=>s.completed[0].pnl=99,
        s=>s.completed[0].uncertain=true,s=>s.completed=[],s=>s.completed[0].traded=false,
        s=>s.completed[0].payout=null,s=>s.completed[0].fees=NaN,s=>delete s.ai.snapshots[0].decision]) {
        const {s,e,snapshot}=captured();decide(snapshot);complete(s);observe(e,s,marketEnd + 11000);
        mutation(s);observe(e,s,marketEnd + 12000);
        assert.equal(report(e,marketEnd + 12000).counts.scored,0);
        assert.ok(e.issues.length);
    }
});

test('restart rejects mutated frozen verdicts even when saved score is changed to match', () => {
    const {s,e,snapshot}=captured();decide(snapshot);complete(s);observe(e,s,marketEnd+11000);
    validateExperiment(e,'code1');
    e.captures[0].sides.BUY_UP.verdicts['spot-twap']=false;e.scores[0].verdicts['spot-twap']=false;
    assert.throws(()=>validateExperiment(e,'code1'),/capture_state_changed/);
});

test('restart reconstructs all score fields and binds saved decisions to settled evidence', () => {
    for (const mutate of [e=>e.scores[0].dayWIB='arbitrary date',e=>e.scores[0].closedAt=1,
        e=>e.captures[0].decision.action='SKIP',e=>e.captures[0].decision.latencyMs=1,
        e=>e.scores[0].actualPnl=99,e=>e.scores[0].payout=[0,0]]) {
        const {s,e,snapshot}=captured();decide(snapshot);complete(s);observe(e,s,marketEnd+11000);
        validateExperiment(e,'code1');mutate(e);
        assert.throws(()=>validateExperiment(e,'code1'),/score_(?:state_changed|evidence_invalid)/);
    }
});

test('prompt/model identity changes latch capture pause while prior positions can settle', () => {
    const {s,e,snapshot}=captured();decide(snapshot);
    s.ai.providers.laya.tokenizerIdentity='other';observe(e,s,at + 3000);
    assert.equal(e.captureStopped.reason,'source_provenance_changed');
    complete(s);observe(e,s,marketEnd + 11000);assert.equal(e.scores.length,1);
    s.ai.providers.laya.tokenizerIdentity='tokenizer1';observe(e,s,marketEnd + 12000);
    assert.ok(e.captureStopped);assert.equal(report(e,marketEnd + 12000).sufficientForLive,false);
});

test('source duplicate IDs, wrong baseline and clock regression are rejected', () => {
    const {s,e}=captured();
    s.ai.snapshots.push(structuredClone(s.ai.snapshots[0]));assert.throws(()=>observe(e,s,at+200),/duplicate_source_snapshot/);
    s.ai.snapshots.pop();s.baseline='other';assert.throws(()=>observe(e,s,at+200),/baseline_changed/);
    s.baseline='financial1';assert.throws(()=>observe(e,s,at),/clock_invalid/);
});

test('a future-dated newly received decision is permanently excluded from reported scores', () => {
    const {s,e,snapshot}=captured();decide(snapshot);observe(e,s,at+200);
    complete(s);observe(e,s,marketEnd+11000);
    assert.equal(report(e,marketEnd+11000).counts.scored,0);
    assert.ok(e.issues.some(i=>i.code==='decision_timing_or_model_invalid'));
});

test('day-cluster intervals require seven days and 100 fills and never promote live', () => {
    const e=register();
    for(let i=0;i<100;i++)e.scores.push({snapshotId:String(i),closedAt:registeredAt+(i%7+1)*86400000,
        dayWIB:'day'+i%7,actualPnl:1,verdicts:{control:true,'spot-twap':true,'price-cap-085':false,combined:false}});
    const v=report(e,registeredAt+8*86400000);
    assert.equal(v.minimumEvidence,true);
    assert.deepEqual(v.candidates.control.uncertainty.meanPnlPerCohortMarket95,[1,1]);
    assert.deepEqual(v.candidates.combined.uncertainty.improvementPerCohortMarket95,[-1,-1]);
    assert.equal(v.automaticPromotion,false);assert.equal(v.sufficientForLive,false);
});

test('CLI paths are explicit and argument duplication rejected', () => {
    assert.equal(parseArgs(['run','--out=/private/out']).command,'run');
    for(const args of [[],['init','--out=/x'],['run','--out=/x','--source=/s'],['report','--out=/x','--out=/y']])
        assert.throws(()=>parseArgs(args),/filter_shadow_/);
});

test('file-only CLI registers, polls and shuts down without touching source or environment', async t => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'laya-filter-shadow-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const filename=path.join(dir,'source.json'),out=path.join(dir,'out');
    fs.writeFileSync(filename,JSON.stringify(source()),{mode:0o600});
    const bytes=fs.readFileSync(filename),cli=path.resolve('scripts/laya-filter-shadow.js');
    const env={PATH:process.env.PATH,PRIVATE_KEY:'INVALID_MUST_NOT_BE_LOADED',NINEROUTER_URL:'invalid'};
    execFileSync(process.execPath,[cli,'init',`--source=${filename}`,`--out=${out}`],{env});
    const child=spawn(process.execPath,[cli,'run',`--out=${out}`],{env,stdio:['ignore','pipe','pipe']});
    t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
    await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('observer_start_timeout')),5000);
        child.stdout.on('data',bytes=>{if(bytes.toString().includes('filter_shadow_heartbeat')){clearTimeout(timer);resolve();}});
        child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);reject(new Error('observer_exited_'+code));});
    });
    const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');assert.equal(await exited,0);
    assert.deepEqual(fs.readFileSync(filename),bytes);
    const v=JSON.parse(execFileSync(process.execPath,[cli,'report',`--out=${out}`],{env,encoding:'utf8'}));
    assert.equal(v.counts.captured,0);assert.ok(v.lastSuccessfulReadAt);
    assert.equal(fs.statSync(path.join(out,'state.json')).mode&0o077,0);
    const code=fs.readFileSync(cli,'utf8')+fs.readFileSync('src/laya-filter-shadow/evaluation.js','utf8');
    assert.equal(/\bfetch\s*\(|dotenv\.config|new (?:Laya|Store)|https?:\/\//.test(code),false);
});
