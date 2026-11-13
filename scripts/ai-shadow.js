import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { setTimeout as delay } from 'node:timers/promises';
import { TradingClient } from '../src/restart/client.js';
import { acquireLock, atomicJson } from '../src/restart/store.js';
import { loadConfig } from '../src/ai-shadow/config.js';
import { ShadowStore, archiveActivePeriod } from '../src/ai-shadow/store.js';
import { BookHistory } from '../src/ai-shadow/history.js';
import { ProviderManager } from '../src/ai-shadow/providers.js';
import { ShadowEngine, metadataIdentity, verifyStreamSnapshot } from '../src/ai-shadow/engine.js';
import { saveReport, summarize } from '../src/ai-shadow/report.js';

dotenv.config({path:path.join(os.homedir(),'.config/polymarket-ai-shadow.env'),quiet:true});
const [command='preflight',...flags]=process.argv.slice(2);
if(!['preflight','run','report','archive'].includes(command) || flags.some(f=>!['--history','--smoke'].includes(f) && !(command==='archive' && /^--reason=[a-z][a-z0-9_-]{2,80}$/.test(f))))throw new Error('Use ai-shadow preflight|run|report --history|archive --reason=...');
if(flags.includes('--history') && command!=='report' || flags.includes('--smoke') && command!=='preflight')throw new Error('Invalid command option');
const config=loadConfig();

