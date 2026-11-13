import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fee, sweep, round, floorTick, EPS } from '../restart/math.js';
import { quoteQuality } from '../restart/evidence.js';
import { marketSlug } from '../restart/strategy.js';
import { makeFeatures, encodeFeatures } from './history.js';

export function candidateChecks(market, books, config, cash, now, requireDepth=true) {
    return books.map((book,index)=>{
        const skip=reason=>({index,reason});
        if(!market.accepting)return skip('market_not_accepting');
        if(market.minimum>config.shares+EPS)return skip('minimum_exceeds_fixed_shares');
        if((market.end-now)/1000<10 || (market.end-now)/1000>90)return skip('outside_entry_window');
        const snapshotPrice=book.asks[0]?.price,tick=market.ticks?.[index] || market.tick;
        const minimum=market.end-now<=20000?0.80:0.72;
        if(!Number.isFinite(snapshotPrice))return skip('missing_executable_ask');
        if(snapshotPrice<minimum-EPS)return skip('ask_below_entry_minimum');
        if(snapshotPrice>0.90+EPS)return skip('ask_above_entry_maximum');
        if(!(tick>0 && tick<1) || Math.abs(snapshotPrice/tick-Math.round(snapshotPrice/tick))>EPS)return skip('price_off_tick');
        // Fix the worst acceptable price before inference, never from a later
        // quote. The research allowance is at most one tick and one cent.
        const allowance=Math.min((config.limitSlippageTicks||0)*tick,config.limitSlippageUsd||0);
        const price=floorTick(Math.min(0.90,snapshotPrice+allowance),tick);
        const cost=config.shares*price+fee(config.shares,price,market.fee)+config.gasUsd;
        const order={index,tokenId:market.tokens[index],snapshotPrice,price,slippage:round(price-snapshotPrice),shares:config.shares,side:'BUY'};
        if(cost>config.entryCap+EPS)return skip('entry_budget_exceeded');
        if(cost>cash+EPS)return skip('insufficient_virtual_cash');
        const quality=quoteQuality({orders:[order]},books,config.control,{requireDepth});
        if(quality.reason)return skip(quality.reason);
        return {index,reason:null,order:{...order,cost:round(cost)}};
    });
}

export function candidates(market, books, config, cash, now, requireDepth=true) {
    return candidateChecks(market,books,config,cash,now,requireDepth).flatMap(check=>check.order?[check.order]:[]);
}

export function metadataIdentity(market) {
    return JSON.stringify([market.conditionId,market.tokens,market.minimum,market.ticks||[market.tick,market.tick],market.fee,!!market.negRisk]);
}

export async function verifyStreamSnapshot(client,stream,market,validation,clock=Date.now,maxAgeMs=5000,requireWarm=true) {
    const snapshot=stream.snapshot(clock(),requireWarm);
    if(!snapshot)throw new Error('execution_book_unavailable');
    if(snapshot.some((book,i)=>book.tick!==(market.ticks?.[i]||market.tick))){
        // A WebSocket book can still advertise an old coarser tick. Confirm
        // the authoritative per-token endpoints; never infer permission from
        // prices alone or send another request on the execution path.
        if(!client.tickSize)throw new Error('execution_tick_mismatch');
        validation.endpointTicks=await Promise.all(market.tokens.map(token=>client.tickSize(token)));
        validation.tickVerifiedAt=clock();
        if(validation.endpointTicks.some((tick,i)=>tick!==(market.ticks?.[i]||market.tick)))throw tickMismatch(market,snapshot,validation);
    }
    return validatedStreamBooks(stream,market,validation,clock(),maxAgeMs,requireWarm);
}

function tickMismatch(market,books,validation) {
    return Object.assign(new Error('execution_tick_mismatch'),{tickContext:{metadataTicks:market.ticks||[market.tick,market.tick],
        streamTicks:books.map(b=>b.tick),endpointTicks:validation.endpointTicks||null}});
}

