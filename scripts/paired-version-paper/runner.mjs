import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, acquireLock } from '../../src/restart/store.js';
import { collectorEvidence, reference, label, json, sha, SnapshotReader } from './inputs.mjs';
import { evaluateTimingArm, loadTimingArm } from './timing.mjs';
import { estimateSubmission } from './submission.mjs';
import { PairedQuoteTape, QUOTE_POLICY, simulatePaperFak } from './quotes.mjs';
import { PairedPaperStore } from './state.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NAMES = ['old','new'];
function ensure(test, code) { if (!test) throw new Error(code); }
const readHash = file => sha(fs.readFileSync(file));
export function sourceHash(root=ROOT) {
    function walk(dir) {
        return fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(e=>{
            const file=path.join(dir,e.name);
            return e.isDirectory()?walk(file):e.isFile() && /\.(?:m?js|json|cjs)$/.test(file)?[file]:[];
        });
    }
    return sha(JSON.stringify([...walk('src'),...walk('scripts/paired-version-paper'),'package.json','package-lock.json']
        .sort().map(f=>[f,readHash(path.join(root,f))])));
}
export async function loadExperiment(file) {
    ensure(process.versions.node.split('.')[0]==='24','node24_required');
    const config=json(file);
    for (const key of ['output','ledger','collector','persistCalibration','submitCalibration'])
        ensure(typeof config[key]==='string' && path.isAbsolute(config[key]),'absolute_paths_required');
    const {protocol:p}=config;
    ensure(Number.isSafeInteger(config.startAt) && config.startAt>0 && p.schema===1
        && p.sourceHash===sourceHash() && readHash(path.join(config.collector,'manifest.json'))===p.collectorManifestSha256
        && readHash(config.persistCalibration)===p.persistSha256 && readHash(config.submitCalibration)===p.submitSha256,
        'experiment_pin_mismatch');
    const collector=json(path.join(config.collector,'manifest.json')), persist=json(config.persistCalibration);
    ensure(collector.id===p.collectorId && collector.policy.readOnly===true,'collector_pin_mismatch');
    ensure(persist.oldToNewPersistRatio>=0.2&&persist.oldToNewPersistRatio<=10,'calibration_invalid');
    const arms={};
    for (const name of NAMES) {
        arms[name]=await loadTimingArm({...config.arms[name],manifestSha256:p.arms[name].manifestSha256,mode:name==='old'?'serial':'overlap'});
        ensure(arms[name].runtimeId===p.arms[name].runtimeId,'runtime_pin_mismatch');
    }
    ensure(p.liveRuntimeId===arms.new.runtimeId && arms.old.runtimeId!==arms.new.runtimeId,'arm_pair_invalid');
    const resolved=f=>fs.realpathSync(f), dataDir=fs.existsSync(config.output)?resolved(config.output):
        path.join(resolved(path.dirname(config.output)),path.basename(config.output));
    const overlap=(a,b)=>a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep);
    for (const d of [config.collector,path.dirname(config.ledger),config.arms.old.root,config.arms.new.root,ROOT])
        ensure(!overlap(dataDir,resolved(d)),'output_not_isolated');
    return {config,p,arms,ratio:persist.oldToNewPersistRatio,submission:json(config.submitCalibration)};
}
function slimQuote(q) {
    if(q.status!=='ready') return {status:q.status,reason:q.reason};
    return {observedAt:q.observedAt,offsetMs:q.offsetMs,generation:q.generation,sourceAt:q.book.timestamp,
        receivedAt:q.book.fetchedAt,tickVerifiedAt:q.tickVerifiedAt,bestAsk:q.book.asks[0]?.price??null,
        bestBid:q.book.bids[0]?.price??null,tick:q.book.tick};
}
export async function scoreArm({arm,snapshot,conditionId,tape,ratio,submission}) {
    const timing=await evaluateTimingArm(arm,snapshot,{oldToNewPersistRatio:ratio});
    const trace={timing};
    const invalid=reason=>({status:'unscorable',reason,trace});
    if(timing.status!=='ready')
        return {status:timing.status==='skip'?'skip':'unscorable',reason:timing.reason,trace};
    const target=estimateSubmission(timing,submission);
    trace.targets=target;
    const selected=snapshot.allowed.find(order=>order.index===timing.index);
    if (!selected || selected.index!==timing.index) return invalid('selected_order_missing');
    const order={side:timing.index===0?'UP':'DOWN',tokenId:timing.tokenId,reserveCost:selected.cost};
    const stages=[['reservation',timing.readyAt],['beforeSigning',target.preSignValidationAt],
        ['beforeSubmit',target.finalValidationAt],['submitReady',target.submitReadyAt]];
    let generation=null;
    for(const [stage,at] of stages) {
        const arrival=stage==='submitReady';
        if(!arrival && at-timing.sourceAt>timing.dataAgeMs)
            return {status:'skip',reason:'source_expired_'+stage,trace};
        const quote=tape.select({slug:snapshot.market,conditionId,tokenId:timing.tokenId,targetAt:at});
        trace[stage]=slimQuote(quote);
        if(quote.status!=='ready') return invalid(stage+'_'+quote.reason);
        if(generation!==null && generation!==quote.generation) return invalid('book_discontinuity_between_stages');
        generation=quote.generation;
        const fill=simulatePaperFak({quote,shares:timing.shares,limitPrice:timing.limitPrice,
            validationIdentity:snapshot.validation.identity,stage:arrival?'arrival':'validation'});
        if(fill.status==='unavailable')return invalid(stage+'_'+fill.reason);
        if(!arrival && (quote.observedAt-timing.sourceAt>timing.dataAgeMs || fill.status==='no_fill'))
            return {status:'skip',reason:stage+'_'+(fill.reason||'expired'),trace};
        if(arrival) return {status:fill.status==='no_fill'?'no_fill':'fill',reason:fill.reason??fill.status,...order,
            readyAt:at,quoteAt:quote.observedAt,bestAsk:fill.bestAsk,principal:fill.principal,fee:fill.fees,gas:fill.gas,
            shares:fill.shares,averagePrice:fill.averagePrice,trace};
    }
}
async function evaluateSlot(ctx,slot,tape,reader,activeSince) {
    const {config,arms,ratio,submission}=ctx,now=Date.now();
    if(activeSince>slot.scheduledAt-QUOTE_POLICY.leadMs || now-slot.scheduledAt>26000)
        return {...slot,status:'missing',reason:'observer_not_present_for_slot'};
    const {snapshot,reason}=await reader.read(slot);
    if(!snapshot) return {...slot,status:'missing',reason};
    const obs=collectorEvidence(config.collector,slot.marketEnd,slot.seconds);
    if(!obs || obs.at>now) return {...slot,status:'unscorable',reason:'collector_slot_not_ready'};
    const {conditionId}=obs, tokens=obs.features.market.tokens;
    const traces=await Promise.all(NAMES.map(name=>scoreArm({arm:arms[name],snapshot,conditionId,tape,ratio,submission})));
    return {...slot,status:'observed',conditionId,tokens,arms:Object.fromEntries(NAMES.map((k,i)=>[k,traces[i]])),
        evidence:{snapshotId:snapshot.snapshotId,sourceInputHash:snapshot.inputHash,collectorHash:obs.features.featureHash}};
}
export async function run(ctx, signal) {
    const {config,p}=ctx, activeSince=Date.now();
    const release=await acquireLock(config.output,'paired-paper');
    let store,tape,reader;
    try {
        reader=new SnapshotReader(config.ledger,p); await reader.read(null);
        store=new PairedPaperStore({directory:config.output,protocol:p,startAt:config.startAt});
        tape=new PairedQuoteTape();
        let nextDiscovery=0, nextReport=0, nextLabels=0;
        while(!signal.aborted) {
            const now=Date.now(), end=(Math.floor(now/300000)+1)*300000;
            if(now>=nextDiscovery && tape.market?.end!==end) {
                nextDiscovery=now+1500;
                const ref=reference(config.collector,end,now); if(ref) tape.watch(ref.features.market);
            }
            // Resolve labels when actually received. A later label may never finance an earlier entry.
            if(now>=nextLabels) {
                nextLabels=now+2000;
                for(const m of store.pendingMarkets()) {
                    if(now<m.marketEnd) continue;
                    const l=label(config.collector,m.conditionId);
                    if(l){const ref=reference(config.collector,m.marketEnd); if(ref)store.settle(l,ref,Date.now());}
                }
            }
            for(let count=0;count<25;count++){
                const slot=store.nextSlot();
                if(slot.scheduledAt+17000>now) break;
                const row=await evaluateSlot(ctx,slot,tape,reader,activeSince);
                const {disposition}=store.recordSlot(row);
                console.log(JSON.stringify({type:'paper_slot',slug:slot.slug,seconds:slot.seconds,at:slot.scheduledAt,
                    reason:row.reason??null,disposition}));
                nextReport=0;
            }
            if(now>=nextReport){
                nextReport=now+15000;
                atomicJson(path.join(config.output,'report.json'),{...store.report(),books:tape.status(),
                    liveTransactions:0,armCommits:Object.fromEntries(NAMES.map(k=>[k,p.arms[k].commit])),
                    scope:'paired_paper_on_observed_live_snapshots',execution:'modeled_submit_ready_and_displayed_depth'});
            }
            await delay(180);
        }
    } finally {
        tape?.close(); if(reader) await reader.close(); store?.close(); await release();
    }
}
async function main([command,file,...extra]) {
    ensure(['check','run','report'].includes(command) && path.isAbsolute(file||'') && !extra.length,'usage_command_absolute_config');
    if(command==='report'){console.log(JSON.stringify(json(path.join(json(file).output,'report.json')),null,2));return;}
    const ctx=await loadExperiment(file);
    if(command==='check'){
        const r=new SnapshotReader(ctx.config.ledger,ctx.p);
        try{await r.read(null);console.log(JSON.stringify({ready:true,versions:NAMES.map(n=>ctx.arms[n].runtimeId),readOnly:true}));}
        finally{await r.close();}return;
    }
    process.umask(0o077);
    const shutdown=new AbortController();for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>shutdown.abort());
    await run(ctx,shutdown.signal);
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)
    main(process.argv.slice(2)).catch(e=>{const code=/^[a-z0-9_]+$/i.test(e.message)?e.message:'paper_service_error';
        console.error(JSON.stringify({type:'paired_paper_failed',code}));process.exitCode=78;});
