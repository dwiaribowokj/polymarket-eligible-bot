// Shared lossless feature encoding; mirrored books are compressed only on exact equality.
export const PROMPT = 'BTC 5m: closing 60s Chainlink TWAP vs opening. delta_cents=[spot,TWAP]; bars_cents=oldest-first 30s OHLC offsets from open_usd. Prices/FAK limits=cents, sizes=shares; sigma=milliUSD/sqrt(s); ret=millibps for 5/15/30/60/180s. Books=[bids,asks]; mirror_up swaps Up sides using 100-price, same sizes. Use fee-inclusive costs and momentum/volatility to choose profitable allowed side; else SKIP. Confidence is not win probability.';
export const QUESTIONS = {action:{type:'choice',instructions:PROMPT,criteria:{
    BUY_UP:'Closing TWAP higher; Up allowed.',BUY_DOWN:'Closing TWAP lower; Down allowed.',SKIP:'Uncertain or no advantage.'}}};
const round = value => Number(value.toFixed(2));
function mirror(book) {
    return [book[1],book[0]].map(side=>side.map(([price,size])=>[round(100-price),size]));
}
export function compactInput(input) {
    const old=typeof input==='string'?JSON.parse(input):input;
    const [up,down]=old.books_price_cents_up_down.map(book=>[book.bids,book.asks]);
    return JSON.stringify({seconds:old.seconds,open_usd:old.open_usd,delta_cents:old.spot_twap_delta_cents,
        margin_cents:old.margin_cents,sigma_milliusd:old.sigma_milliusd_sqrt_s,ret_millibps:old.returns_millibps_5_15_30_60_180,
        bars_cents:old.bars_30s_OHLC_delta_cents_oldest_first,
        up,down:JSON.stringify(mirror(up))===JSON.stringify(down)?'mirror_up':down,
        fee:old.fee,shares:old.shares,cap_usd:old.cap_usd,
        ...(old.limit_cost_up_down?{limit_cost_up_down:old.limit_cost_up_down}:{}),allowed:old.allowed});
}
export function expandInput(input) {
    const row=typeof input==='string'?JSON.parse(input):input;
    const down=row.down==='mirror_up'?mirror(row.up):row.down;
    return {seconds:row.seconds,open_usd:row.open_usd,spot_twap_delta_cents:row.delta_cents,
        margin_cents:row.margin_cents,sigma_milliusd_sqrt_s:row.sigma_milliusd,returns_millibps_5_15_30_60_180:row.ret_millibps,
        bars_30s_OHLC_delta_cents_oldest_first:row.bars_cents,
        books_price_cents_up_down:[row.up,down].map(([bids,asks])=>({bids,asks})),
        fee:row.fee,shares:row.shares,cap_usd:row.cap_usd,
        ...(row.limit_cost_up_down?{limit_cost_up_down:row.limit_cost_up_down}:{}),allowed:row.allowed};
}
