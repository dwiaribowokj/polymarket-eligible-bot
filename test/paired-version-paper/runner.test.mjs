import test from 'node:test';
import assert from 'node:assert/strict';
import { project, sha } from '../../scripts/paired-version-paper/inputs.mjs';
import { scoreArm } from '../../scripts/paired-version-paper/runner.mjs';
import { EligibleLiveProvider } from '../../src/eligible-live/provider.js';

const slug='btc-updown-5m-300', conditionId='0x'+'ab'.repeat(32),fee={rate:0,exponent:1,takerOnly:true};
const market={slug,open:300000,end:600000,conditionId,tokens:['101','102'],minimum:5,ticks:[.01,.01],
    fee,accepting:true,negRisk:false};
const at=511000, slot={slug,scheduledAt:510000,seconds:90}, id={periodId:'period',liveRuntimeId:'runtime',epochId:'epoch'};
const filter={version:'full-fill-all-in-cost-cap-v1',maxCostPerShare:.82,gasUsd:.05,basis:'full_fill_at_frozen_limit'};
const input=JSON.stringify({market:slug,allowed:['BUY_DOWN'],shares:5,entry_cap:5,fee_rate:0,fee_exponent:1,
    limit_cost_up_down:[null,[75,3.8]]});
function ledger(){const s={at,slot:90,market:slug,observedAt:at-200,model:'deterministic-eligible-v1',provider:'eligible',
    entryFilter:filter,strategyEpochId:'epoch',input,inputHash:sha(input),snapshotId:sha(JSON.stringify({slug,seconds:90,now:at,input})).slice(0,24),
    validation:{at:at-100,identity:JSON.stringify([conditionId,market.tokens,5,market.ticks,fee,false])},
    allowed:[{index:1,tokenId:'102',side:'BUY',shares:5,price:.75,cost:3.8}],wallet:{balance:0},
    snapshotPersistMs:100,decisionRequestedAt:at+120,decisionReceivedAt:at+120,walletReadMs:800,walletWaitMs:200,metadataWarmupMs:100};
    return {mode:'pilot',strategy:'late-entry',baseline:'period',continuousOperation:{runtimeId:'runtime'},currentStrategyEpochId:'epoch',
        ai:{slots:{},snapshots:[s]}};}
const arm=mode=>({mode,Provider:EligibleLiveProvider,entryFilter:filter,execution:{slots:[90,60,30],dataAgeMs:5000,
    decisionMs:3000,latencyMs:250,inferenceReserveMs:150,gasUsd:.05}});
const submission={schema:1,unit:'ms',estimator:'median',sampleCount:10,recordedThroughExclusive:300000,prepareMs:9,
    checkToStartedEventMs:34,writesToPreSign:2,writesToFinalCheck:3,writesToPost:4};
test('paired comparison uses public depth at each modeled send; a price move after final validation changes the outcome',async()=>{
    const {snapshot}=project(ledger(),id,slot);
    assert.ok(!('wallet' in snapshot)); assert.equal(snapshot.walletReadSucceeded,true);
    const tape={select({targetAt}){const price=targetAt>=512700?.85:.74;
        return {status:'ready',generation:1,targetAt,observedAt:targetAt,offsetMs:0,index:1,market,tickVerifiedAt:targetAt,
            book:{tokenId:'102',conditionId,timestamp:targetAt-7,fetchedAt:targetAt-6,tick:.01,
                asks:[{price,size:16}],bids:[{price:price-.01,size:16}]}};}};
    const opts={snapshot,conditionId,tape,ratio:1.5,submission};
    const old=await scoreArm({...opts,arm:arm('serial')}), current=await scoreArm({...opts,arm:arm('overlap')});
    assert.ok(old.readyAt>current.readyAt);
    assert.equal(current.status,'fill');assert.equal(old.status,'no_fill');
    assert.equal(old.gas,0);assert.equal(current.gas,.05);
});
test('changed runtime rejects source and duplicate snapshots are not scored',()=>{
    assert.throws(()=>project(ledger(),{...id,liveRuntimeId:'other'},slot),/runtime_changed/);
    const s=ledger();s.ai.snapshots.push(s.ai.snapshots[0]);assert.throws(()=>project(s,id,slot),/duplicate/);
});
