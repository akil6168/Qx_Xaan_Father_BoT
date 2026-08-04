// check-symbols.js — প্রতিটা proposed pair TwelveData-তে কাজ করে কিনা টেস্ট করে
// Run: node check-symbols.js
const twelveData = require('./twelvedata');

const LIVE_PAIRS = [
  'EUR/USD','GBP/USD','USD/JPY','AUD/USD','USD/CAD','USD/CHF','NZD/USD',
  'EUR/JPY','GBP/JPY','EUR/GBP','EUR/CHF','AUD/JPY','CAD/JPY','CHF/JPY',
  'EUR/CAD','EUR/AUD','GBP/CAD','GBP/CHF','AUD/CAD','AUD/CHF',
  'EUR/NZD','GBP/AUD','GBP/NZD','AUD/NZD','NZD/JPY'
];

const OTC_ONLY_EXTRA = [
  'NZD/CAD','NZD/CHF','USD/BDT','USD/INR','USD/PKR','USD/IDR'
];

async function testSymbol(symbol) {
  try {
    const data = await twelveData.getTimeSeries(symbol, '1min', 2);
    if (data && data.values && data.values.length > 0) {
      return { symbol, ok: true, lastClose: data.values[0].close };
    }
    return { symbol, ok: false, reason: data.message || 'কোনো values পাওয়া যায়নি' };
  } catch (e) {
    return { symbol, ok: false, reason: e.message };
  }
}

(async () => {
  console.log('🔍 LIVE_PAIRS টেস্ট হচ্ছে...\n');
  for (const sym of LIVE_PAIRS) {
    const r = await testSymbol(sym);
    console.log(r.ok ? `✅ ${r.symbol} — OK (last: ${r.lastClose})` : `❌ ${r.symbol} — FAIL (${r.reason})`);
    await new Promise(res => setTimeout(res, 1500)); // rate-limit বাঁচাতে delay
  }

  console.log('\n🔍 OTC-only EXTRA পেয়ার টেস্ট হচ্ছে...\n');
  for (const sym of OTC_ONLY_EXTRA) {
    const r = await testSymbol(sym);
    console.log(r.ok ? `✅ ${r.symbol} — OK (last: ${r.lastClose})` : `❌ ${r.symbol} — FAIL (${r.reason})`);
    await new Promise(res => setTimeout(res, 1500));
  }

  console.log('\n✅ টেস্ট শেষ।');
})();
