import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { QUESTIONS, PROMPT, routerPin } from './config.js';

const ACTIONS = new Set(['BUY_UP', 'BUY_DOWN', 'SKIP']);
export class TokenCounter {
    constructor(config) { this.config=config; this.pending=new Map(); this.serial=0; }
    async start() {
        if (this.ready) return this.ready;
        this.ready = new Promise((resolve,reject) => {
            const script=fs.readFileSync(path.join(this.config.root,'scripts/ai-shadow-tokenizer.py'),'utf8');
            this.child=spawn('docker',['exec','-i',this.config.layaContainer,'python3','-u','-c',script],{stdio:['pipe','pipe','ignore']});
            const timer=setTimeout(()=>{reject(new Error('tokenizer_start_timeout'));this.close();},5000);
            readline.createInterface({input:this.child.stdout}).on('line',line=>{
                try { const row=JSON.parse(line);
                    if(row.ready){this.identity=row.identity;this.info=row;clearTimeout(timer);resolve(row);}
                    else {const item=this.pending.get(row.requestId);if(item){clearTimeout(item.timer);this.pending.delete(row.requestId);item.resolve(row);}}
                } catch { reject(new Error('tokenizer_invalid_output')); }
            });
            this.child.on('error',()=>{clearTimeout(timer);reject(new Error('tokenizer_unavailable'));});
            this.child.on('exit',()=>{clearTimeout(timer);for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('tokenizer_exited'));}this.pending.clear();});
        });
        return this.ready;
    }
    async count(state) {
        await this.start();const requestId=++this.serial;
        return new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>{this.pending.delete(requestId);reject(new Error('tokenizer_timeout'));},500);
            this.pending.set(requestId,{resolve,reject,timer});
            this.child.stdin.write(JSON.stringify({requestId,state,questions:QUESTIONS})+'\n');
        });
    }
    close() { this.child?.stdin.end();this.child?.kill(); }
}

export function normalize(name, row, config, snapshotId, latencyMs) {
    const model=name==='laya'?row.routing?.model || row.model:row.model;
    if(name==='laya' && !['typed-decisions','convaiinnovations/laya-typed-decisions','laya-typed-decisions'].includes(model)) throw new Error('model_mismatch');
    if(name==='9router' && ![config.ninerouterResolvedModel,config.ninerouterResolvedModel?.split('/').slice(1).join('/')].includes(model)) throw new Error('model_mismatch');
    let action,confidence;
    if(name==='laya'){action=row.answers?.action?.choice;confidence=row.answers?.action?.answer_confidence ?? row.answers?.action?.confidence;}
    else {
        const content=row.choices?.[0]?.message?.content;
        if(typeof content!=='string' || content.length>1024) throw new Error('invalid_response');
        const parsed=JSON.parse(content);action=parsed.action;confidence=parsed.confidence;
        if(parsed.snapshotId && parsed.snapshotId!==snapshotId) throw new Error('snapshot_mismatch');
    }
    if(!ACTIONS.has(action) || confidence!==undefined && (!Number.isFinite(confidence) || confidence<0 || confidence>1)) throw new Error('invalid_response');
    const usage=row.usage || null;
    const input=usage?.prompt_tokens ?? usage?.input_tokens, output=usage?.completion_tokens ?? usage?.output_tokens;
    const cost=name==='laya'?0:Number.isFinite(input) && Number.isFinite(output) && config.inputUsdPerMillion!==null && config.outputUsdPerMillion!==null
        ?(input*config.inputUsdPerMillion+output*config.outputUsdPerMillion)/1e6:null;
    return {snapshotId,action,model,latencyMs,status:'ok',confidence:confidence??null,usage,cost,
        costBasis:name==='laya'?'local_api_only_compute_unpriced':cost===null?'unknown':'configured_rates'};
}