export function validatedStreamBooks(stream, market, validation, now, maxAgeMs=5000, requireWarm=true) {
    if(!validation || now<validation.at || now-validation.at>maxAgeMs || stream.generation!==validation.generation
        || metadataIdentity(market)!==validation.identity)throw new Error('execution_metadata_changed_or_expired');
    if(stream.tokens?.length!==2 || stream.tokens.some((t,i)=>t!==market.tokens[i]))throw new Error('execution_token_mismatch');
    const books=stream.snapshot(now,requireWarm);
    if(!books || books.length!==2)throw new Error('execution_book_unavailable');
    for(const [index,book] of books.entries()){
        const tick=market.ticks?.[index]||market.tick;
        if(book.tokenId!==market.tokens[index] || book.conditionId!==market.conditionId)throw new Error('execution_token_mismatch');
        const endpointsVerified=validation.endpointTicks?.[index]===tick && Number.isFinite(validation.tickVerifiedAt)
            && validation.tickVerifiedAt<=now && now-validation.tickVerifiedAt<=maxAgeMs;
        const verifiedCoarserTick=endpointsVerified && book.tick>tick && book.tick<1
            && Math.abs(book.tick/tick-Math.round(book.tick/tick))<=EPS;
        // Some full-book update messages omit tick_size. Their prices still
        // require the freshly verified exchange grid, checked below.
        const verifiedOmittedTick=endpointsVerified && book.tick===undefined;
        if(book.tick!==tick && !verifiedCoarserTick && !verifiedOmittedTick)throw tickMismatch(market,books,validation);
        if(!Number.isFinite(book.timestamp) || !Number.isFinite(book.fetchedAt) || book.timestamp>now || book.fetchedAt>now
            || now-book.timestamp>maxAgeMs || now-book.fetchedAt>maxAgeMs)throw new Error('execution_book_stale_or_future');
        if(['bids','asks'].some(side=>!Array.isArray(book[side]) || book[side].some(l=>!Number.isFinite(l.price) || l.price<=0 || l.price>=1
            || !Number.isFinite(l.size) || l.size<=0 || Math.abs(l.price/tick-Math.round(l.price/tick))>EPS)))throw new Error('execution_book_invalid');
    }
    return books;
}

export function risk(arm,config,value,now) {
    arm.peak=Math.max(arm.peak,value);arm.drawdown=Math.max(arm.drawdown,arm.peak-value);arm.equity=round(value);
    if(!arm.shadowStop && arm.peak-value>=config.shadowDrawdownStop-EPS)arm.shadowStop={at:now,drawdown:round(arm.peak-value)};
    if(!arm.stopped && arm.peak-value>=config.drawdownStop-EPS)arm.stopped={at:now,reason:'research_drawdown_limit'};
}