// The experiment receives a read-only facade. No order, signing or transaction API is exposed.
function reader(onEvent) {
    const raw=new TradingClient(config.control);raw.onEvent=event=>onEvent?.(event);
    return {btc:raw.btc,market:raw.market.bind(raw),books:raw.books.bind(raw),payout:raw.payout.bind(raw),
        serverTime:raw.serverTime.bind(raw),tickSize:raw.tickSize.bind(raw),startBtcFeed:raw.startBtcFeed.bind(raw),close:raw.close.bind(raw)};
}
async function main() {
    fs.mkdirSync(config.dataDir,{recursive:true,mode:0o700});
    if(command==='archive') {
        if(flags.length!==1 || !flags[0].startsWith('--reason='))throw new Error('archive_reason_required');
        const release=await acquireLock(config.dataDir,'shadow');
        try {
            const marker=JSON.parse(fs.readFileSync(path.join(config.dataDir,'active.json')));
            const manifest=JSON.parse(fs.readFileSync(path.join(config.dataDir,marker.id,'manifest.json')));
            if(manifest.policy.controlBaseline!==config.control.fingerprint)throw new Error('shadow_archive_control_changed');
            const state=archiveActivePeriod(config.dataDir,flags[0].slice('--reason='.length));
            const result=summarize(state,{...config,...manifest.policy,id:state.id});
            atomicJson(path.join(config.dataDir,state.id,'reports/archive.json'),result);
            atomicJson(path.join(config.dataDir,state.id,'reports/latest.json'),result);
            console.log(JSON.stringify({id:state.id,archivedAt:state.archivedAt,reason:state.archiveReason,deadline:state.deadline}));
        }finally{await release();}
        return;
    }
    if(command==='report') {
        console.log(JSON.stringify(saveReport(config,flags.includes('--history')),null,2));return;
    }
    if(Date.now()>=config.deadline && !fs.existsSync(path.join(config.dataDir,config.id,'ledger.json')))throw new Error('deadline_elapsed');
    if(command==='preflight') {
        const client=reader(),providers=new ProviderManager(config,{});
        try {
            const server=await client.serverTime(),serverSkewMs=Math.round(server-Date.now()),result=await providers.preflight();
            const market=await client.market(`btc-updown-5m-${Math.floor(Date.now()/300000)*300}`),books=await client.books(market);
            const output={at:new Date().toISOString(),id:config.id,paperOnly:true,deadline:new Date(config.deadline).toISOString(),
                controlBaseline:config.control.fingerprint,serverSkewMs,providers:result,
                market:{slug:market.slug,tokens:market.tokens,minimum:market.minimum,ticks:market.ticks,fee:market.fee,
                    bestAsk:books.map(b=>b.asks[0]?.price??null)}};
            if(flags.includes('--smoke')) {
                const ws=new BookHistory();ws.watch(market.tokens);client.startBtcFeed();
                try {const until=Date.now()+15000;
                    while(Date.now()<until && (!client.btc.status().ready || !ws.snapshot(Date.now(),false)))await delay(100);
                    output.feed=client.btc.status();output.websocketBooksReady=!!ws.snapshot(Date.now(),false);
                    if(!output.feed.ready || !output.websocketBooksReady)process.exitCode=1;
                    if(output.websocketBooksReady){
                        const generation=ws.generation;await client.books(market);
                        const at=Date.now(),validation={at,generation,identity:metadataIdentity(market)};
                        // Public smoke checks identity/ticks/freshness only;
                        // every trading snapshot still requires 180s warmup.
                        const stream=await verifyStreamSnapshot(client,ws,market,validation,Date.now,config.dataAgeMs,false);
                        output.executionBookValidation={source:'websocket',tokensMatch:true,ticks:stream.map(b=>b.tick),
                            ageMs:stream.map(b=>at-b.timestamp),warmupComplete:!!ws.snapshot(at)};
                    }
                }finally{ws.close();}
            }
            console.log(JSON.stringify(output,null,2));
            if(!result.laya.ready || !result['9router'].ready)process.exitCode=1;
        }finally{providers.close();client.close();}
        return;
    }
    const release=await acquireLock(config.dataDir,'shadow');let engine,ending=false;
    const end=()=>{ending=true;if(engine)engine.closed=true;};process.on('SIGINT',end);process.on('SIGTERM',end);
    try {
        const store=new ShadowStore(config),providers=new ProviderManager(config,store.state.providers,(type,detail)=>{
            if(type==='provider_late_response') {
                const decision=store.state.snapshots.find(s=>s.snapshotId===detail.snapshotId)?.decisions[detail.provider];
                if(decision){decision.lateDecision=detail.action;decision.cost=detail.cost;decision.usage=detail.usage;decision.actualLatencyMs=detail.latencyMs;}
            }
            store.event(type,detail);
        });
        const client=reader(event=>{
            if(['btc_feed_gap','btc_feed_failed','btc_feed_connected'].includes(event.type))store.event(event.type);
            if(event.type==='read_failed')store.error(event.error?.stage||'public_read',event.error);
        }),books=new BookHistory({onEvent:type=>store.event(type)});
        engine=new ShadowEngine(config,store,client,books,providers);
        const providerHealth=await providers.preflight();
        store.event('started',{providers:providerHealth,controlBaseline:config.control.fingerprint,deadline:new Date(config.deadline).toISOString()});
        client.startBtcFeed();let nextReport=0,checkpoint24=false,lastProviderProbe=Date.now(),probing=false;
        while(!ending){
            const now=Date.now();store.freeze(now);
            try{await engine.tick(now);}catch(error){store.error('tick',error);}
            if(!probing && now-lastProviderProbe>=30000 && !store.state.frozenAt){probing=true;lastProviderProbe=now;
                engine.launch(providers.preflight().then(health=>store.event('provider_health',{providers:health})).finally(()=>{probing=false;}));}
            if(!nextReport || now>=nextReport || !checkpoint24 && now-store.state.startedAt>=86400000 || now>=config.deadline && !store.state.deadlineReportSaved){
                const result=saveReport(config,true);nextReport=now+1800000;checkpoint24 ||= now-store.state.startedAt>=86400000;
                if(now>=config.deadline)store.state.deadlineReportSaved=true;
                store.event('report_saved',{decision:result.decision,frozenAt:store.state.frozenAt});
            }
            const labelsPending=store.state.snapshots.some(s=>!store.state.markets[s.market]?.payout);
            if(store.state.frozenAt && !Object.values(store.state.arms).some(a=>a.position) && !engine.tasks.size && !labelsPending)break;
            await delay(100);
        }
        store.freeze();store.save();saveReport(config,true);
    }finally{if(engine){engine.closed=true;await Promise.allSettled([...engine.tasks]);
            await Promise.allSettled([...engine.providers.active.values()]);engine.close();}
        await release();process.off('SIGINT',end);process.off('SIGTERM',end);}
}
main().catch(error=>{console.error(JSON.stringify({type:'ai_shadow_failed',code:error.code ||
    (/^[a-z][a-z0-9_]{1,80}$/.test(error.message||'')?error.message:error.name||'Error'),
    ...(error.tickContext?{tickContext:error.tickContext}:{})}));process.exitCode=1;});
