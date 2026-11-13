import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ProviderManager, normalize } from '../../src/ai-shadow/providers.js';

const cfg={ninerouterResolvedModel:'cx/gpt-6.1-sol',ninerouterModel:'polymarket-decision',ninerouterKey:'not-a-real-key',
    layaUrl:'http://local',ninerouterUrl:'http://router/v1',decisionMs:10,layaDrainMs:50,inputUsdPerMillion:null,outputUsdPerMillion:null};
const snapshot={snapshotId:'snapshot',state:{test:true}};
const counter={async count(){return {valid:true,identity:'tokenizer'};},close(){}};
const laya={routing:{model:'typed-decisions'},answers:{action:{choice:'SKIP',answer_confidence:0.7}},usage:{input_tokens:10,output_tokens:1}};
test('normalizes Laya and router decisions without treating confidence as payout probability',()=>{
    const a=normalize('laya',laya,cfg,'snapshot',1);assert.equal(a.action,'SKIP');assert.equal(a.confidence,0.7);
    const b=normalize('9router',{model:'gpt-6.1-sol',choices:[{message:{content:'{"action":"BUY_UP"}'}}],usage:{prompt_tokens:10,completion_tokens:1}},cfg,'snapshot',2);
    assert.equal(b.cost,null);assert.equal(b.model,'gpt-6.1-sol');
});
test('invalid action, nonfinite confidence, snapshot mismatch and substituted model are rejected',()=>{
    for(const row of [{model:'wrong'}, {...laya,answers:{action:{choice:'BUY_ANY'}}}, {...laya,answers:{action:{choice:'SKIP',confidence:Infinity}}}])
        assert.throws(()=>normalize('laya',row,cfg,'snapshot',1));
    assert.throws(()=>normalize('9router',{model:'gpt-6.1-sol',choices:[{message:{content:'{"action":"SKIP","snapshotId":"other"}'}}]},cfg,'snapshot',1));
});
test('late Laya result does not trade and does not admit another inference while draining',async()=>{
    const state={laya:{tokenizerIdentity:'tokenizer'}},events=[];
    const p=new ProviderManager(cfg,state,(t,d)=>events.push({t,d}),{counter,fetch:async()=>{await delay(25);return {ok:true,json:async()=>laya};}});
    const a=await p.predict('laya',snapshot);assert.equal(a.status,'decision_timeout');
    const b=await p.predict('laya',snapshot);assert.equal(b.status,'provider_busy');
    await delay(25);assert.equal(state.laya.pending,null);assert.ok(events.some(e=>e.t==='provider_late_response'));
    assert.equal(state.laya.disabled,undefined);p.close();
});
test('unresolved Laya inference disables provider persistently after drain timeout',async()=>{
    const state={laya:{tokenizerIdentity:'tokenizer'}};
    const p=new ProviderManager({...cfg,decisionMs:5,layaDrainMs:15},state,()=>{},
        {counter,fetch:async(_u,o)=>new Promise((_resolve,reject)=>o.signal.addEventListener('abort',()=>reject(new Error('aborted'))))});
    assert.equal((await p.predict('laya',snapshot)).status,'decision_timeout');await delay(20);
    assert.equal(state.laya.disabled,'inference_unresolved');assert.equal((await p.predict('laya',snapshot)).status,'inference_unresolved');p.close();
});
test('context overflow is rejected before any inference call',async()=>{
    let calls=0;const state={laya:{tokenizerIdentity:'tokenizer'}};
    const p=new ProviderManager(cfg,state,()=>{},{counter:{...counter,async count(){return {valid:false,identity:'tokenizer'};}},fetch:async()=>{calls++;}});
    const r=await p.predict('laya',snapshot);assert.equal(r.reason,'context_or_artifact_invalid');assert.equal(calls,0);p.close();
});
test('router mapping changes persistently block inference without fallback',async()=>{
    let calls=0;const state={};const p=new ProviderManager(cfg,state,()=>{},{counter,pin:()=> 'different/model',fetch:async()=>{calls++;}});
    const r=await p.predict('9router',snapshot);assert.equal(r.status,'router_pin_changed');assert.equal(calls,0);assert.ok(state['9router'].disabled);p.close();
});
test('configured usage costs account for both input and output tokens',()=>{
    const row={model:'gpt-6.1-sol',choices:[{message:{content:'{"action":"SKIP"}'}}],usage:{prompt_tokens:1000,completion_tokens:100}};
    const r=normalize('9router',row,{...cfg,inputUsdPerMillion:2,outputUsdPerMillion:10},'snapshot',1);
    assert.equal(r.cost,0.003);
});
test('HTTP429 is recorded without submitting any retry',async()=>{
    let calls=0;const state={laya:{tokenizerIdentity:'tokenizer'}};
    const p=new ProviderManager(cfg,state,()=>{},{counter,fetch:async()=>{calls++;return {ok:false,status:429};}});
    const r=await p.predict('laya',snapshot);assert.equal(r.httpStatus,429);assert.equal(calls,1);assert.equal(state.laya.disabled,undefined);p.close();
});
test('ambiguous transport failure after Laya submit blocks subsequent inference',async()=>{
    const state={laya:{tokenizerIdentity:'tokenizer'}};
    const p=new ProviderManager(cfg,state,()=>{},{counter,fetch:async()=>{throw new TypeError('connection lost');}});
    await p.predict('laya',snapshot);assert.equal(state.laya.disabled,'inference_transport_uncertain');p.close();
});
test('late router response is drained for billing while decision stays timeout',async()=>{
    const state={},events=[];
    const row={model:'gpt-6.1-sol',choices:[{message:{content:'{"action":"BUY_UP"}'}}],usage:{prompt_tokens:1000,completion_tokens:100}};
    const p=new ProviderManager({...cfg,inputUsdPerMillion:2,outputUsdPerMillion:10},state,(t,d)=>events.push({t,d}),
        {counter,pin:()=>cfg.ninerouterResolvedModel,fetch:async()=>{await delay(25);return {ok:true,json:async()=>row};}});
    assert.equal((await p.predict('9router',snapshot)).status,'decision_timeout');
    assert.equal((await p.predict('9router',snapshot)).status,'provider_busy');await delay(25);
    assert.equal(events.find(e=>e.t==='provider_late_response').d.cost,0.003);p.close();
});
test('preflight retries a transient read once and can recover without clearing persistent disables',async()=>{
    let reads=0;const state={};const p=new ProviderManager(cfg,state,()=>{},{counter:{...counter,async start(){return {identity:'tokenizer',maxTokens:1024};}},
        pin:()=>cfg.ninerouterResolvedModel,retryDelayMs:1,fetch:async url=>{
            if(url.endsWith('/health'))return {ok:true,json:async()=>({loaded:['typed-decisions']})};
            reads++;if(reads===1)throw new TypeError('transport');return {ok:true,json:async()=>({data:[{id:cfg.ninerouterModel}]})};}});
    const r=await p.preflight();assert.equal(r['9router'].ready,true);assert.equal(reads,2);
    state['9router'].disabled='inference_unresolved';assert.equal((await p.preflight())['9router'].ready,false);
    assert.equal(state['9router'].disabled,'inference_unresolved');p.close();
});
test('long Retry-After prevents both an immediate retry and early recovery probes',async()=>{
    let calls=0;const p=new ProviderManager(cfg,{},()=>{},{counter,retryDelayMs:1,fetch:async()=>{
        calls++;return {ok:false,status:429,headers:new Headers({'retry-after':'10'})};}});
    await assert.rejects(p.read('http://router/models'));await assert.rejects(p.read('http://router/models'),/provider_retry_after/);
    assert.equal(calls,1);p.close();
});
test('both engines receive the exact same compact text and context count uses that text',async()=>{
    const requests=[],counted=[],state={laya:{tokenizerIdentity:'tokenizer'}};
    const p=new ProviderManager({...cfg,decisionMs:1000,ninerouterReasoningEffort:'low'},state,()=>{},
        {counter:{...counter,async count(input){counted.push(input);return {valid:true,identity:'tokenizer'};}},
        pin:()=>cfg.ninerouterResolvedModel,fetch:async(url,opts)=>{
            const body=JSON.parse(opts.body);requests.push({url,body});return {ok:true,json:async()=>url.includes('systemone')?laya:
                {model:'gpt-6.1-sol',choices:[{message:{content:'{"action":"SKIP"}'}}]}};}});
    const input='{"seconds":60,"open_usd":83000}';
    await Promise.all(['laya','9router'].map(name=>p.predict(name,{...snapshot,input})));
    assert.deepEqual(counted,[input]);assert.equal(requests[0].body.state||requests[1].body.state,input);
    const router=requests.find(r=>r.url.includes('completions')).body;
    assert.equal(router.messages[1].content,input);assert.equal(router.reasoning_effort,'low');p.close();
});
test('healthy metadata reads are cached but a changed pin still fails immediately',async()=>{
    let reads=0,pin=cfg.ninerouterResolvedModel;
    const p=new ProviderManager(cfg,{},()=>{},{counter:{...counter,async start(){return {identity:'tokenizer',maxTokens:1024};}},
        pin:()=>pin,fetch:async(url,opts)=>{if(url.endsWith('/health'))return {ok:true,json:async()=>({loaded:['typed-decisions']})};
            assert.equal(opts.headers['x-9r-internal-models-fetch'],'1');
            reads++;return {ok:true,json:async()=>({data:[{id:cfg.ninerouterModel}]})};}});
    assert.equal((await p.preflight())['9router'].ready,true);assert.equal((await p.preflight())['9router'].ready,true);assert.equal(reads,1);
    pin='cx/different';assert.equal((await p.preflight())['9router'].reason,'router_pin_changed');assert.equal(reads,1);p.close();
});