export class ShadowEngine {
    constructor(config,store,client,books,providers,{clock=Date.now,sleep=delay}={}) {
        Object.assign(this,{config,store,client,books,providers,clock,sleep});this.current=null;this.tasks=new Set();this.lastHeartbeat=0;
        this.managingArms=new Set();
        this.payoutNext=new Map();this.payoutFailures=new Map();this.lastMarketCheck=0;this.clockValid=true;this.lastClockCheck=0;
    }
    async market(now) {
        const slug=marketSlug('late-entry',this.config.control,now);
        if(this.current?.slug!==slug) {
            if(now-this.lastMarketCheck<2000)return null;
            this.lastMarketCheck=now;
            const current=await this.client.market(slug);
            if(current.end-current.open!==300000 || current.slug!==slug || current.open!==Math.floor(now/300000)*300000)throw new Error('market_identity_mismatch');
            this.current=current;this.books.watch(current.tokens);
            this.store.state.markets[slug]={open:current.open,end:current.end,conditionId:current.conditionId};
            this.store.event('market_watched',{slug});
        } else if(!this.books.socket || this.books.socket.readyState===3) this.books.watch(this.current.tokens);
        const opening=this.client.btc.openings.get(this.current.open);
        if(opening && opening.receivedAt<=this.current.open+5000)this.current.reference={source:'chainlink_twap_60s',
            open:this.current.open,end:this.current.end,value:opening.value,observedAt:opening.at,receivedAt:opening.receivedAt};
        return this.current;
    }
    launch(task) { this.tasks.add(task);task.finally(()=>this.tasks.delete(task)).catch(()=>{}); }
    async tick(now=this.clock()) {
        this.store.freeze(now);
        this.launch(this.manage(now).catch(e=>this.store.error('manage',e)));
        if(!this.labelsPending){this.labelsPending=true;this.launch(this.resolveOutcomes(now).catch(e=>this.store.error('labels',e)).finally(()=>{this.labelsPending=false;}));}
        if(this.client.serverTime && !this.clockPending && now-this.lastClockCheck>=30000){
            this.clockPending=true;this.lastClockCheck=now;
            this.launch(this.client.serverTime().then(()=>{this.clockValid=true;}).catch(e=>{this.clockValid=false;this.store.error('clock',e);}).finally(()=>{this.clockPending=false;}));
        }
        if(!this.closed && !this.store.state.frozenAt && this.clockValid){
            this.client.startBtcFeed();
            const market=await this.market(now);
            if(market)for(const seconds of this.config.slots){
                const key=`${market.slug}:${seconds}`,at=market.end-seconds*1000;
                if(now<at || this.store.state.slots[key])continue;
                this.store.state.slots[key]={at:now,status:'reserved'};this.store.save();
                if(now-at>this.config.slotToleranceMs){this.store.state.slots[key].status='slot_late';this.store.event('slot_skipped',{key,reason:'slot_late'});continue;}
                this.launch(this.observe(market,seconds,key).catch(error=>{this.store.state.slots[key].status='invalid';this.store.error('snapshot',error);}));
            }
        }
        if(now-this.lastHeartbeat>=60000){this.lastHeartbeat=now;this.store.state.lastHeartbeatAt=now;
            this.store.event('heartbeat',{frozenAt:this.store.state.frozenAt,feed:this.client.btc.status(now),
                bookReady:!!this.books.snapshot(now),arms:Object.fromEntries(Object.entries(this.store.state.arms)
                    .map(([n,a])=>[n,{cash:a.cash,position:a.position?.market.slug || null,completed:a.completed.length,stopped:a.stopped}]))});}
        this.store.state.lastTickAt=now;
    }
    async observe(market,seconds,key) {
        const started=this.clock(),generation=this.books.generation;
        const rest=await this.client.books(market);let now=this.clock();
        if(this.closed || now>=this.config.deadline || now-(market.end-seconds*1000)>this.config.slotToleranceMs)throw new Error('slot_late_after_validation');
        const validation={at:now,generation,identity:metadataIdentity(market)};
        // REST verifies constraints; prefer a fresher complete stream snapshot
        // for the shared, causal AI input.
        await verifyStreamSnapshot(this.client,this.books,market,validation,this.clock,this.config.dataAgeMs);
        const prepared=await this.freshSnapshot(market,seconds,rest,validation);
        now=this.clock();
        if(this.closed || now>=this.config.deadline || now-(market.end-seconds*1000)>this.config.slotToleranceMs)throw new Error('slot_late_after_validation');
        const {initial,bookSource,features,timing}=prepared;
        timing.validationMs=validation.at-started;
        const checks=candidateChecks(market,initial,this.config,this.config.capital,now);
        const allowed=checks.flatMap(check=>check.order?[check.order]:[]);
        if(!allowed.length){
            this.store.state.opportunitySkips ||= {};
            for(const check of checks)this.store.state.opportunitySkips[check.reason]=(this.store.state.opportunitySkips[check.reason]||0)+1;
            this.store.event('opportunity_skipped',{slug:market.slug,slot:seconds,reasons:checks.map(c=>c.reason),bookSource});
            throw new Error('no_valid_side');
        }
        for(const order of allowed){
            const assessed=this.client.btc.assess(market,order,this.config.control,now);
            if(assessed.reason && !['btc_edge_insufficient','btc_direction_disagrees'].includes(assessed.reason))throw new Error(assessed.reason);
        }
        features.state.allowed=allowed.map(o=>o.index===0?'BUY_UP':'BUY_DOWN');
        features.state.limit_cost_up_down=[0,1].map(index=>{
            const order=allowed.find(o=>o.index===index);return order?[round(order.price*100),order.cost]:null;
        });
        const snapshotId=crypto.createHash('sha256').update(JSON.stringify({market:market.slug,seconds,now,state:features.state})).digest('hex').slice(0,24);
        const input=encodeFeatures(features.state);
        const snapshot={snapshotId,market:market.slug,slot:seconds,at:now,observedAt:features.observedAt,state:features.state,input,bookSource,validation,timing,
            inputHash:crypto.createHash('sha256').update(input).digest('hex'),decisions:{}};
        this.store.state.snapshots.push(snapshot);this.store.state.slots[key].status='observed';
        this.store.event('snapshot',{snapshotId,slug:market.slug,slot:seconds,inputHash:snapshot.inputHash,state:snapshot.state,input,timing});
        const dominant=allowed.find(o=>o.index===(initial[0].asks[0].price>=initial[1].asks[0].price?0:1));
        const signal=dominant?this.client.btc.assess(market,dominant,this.config.control,now):null;
        const control={snapshotId,status:'ok',action:dominant && !signal.reason?(dominant.index===0?'BUY_UP':'BUY_DOWN'):'SKIP',
            model:'late-twap-temperature-v4',latencyMs:0,cost:0};
        snapshot.decisions.control=control;this.apply('control',control,snapshot,market,allowed,signal);
        await Promise.all(['laya','9router'].map(async name=>{
            const arm=this.store.state.arms[name];
            const decision=arm.stopped || arm.position || arm.seen[market.slug]
                ?{snapshotId,status:arm.stopped?'arm_stopped':'arm_unavailable',action:'SKIP',latencyMs:0,cost:0}
                :await this.providers.predict(name,snapshot);
            snapshot.decisions[name]=decision;this.store.event('decision',{provider:name,...decision});
            this.apply(name,decision,snapshot,market,allowed);
        }));
        this.store.save();
    }
    async freshSnapshot(market,seconds,rest,validation) {
        const start=this.clock(),slotEnd=market.end-seconds*1000+this.config.slotToleranceMs;
        const until=Math.min(start+(this.config.snapshotWaitMs||0),slotEnd-(this.config.snapshotSlotReserveMs||0),this.config.deadline-1);
        let beforeAge;
        for(;;){
            const now=this.clock();
            if(this.closed || now>=this.config.deadline || now>slotEnd)throw new Error('slot_late_after_validation');
            if(!this.clockValid)throw new Error('snapshot_clock_unverified');
            // Refresh real source values, never their timestamps. Every pass
            // rechecks stream generation, token identity, grid and warmup.
            const streamed=validatedStreamBooks(this.books,market,validation,now,this.config.dataAgeMs);
            const useStream=Math.min(...streamed.map(b=>b.timestamp))>=Math.min(...rest.map(b=>b.timestamp));
            const initial=useStream?streamed:rest,bookSource=useStream?'websocket':'rest';
            const features=makeFeatures(this.client.btc,market,initial,this.books,now);
            const age=now-features.observedAt;beforeAge??=age;
            if(age<=(this.config.snapshotAgeTargetMs||0) || now>=until){
                const spot=this.client.btc.spot.findLast(p=>p.at<=now&&p.receivedAt<=now),twap=this.client.btc.twap;
                return {initial,bookSource,features,timing:{waitMs:now-start,beforeAgeMs:beforeAge,inputAgeMs:age,
                    targetMet:age<=(this.config.snapshotAgeTargetMs||0),sourceAgeMs:{spot:now-spot.at,twap:now-twap.at,
                        books:initial.map(b=>now-b.timestamp)},feedIngestLagMs:{spot:spot.receivedAt-spot.at,twap:twap.receivedAt-twap.at}}};
            }
            await this.sleep(Math.min(25,until-now));
        }
    }
    apply(name,decision,snapshot,market,allowed,signal=null) {
        const arm=this.store.state.arms[name],now=this.clock();
        if(this.closed || decision.status!=='ok' || decision.action==='SKIP'){decision.entryDisposition='no_buy_decision';return;}
        if(arm.position || arm.seen[market.slug] || arm.stopped){decision.entryDisposition='arm_unavailable';return;}
        if(this.store.state.frozenAt || now>=this.config.deadline){decision.entryDisposition='deadline';return;}
        if(now-snapshot.at>this.config.decisionMs){decision.entryDisposition='late_response';return;}
        if(now-snapshot.observedAt>this.config.dataAgeMs){decision.entryDisposition='stale_input';return;}
        const order=allowed.find(o=>o.index===(decision.action==='BUY_UP'?0:1));
        if(!order || order.cost>arm.cash+EPS){decision.entryDisposition='side_or_budget_invalid';return;}
        decision.entryDisposition='reserved';
        arm.seen[market.slug]={snapshotId:snapshot.snapshotId,at:now};
        arm.position={market:{...market},snapshotId:snapshot.snapshotId,order:{...order},status:'pending',submittedAt:now,
            activeAt:now+this.config.latencyMs,holdings:0,entryCost:0,fees:0,gas:0,signal,
            snapshotObservedAt:snapshot.observedAt,validation:snapshot.validation,capitalHours:0,lastCapitalAt:now};
        this.store.event('order_pending',{arm:name,snapshotId:snapshot.snapshotId,slug:market.slug,snapshotPrice:order.snapshotPrice,
            price:order.price,slippage:order.slippage,shares:order.shares});
    }
    async manage(now) {
        // Valuation/settlement of one arm cannot block another arm's execution.
        await Promise.all(Object.entries(this.store.state.arms).map(async ([name,arm])=>{
            if(this.managingArms.has(name))return;
            this.managingArms.add(name);
            try {
            const p=arm.position;if(!p){risk(arm,this.config,arm.cash,now);return;}
            p.capitalHours+=(p.entryCost || (p.status==='matched'?-p.fill.cash:p.order.cost-this.config.gasUsd))*Math.max(0,now-p.lastCapitalAt)/3600000;p.lastCapitalAt=now;
            if(p.status==='pending' && now>=p.activeAt){
                try {
                    const at=this.clock();
                    const books=validatedStreamBooks(this.books,p.market,p.validation,at,this.config.dataAgeMs);
                    if(at>=this.config.deadline || at>=p.market.end || !this.books.snapshot(at)
                        || !this.client.btc.status(at).ready || at-p.snapshotObservedAt>this.config.dataAgeMs)throw new Error('execution_stale');
                    // Partial depth at execution is allowed; price, time, cash and spread are rechecked.
                    const valid=candidates(p.market,books,{...this.config,limitSlippageTicks:0,limitSlippageUsd:0},arm.cash,at,false).find(o=>o.index===p.order.index);
                    if(!valid)throw new Error('execution_constraints_changed');
                    const assessed=this.client.btc.assess(p.market,p.order,this.config.control,at);
                    if(assessed.reason && (name==='control' || !['btc_edge_insufficient','btc_direction_disagrees'].includes(assessed.reason)))throw new Error('execution_signal_invalid');
                    const fill=sweep(books[p.order.index].asks,p.order.shares,p.order.price,'BUY',p.market.fee);
                    p.executionAt=at;p.executionLatencyMs=at-p.submittedAt;p.executionSignal=assessed;p.executionBookSource='websocket';
                    const detail={snapshotPrice:p.order.snapshotPrice,limit:p.order.price,ask:books[p.order.index].asks[0]?.price,
                        slippage:p.order.slippage,bookSource:'websocket',executionLatencyMs:p.executionLatencyMs,dataAgeMs:at-p.snapshotObservedAt};
                    if(fill.shares<=EPS){arm.outcomes[p.market.slug]={pnl:0,reason:'no_fill',...detail};arm.position=null;
                        this.store.event('no_fill',{arm:name,slug:p.market.slug,...detail});return;}
                    p.status='matched';p.fill=fill;p.settleAt=at+this.config.settlementMs;
                    this.store.event('fill_matched',{arm:name,slug:p.market.slug,shares:fill.shares,fees:fill.fees,...detail});
                }catch(error){arm.outcomes[p.market.slug]={pnl:0,reason:'execution_expired',code:error.message};arm.position=null;this.store.error('execution',error);return;}
            }
            if(p.status==='matched' && now>=p.settleAt){p.status='filled';p.holdings=p.fill.shares;p.entryCost=-p.fill.cash;p.fees=p.fill.fees;
                arm.cash=round(arm.cash+p.fill.cash);this.store.event('fill_settled',{arm:name,slug:p.market.slug,shares:p.holdings,cash:arm.cash});}
            if(p.status==='filled'){
                if(now<p.market.end && (!p.lastMarkAt || now-p.lastMarkAt>=5000)){
                    try {const books=await this.client.books(p.market);p.mark=sweep(books[p.order.index].bids,p.holdings,0,'SELL',p.market.fee).cash;p.lastMarkAt=now;}
                    catch(error){this.store.error('valuation',error);}
                }
                risk(arm,this.config,arm.cash+(p.mark??p.entryCost),now);
                if(now>=p.market.end && now>=(this.payoutNext.get(p.market.conditionId)||0)){
                    try {
                        const payout=this.store.state.markets[p.market.slug]?.payout || await this.client.payout(p.market.conditionId);
                        this.payoutNext.set(p.market.conditionId,now+15000);
                        if(!payout)return;
                        if(payout.length!==2 || payout.some(x=>!Number.isFinite(x)||x<0||x>1) || Math.abs(payout[0]+payout[1]-1)>EPS)throw new Error('invalid_payout');
                        const redeemed=p.holdings*payout[p.order.index],pnl=round(redeemed-p.entryCost-this.config.gasUsd);
                        arm.cash=round(arm.cash+redeemed-this.config.gasUsd);
                        const result={slug:p.market.slug,snapshotId:p.snapshotId,openedAt:p.submittedAt,closedAt:now,
                            marketEnd:p.market.end,pnl,fees:p.fees,gas:this.config.gasUsd,shares:p.holdings,
                            partial:p.holdings<p.order.shares-EPS,payout,capitalHours:p.capitalHours,executionLatencyMs:p.executionLatencyMs,
                            executionBookSource:p.executionBookSource,snapshotPrice:p.order.snapshotPrice,limit:p.order.price,
                            averageFillPrice:round(p.fill.notional/p.fill.shares)};
                        arm.completed.push(result);arm.outcomes[p.market.slug]={pnl,reason:'settled'};arm.position=null;
                        risk(arm,this.config,arm.cash,now);this.store.event('official_settlement',{arm:name,...result});
                    }catch(error){const failures=(this.payoutFailures.get(p.market.conditionId)||0)+1;this.payoutFailures.set(p.market.conditionId,failures);
                        this.payoutNext.set(p.market.conditionId,now+Math.min(60000,15000*2**failures));this.store.error('settlement',error);}
                }
            }
            }finally{this.managingArms.delete(name);}
        }));
    }
    async resolveOutcomes(now) {
        for(const [slug,market] of Object.entries(this.store.state.markets)) {
            if(market.payout || !market.conditionId || now<market.end || !this.store.state.snapshots.some(s=>s.market===slug)
                || now<(this.payoutNext.get(market.conditionId)||0))continue;
            try {
                const payout=await this.client.payout(market.conditionId);
                this.payoutNext.set(market.conditionId,now+15000);
                if(!payout)continue;
                if(payout.length!==2 || payout.some(x=>!Number.isFinite(x)||x<0||x>1) || Math.abs(payout[0]+payout[1]-1)>EPS)throw new Error('invalid_payout');
                market.payout=payout;market.labelResolvedAt=this.clock();this.payoutFailures.delete(market.conditionId);
                this.store.event('market_label',{slug,payout});
            }catch(error){const n=(this.payoutFailures.get(market.conditionId)||0)+1;this.payoutFailures.set(market.conditionId,n);
                this.payoutNext.set(market.conditionId,now+Math.min(60000,15000*2**n));this.store.error('label',error);}
        }
    }
    close(){this.closed=true;
        for(const [name,arm] of Object.entries(this.store.state.arms))if(arm.position?.status==='pending'){
            arm.outcomes[arm.position.market.slug]={pnl:0,reason:'shutdown_pending_cancelled'};arm.position=null;
            this.store.event('pending_cancelled',{arm:name,reason:'shutdown'});
        }
        this.books.close();this.providers.close();this.client.close();this.store.save();}
}