export class ProviderManager {
    constructor(config,state,onEvent=()=>{},options={}) {
        this.config=config;this.state=state;this.onEvent=onEvent;this.fetch=options.fetch || fetch;
        this.counter=options.counter || new TokenCounter(config);this.pin=options.pin || (()=>routerPin(config.routerDb,config.ninerouterModel));
        this.active=new Map();this.closed=false;this.availability={};this.readBackoff=new Map();this.retryDelayMs=options.retryDelayMs??500;
        this.lastModelsRead=null;
    }
    async read(url,headers={}) {
        if(Date.now()<(this.readBackoff.get(url)||0))throw new Error('provider_retry_after');
        for(let attempt=0;attempt<2;attempt++){
            const started=Date.now();
            try{const response=await this.fetch(url,{headers,signal:AbortSignal.timeout(3000)});
                if(!response.ok){const e=new Error('provider_read_failed');e.httpStatus=response.status;
                    const retry=response.headers?.get('retry-after');if(retry){const ms=/^\d+(\.\d+)?$/.test(retry)?Number(retry)*1000:Date.parse(retry)-Date.now();
                        if(Number.isFinite(ms)&&ms>0){this.readBackoff.set(url,Date.now()+ms);e.retryAfterMs=ms;}}
                    throw e;}
                return await response.json();
            }catch(error){this.onEvent('provider_read_error',{provider:url.endsWith('/health')?'laya':'9router',stage:'preflight',
                    category:error.httpStatus?'http':['TimeoutError','AbortError'].includes(error.name)?'timeout':'transport',
                    httpStatus:error.httpStatus||null,durationMs:Date.now()-started,attempt:attempt+1});
                if(attempt || error.retryAfterMs>1000 || error.httpStatus && error.httpStatus!==429 && error.httpStatus<500)throw error;
                await delay(Math.max(this.retryDelayMs,error.retryAfterMs||0));}
        }
    }
    async preflight() {
        const result={};
        try {
            const health=await this.read(this.config.layaUrl+'/health');if(!health.loaded?.includes('typed-decisions'))throw new Error('laya_checkpoint_unavailable');
            const tokenizer=await this.counter.start();
            if(tokenizer.maxTokens!==1024)throw new Error('laya_context_mismatch');
            const previous=this.state.laya?.tokenizerIdentity;
            if(previous && previous!==tokenizer.identity)throw new Error('laya_artifact_changed');
            this.state.laya ||= {};this.state.laya.tokenizerIdentity=tokenizer.identity;
            result.laya={ready:!this.state.laya.disabled,health:'ok',tokenizer};
        } catch(error){result.laya={ready:false,reason:error.message};}
        try {
            if(!this.config.ninerouterKey || !this.config.ninerouterResolvedModel)throw new Error('router_configuration_missing');
            if(this.pin()!==this.config.ninerouterResolvedModel)throw new Error('router_pin_changed');
            if(!this.lastModelsRead || this.availability['9router']===false || Date.now()-this.lastModelsRead>=(this.config.providerMetadataMs||300000)){
                // The local alias is configured in SQLite. Avoid 9router's
                // unrelated upstream /models discovery on this read-only probe.
                const body=await this.read(this.config.ninerouterUrl.replace(/\/$/,'')+'/models',{
                    Authorization:'Bearer '+this.config.ninerouterKey,'x-9r-internal-models-fetch':'1'});
                if(!body.data?.some(row=>row.id===this.config.ninerouterModel))throw new Error('router_alias_missing');
                this.lastModelsRead=Date.now();
            }
            result['9router']={ready:!this.state['9router']?.disabled,model:this.config.ninerouterResolvedModel};
        }catch(error){result['9router']={ready:false,reason:error.message};}
        for(const [name,row] of Object.entries(result)){this.availability[name]=row.ready;const state=this.state[name] ||= {};
            if(!row.ready)state.unavailableSince ||= Date.now();
            else if(state.unavailableSince){const duration=Date.now()-state.unavailableSince;state.recoveredOutageMs=(state.recoveredOutageMs||0)+duration;
                state.longestOutageMs=Math.max(state.longestOutageMs||0,duration);state.unavailableSince=null;}
            state.unavailable=row.ready?null:row.reason || state.disabled || 'preflight_blocked';}
        return result;
    }
    async predict(name,snapshot) {
        const state=this.state[name] ||= {};
        const unavailable=reason=>({snapshotId:snapshot.snapshotId,status:reason,action:'SKIP',model:null,latencyMs:0,cost:name==='laya'?0:null});
        if(this.closed || state.disabled)return unavailable(state.disabled || 'provider_closed');
        if(this.availability[name]===false)return unavailable('preflight_unavailable');
        if(this.active.has(name) || state.pending)return unavailable('provider_busy');
        if(name==='9router') {
            try {if(this.pin()!==this.config.ninerouterResolvedModel)throw new Error('router_pin_changed');}
            catch {state.disabled='router_pin_changed';this.onEvent('provider_disabled',{provider:name,reason:state.disabled});return unavailable(state.disabled);}
        }
        const start=Date.now(),abort=new AbortController();let timer,decisionTimer,decisionFinished=false,submitted=false;
        state.pending={snapshotId:snapshot.snapshotId,startedAt:start};this.onEvent('provider_pending',{provider:name,snapshotId:snapshot.snapshotId});
        const task=(async()=>{
            const input=snapshot.input ?? JSON.stringify(snapshot.state);
            if(name==='laya') {
                const count=await this.counter.count(input);
                if(!count.valid || count.identity!==state.tokenizerIdentity)throw new Error('context_or_artifact_invalid');
            }
            const request=name==='laya'?{model:'typed-decisions',state:input,questions:QUESTIONS}
                :{model:this.config.ninerouterModel,stream:false,reasoning_effort:this.config.ninerouterReasoningEffort||'low',max_tokens:32,
                    messages:[{role:'system',content:PROMPT+' Return only JSON {"action":"BUY_UP|BUY_DOWN|SKIP"}. No tools.'},
                        {role:'user',content:input}],response_format:{type:'json_object'}};
            const url=name==='laya'?this.config.layaUrl+'/v1/systemone':this.config.ninerouterUrl.replace(/\/$/,'')+'/chat/completions';
            submitted=true;
            const response=await this.fetch(url,{method:'POST',headers:{'Content-Type':'application/json',
                ...(name==='9router'?{Authorization:'Bearer '+this.config.ninerouterKey}:{})},body:JSON.stringify(request),signal:abort.signal});
            if(!response.ok){const e=new Error('provider_http_failed');e.httpStatus=response.status;throw e;}
            const data=await response.json();
            if(name==='9router' && this.pin()!==this.config.ninerouterResolvedModel)throw new Error('model_mismatch');
            return normalize(name,data,this.config,snapshot.snapshotId,Date.now()-start);
        })();
        this.active.set(name,task);
        const drained=task.then(row=>{
            if(decisionFinished)this.onEvent('provider_late_response',{provider:name,...row});return row;
        },error=>{
            if(error.message==='model_mismatch'){state.disabled='model_mismatch';}
            if(name==='laya' && submitted && !error.httpStatus && !['model_mismatch','invalid_response','snapshot_mismatch'].includes(error.message))state.disabled ||= 'inference_transport_uncertain';
            const row={...unavailable('provider_error'),latencyMs:Date.now()-start,
                reason:['model_mismatch','context_or_artifact_invalid','invalid_response','snapshot_mismatch'].includes(error.message)?error.message:'request_failed',httpStatus:error.httpStatus||null};
            if(decisionFinished)this.onEvent('provider_drain_error',{provider:name,...row});return row;
        }).finally(()=>{clearTimeout(timer);clearTimeout(decisionTimer);state.pending=null;this.active.delete(name);this.onEvent('provider_drained',{provider:name});});
        const result=await Promise.race([drained,new Promise(resolve=>{
            decisionTimer=setTimeout(()=>{decisionFinished=true;
                resolve({...unavailable('decision_timeout'),latencyMs:Date.now()-start});
            },this.config.decisionMs);
        })]);
        // Drain a late read-only inference for billing/quality evidence, never for entry.
        if(decisionFinished && this.active.has(name))timer=setTimeout(()=>{
            state.disabled='inference_unresolved';this.onEvent('provider_disabled',{provider:name,reason:state.disabled});abort.abort();
        },Math.max(0,this.config.layaDrainMs-(Date.now()-start)));
        return result;
    }
    close(){this.closed=true;this.counter.close();}
}
