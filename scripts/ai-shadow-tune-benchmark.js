// Bounded A/B latency diagnostics using existing local/OAuth providers only.
// No trading engine, order API or production-ledger writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import dotenv from 'dotenv';
import {loadConfig} from '../src/ai-shadow/config.js';
import {ProviderManager,TokenCounter} from '../src/ai-shadow/providers.js';
import {atomicJson} from '../src/restart/store.js';
import {percentiles} from './lib/ai-shadow-profile.js';
import {PROMPT,QUESTIONS,compactInput,expandInput} from './lib/ai-shadow-latency-candidate.js';

dotenv.config({path:path.join(os.homedir(),'.config/polymarket-ai-shadow.env'),quiet:true});
const config=loadConfig(),[arg,sourceArg,...extra]=process.argv.slice(2);
if(extra.length || !/^--samples=[1-8]$/.test(arg||'') || sourceArg && !/^--source-period=[a-zA-Z0-9_-]+$/.test(sourceArg))throw new Error('Use --samples=1..8 [--source-period=ID]');
const count=Number(arg.split('=')[1]);
function idle() {
    const active=execFileSync('systemctl',['--user','show','polymarket-ai-shadow.service','-p','ActiveState','--value'],{encoding:'utf8'}).trim();
    if(active!=='inactive')throw new Error('tune_requires_shadow_stopped');
    const marker=JSON.parse(fs.readFileSync(path.join(config.dataDir,'active.json')));
    if(marker.id!==config.id)throw new Error('tune_baseline_changed');
    const ledger=JSON.parse(fs.readFileSync(path.join(config.dataDir,marker.id,'ledger.json')));
    if(Object.values(ledger.arms).some(a=>a.position) || Object.values(ledger.providers).some(p=>p.pending))throw new Error('tune_requires_drained');
    if(Date.now()>=config.deadline)throw new Error('tune_deadline_elapsed');
    return ledger;
}
const activeLedger=idle(),sourceId=sourceArg?.slice('--source-period='.length)||activeLedger.id;
const ledger=JSON.parse(fs.readFileSync(path.join(config.dataDir,sourceId,'ledger.json')));
const referencePrompt=JSON.parse(fs.readFileSync(path.join(config.dataDir,sourceId,'manifest.json'))).policy.prompt;
if(typeof referencePrompt!=='string')throw new Error('tune_reference_prompt_missing');
const referenceQuestions={action:{...QUESTIONS.action,instructions:referencePrompt}};
const snapshots=ledger.snapshots.slice(-count);
if(snapshots.length!==count)throw new Error('tune_insufficient_history');
for(const s of ledger.snapshots)assert.deepEqual(expandInput(compactInput(s.input)),JSON.parse(s.input));
const dir=path.join(config.dataDir,'validation'),lock=path.join(config.dataDir,'latency-profile.lock');
const uncertain=path.join(dir,'stage-profile-inference-uncertain.json');
if(fs.existsSync(uncertain))throw new Error('tune_inference_uncertain');
const fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,String(process.pid));fs.closeSync(fd);
const artifact=path.join(dir,`latency-tuning-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
const report={startedAt:new Date().toISOString(),sourceId:ledger.id,referencePromptSha256:crypto.createHash('sha256').update(referencePrompt).digest('hex'),model:config.ninerouterResolvedModel,
    historicalInputsOnly:true,roundTripsVerified:ledger.snapshots.length,decisionMs:config.decisionMs,
    promptSha256:crypto.createHash('sha256').update(PROMPT).digest('hex'),rows:[],
    limitations:['small_sample_not_production_p95','not_profit_evidence','http_wait_not_pure_inference',
        'diagnostic_cost_separate_unknown_monthly_subscription_and_local_compute']};
class Counter extends TokenCounter {
    async count(input) {
        if(!this.questions)return super.count(input);
        await this.start();const requestId=++this.serial;
        return new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>{this.pending.delete(requestId);reject(new Error('tokenizer_timeout'));},500);
            this.pending.set(requestId,{resolve,reject,timer});
            this.child.stdin.write(JSON.stringify({requestId,state:input,questions:this.questions})+'\n');
        });
    }
}
const managers={},late=new Map();
try {
    for(const variant of ['original','compact-chat']) {
        const counter=new Counter(config);counter.questions=variant==='original'?referenceQuestions:QUESTIONS;
        const wrappedFetch=async(url,options)=>{
            if(options?.method!=='POST')return fetch(url,options);
            idle();
            const body=JSON.parse(options.body);
            if(url.endsWith('/v1/systemone'))body.questions=variant==='original'?referenceQuestions:QUESTIONS;
            else body.messages[0].content=(variant==='original'?referencePrompt:PROMPT)+' Return only JSON {"action":"BUY_UP|BUY_DOWN|SKIP"}. No tools.';
            options={...options,body:JSON.stringify(body)};
            return fetch(url,options);
        };
        const p=new ProviderManager(config,{},(type,d)=>{if(type==='provider_late_response')late.set(`${variant}:${d.provider}:${d.snapshotId}`,d);},
            {counter,fetch:wrappedFetch});
        managers[variant]=p;const health=await p.preflight();
        if(!health.laya.ready || !health['9router'].ready)throw new Error('tune_preflight_failed');
    }
    for(let i=0;i<snapshots.length;i++){
        const source=snapshots[i];
        // Alternate order to reduce a systematic warm-cache/time bias.
        for(const variant of i%2?['compact-chat','original']:['original','compact-chat']){
            const p=managers[variant],input=variant==='original'?source.input:compactInput(source.input);
            const snapshot={...source,input};const tokens=await p.counter.count(input);
            if(!tokens.valid)throw new Error('tune_context_overflow');
            const decisions=await Promise.all(['laya','9router'].map(async provider=>[provider,await p.predict(provider,snapshot)]));
            await Promise.allSettled([...p.active.values()]);await delay(0);
            for(const [provider,result] of decisions){
                const actual=late.get(`${variant}:${provider}:${source.snapshotId}`)||result;
                const row={variant,provider,snapshotId:source.snapshotId,status:result.status,reason:result.reason||null,
                    httpStatus:result.httpStatus||null,action:actual.action,model:actual.model,
                    latencyMs:actual.latencyMs,inputTokens:actual.usage?.input_tokens??actual.usage?.prompt_tokens??null,
                    outputTokens:actual.usage?.output_tokens??actual.usage?.completion_tokens??null,
                    layaFullSequenceTokens:tokens.tokens,inputBytes:Buffer.byteLength(input),
                    sourceAgeMs:source.at-source.observedAt};
                report.rows.push(row);console.log(JSON.stringify(row));
            }
            atomicJson(artifact,report);
            if(Object.values(p.state).some(s=>s.disabled))throw new Error('tune_provider_disabled');
            if(decisions.some(([,r])=>r.status==='provider_error'))throw new Error('tune_response_failed');
        }
    }
    report.summary=Object.fromEntries(['original','compact-chat'].map(variant=>[variant,
        Object.fromEntries(['laya','9router'].map(provider=>{
            const rows=report.rows.filter(r=>r.variant===variant&&r.provider===provider);
            return [provider,{requests:rows.length,timely:rows.filter(r=>r.status==='ok').length,
                latencyMs:percentiles(rows.map(r=>r.latencyMs)),maxLayaFullSequenceTokens:Math.max(...rows.map(r=>r.layaFullSequenceTokens)),
                inputTokens:percentiles(rows.map(r=>r.inputTokens)),
                withinFreshnessWithExecution:rows.filter(r=>r.status==='ok'&&r.sourceAgeMs+r.latencyMs+config.latencyMs<=config.dataAgeMs).length}];
        }))]));
}catch(error){report.errorCode=/^tune_[a-z_]+$/.test(error.message||'')?error.message:'tune_failed';process.exitCode=1;
}finally{
    for(const p of Object.values(managers)){
        if(p.active.size || Object.values(p.state).some(s=>['inference_unresolved','inference_transport_uncertain'].includes(s.disabled))){
            atomicJson(uncertain,{at:new Date().toISOString(),reason:'inference_uncertain_manual_review_required',artifact});
        }
        p.close();
    }
    report.finishedAt=new Date().toISOString();atomicJson(artifact,report);fs.unlinkSync(lock);
    console.log(JSON.stringify({artifact,summary:report.summary||null,errorCode:report.errorCode||null}));
}
