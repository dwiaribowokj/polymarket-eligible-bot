import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from '../restart/store.js';
import { dailyBootstrap, round } from '../restart/math.js';
import { report as paperReport } from '../restart/report.js';

const percentile=(values,p)=>{if(!values.length)return null;const v=[...values].sort((a,b)=>a-b);return v[Math.floor((v.length-1)*p)];};
const bootstrap=rows=>dailyBootstrap(rows.map(row=>({...row,closedAt:row.closedAt+7*3600000})));
export function summarize(state,config,now=Date.now()) {
    const cohort=Object.entries(state.markets).filter(([slug,m])=>m.end<=now && state.snapshots.some(s=>s.market===slug));
    const arms={};
    for(const [name,arm] of Object.entries(state.arms)){
        const decisions=state.snapshots.map(s=>({market:s.market,...s.decisions[name]})).filter(d=>d.status);
        const charged=decisions.filter(d=>['ok','decision_timeout','provider_error'].includes(d.status));
        const known=charged.reduce((sum,d)=>sum+(d.cost??0),0),unknown=charged.filter(d=>d.cost===null || d.cost===undefined).length;
        const pnl=round(arm.completed.reduce((sum,r)=>sum+r.pnl,0));
        const rows=cohort.filter(([slug])=>arm.position?.market.slug!==slug).map(([slug,m])=>({closedAt:m.end,pnl:arm.outcomes[slug]?.pnl||0}));
        const waiting=decisions.filter(d=>d.latencyMs>0).map(d=>d.latencyMs);
        const latency=decisions.map(d=>d.actualLatencyMs ?? (d.status==='ok'?d.latencyMs:null)).filter(n=>n>0);
        const dispositions=decisions.reduce((counts,d)=>(counts[d.entryDisposition||'unrecorded']=(counts[d.entryDisposition||'unrecorded']||0)+1,counts),{});
        const attempts=Object.keys(arm.seen).length;
        const expired=Object.values(arm.outcomes).filter(r=>r.reason==='execution_expired');
        const executionTimes=arm.completed.map(r=>r.executionLatencyMs).filter(Number.isFinite);
        const signalQuality={};
        for(const kind of ['timely','late']){
            const forecasts=new Map();
            for(const snapshot of state.snapshots){
                const d=snapshot.decisions[name],payout=state.markets[snapshot.market]?.payout;
                const action=kind==='late'?d?.lateDecision:d?.status==='ok'?d.action:null;
                if(!payout || !['BUY_UP','BUY_DOWN'].includes(action) || forecasts.has(snapshot.market))continue;
                forecasts.set(snapshot.market,payout[action==='BUY_UP'?0:1]);
            }
            const labels=[...forecasts.values()];signalQuality[kind]={independentMarkets:labels.length,
                wins:labels.filter(x=>x===1).length,losses:labels.filter(x=>x===0).length,neutral:labels.filter(x=>x>0&&x<1).length};
        }
        arms[name]={completedFilled:arm.completed.length,wins:arm.completed.filter(r=>r.pnl>0).length,losses:arm.completed.filter(r=>r.pnl<0).length,
            tradingPnl:pnl,cash:arm.cash,maxDrawdown:round(arm.drawdown),shadowPilotStop:arm.shadowStop,stopped:arm.stopped,
            activeInventory:arm.position?{slug:arm.position.market.slug,status:arm.position.status,shares:arm.position.holdings,
                pendingShares:arm.position.fill?.shares || 0,entryCost:arm.position.entryCost,mark:arm.position.mark??null}:null,
            apiCostKnown:round(known),apiCostUnknownRequests:unknown,localComputeCost:name==='laya'?'unknown':null,
            netAfterAllAiCost:unknown || name==='laya'?null:round(pnl-known),
            fees:round(arm.completed.reduce((s,r)=>s+r.fees,0)),gas:round(arm.completed.reduce((s,r)=>s+r.gas,0)),
            partialFills:arm.completed.filter(r=>r.partial).length,capitalHours:round(arm.completed.reduce((s,r)=>s+r.capitalHours,0)),
            noFill:Object.values(arm.outcomes).filter(r=>r.reason==='no_fill').length,
            expired:expired.length,attempts,entryDispositions:dispositions,
            executionFailureReasons:expired.reduce((r,o)=>(r[o.code||'unknown']=(r[o.code||'unknown']||0)+1,r),{}),
            executionLatencyMs:{p50:percentile(executionTimes,.5),p95:percentile(executionTimes,.95)},
            decisions:decisions.length,decisionStatus:Object.fromEntries([...new Set(decisions.map(d=>d.status))].map(status=>[status,decisions.filter(d=>d.status===status).length])),
            latencyMs:{p50:percentile(latency,0.5),p95:percentile(latency,0.95),completedResponses:latency.length},
            decisionWaitingMs:{p50:percentile(waiting,0.5),p95:percentile(waiting,0.95)},cohortMarkets:rows.length,signalQuality,
            tradingMeanCi95:bootstrap(rows),liveDecision:'belum_layak_pilot'};
    }
    const differences={};
    for(const name of ['laya','9router']){
        const rows=cohort.filter(([slug])=>!Object.values(state.arms).some(a=>a.position?.market.slug===slug))
            .map(([slug,m])=>({closedAt:m.end,pnl:(state.arms[name].outcomes[slug]?.pnl||0)-(state.arms.control.outcomes[slug]?.pnl||0)}));
        differences[name]={matchedMarkets:rows.length,tradingDifference:round(rows.reduce((s,r)=>s+r.pnl,0)),
            tradingMeanDifferenceCi95:bootstrap(rows),includesSkipAndTimeout:true};
    }
    const finished=!!state.frozenAt && !Object.values(state.arms).some(a=>a.position);
    const operationalIssues=Object.values(state.providers).some(p=>p.disabled || p.unavailable) || Object.values(arms).some(a=>a.stopped ||
        a.decisions>=3 && (a.decisionStatus.decision_timeout||0)>a.decisions/2);
    return {generatedAt:new Date(now).toISOString(),id:state.id,startedAt:new Date(state.startedAt).toISOString(),
        deadline:new Date(config.deadline).toISOString(),frozenAt:state.frozenAt || (now>=config.deadline?config.deadline:null),finished,
        archivedAt:state.archivedAt||null,archiveReason:state.archiveReason||null,
        elapsedHours:round((Math.min(now,state.frozenAt||config.deadline)-state.startedAt)/3600000),lastHeartbeatAt:state.lastHeartbeatAt||null,
        decision:operationalIssues?'perlu perubahan':'lanjut eksperimen',liveDecision:'belum_layak_pilot',
        limitations:['less_than_seven_days','require_100_completed_filled_markets','small_daily_bootstrap_sample','generic_ai_not_calibrated_for_btc',
            ...(Object.values(arms).some(a=>a.apiCostUnknownRequests || a.localComputeCost==='unknown')?['ai_cost_incomplete']:[])],
        bootstrapTimezone:'Asia/Jakarta',arms,differences,providers:state.providers,errors:state.errors,snapshots:state.snapshots.length,
        opportunitySkips:state.opportunitySkips||{},
        officialLabelsPending:cohort.filter(([slug,m])=>!m.payout).length,
        snapshotTiming:{samples:state.snapshots.filter(s=>s.timing).length,
            targetMet:state.snapshots.filter(s=>s.timing?.targetMet).length,
            ...Object.fromEntries(['waitMs','beforeAgeMs','inputAgeMs','validationMs'].map(key=>{
                const values=state.snapshots.map(s=>s.timing?.[key]).filter(Number.isFinite);
                return [key,{p50:percentile(values,.5),p95:percentile(values,.95)}];
            }))},
        slots:Object.values(state.slots).reduce((r,s)=>(r[s.status]=(r[s.status]||0)+1,r),{}),
        currentPaper:paperReport(config.control,now,false)};
}
export function saveReport(config,history=false,now=Date.now()) {
    const active=path.join(config.dataDir,'active.json');
    if(fs.existsSync(active) && JSON.parse(fs.readFileSync(active)).id!==config.id)throw new Error('shadow_baseline_changed_use_saved_reports');
    const filename=path.join(config.dataDir,config.id,'ledger.json');
    if(!fs.existsSync(filename))return {id:config.id,decision:'belum_dimulai',deadline:new Date(config.deadline).toISOString()};
    const result=summarize(JSON.parse(fs.readFileSync(filename)),config,now),dir=path.join(config.dataDir,config.id,'reports');
    atomicJson(path.join(dir,new Date(now).toISOString().replace(/[:.]/g,'-')+'.json'),result);
    atomicJson(path.join(dir,'latest.json'),result);
    if(history)result.history=fs.readdirSync(config.dataDir,{withFileTypes:true}).filter(d=>d.isDirectory() && d.name!==config.id).flatMap(d=>{
        const f=path.join(config.dataDir,d.name,'reports/latest.json');return fs.existsSync(f)?[JSON.parse(fs.readFileSync(f))]:[];
    });
    return result;
}
