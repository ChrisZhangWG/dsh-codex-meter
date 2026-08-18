import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTodayUsage, dashboardDayRange, todayUsageUrls } from "../lib/official-usage.js";

function envelope(bizData) {
  return { code: 0, msg: "", data: { biz_code: 0, biz_msg: "", biz_data: bizData } };
}

test("dashboardDayRange uses the DeepSeek GMT+8 calendar day", () => {
  const range = dashboardDayRange(new Date("2026-08-17T12:00:00Z"));
  assert.deepEqual(range, { start: 1786896000, end: 1786982400, timezone: 28800 });
  const urls = todayUsageUrls(new Date("2026-08-17T12:00:00Z"));
  assert.match(urls.amount, /\/amount\?start=1786896000&end=1786982400&tz=28800$/);
  assert.match(urls.cost, /\/cost\?start=1786896000&end=1786982400&tz=28800$/);
});

test("analyzeTodayUsage aggregates API keys and prices peak and off-peak tokens", () => {
  const peak = 1786928400; // 09:00 GMT+8
  const offPeak = 1786960800; // 18:00 GMT+8
  const amount = envelope({
    series: [{
      api_key: { name: "must-not-leak" },
      model: "deepseek-v4-flash",
      buckets: [
        { time: peak, usage: { REQUEST: 3, PROMPT_CACHE_HIT_TOKEN: 2000000, PROMPT_CACHE_MISS_TOKEN: 100000, RESPONSE_TOKEN: 20000 } },
        { time: offPeak, usage: { REQUEST: 2, PROMPT_CACHE_HIT_TOKEN: 1000000, PROMPT_CACHE_MISS_TOKEN: 200000, RESPONSE_TOKEN: 10000 } }
      ]
    }]
  });
  const cost = envelope({
    data: [{
      currency: "CNY",
      series: [{
        api_key: { name: "must-not-leak" },
        model: "deepseek-v4-flash",
        buckets: [{ time: peak, cost: "0.68" }, { time: offPeak, cost: "0.395" }]
      }]
    }]
  });

  const result = analyzeTodayUsage(amount, cost);
  assert.equal(result.requests, 5);
  assert.equal(result.inputTokens, 3300000);
  assert.equal(result.totalTokens, 3330000);
  assert.equal(result.cacheHitRate, 3000000 / 3300000);
  assert.equal(result.averageInputTokens, 660000);
  assert.equal(result.highContext, true);
  assert.ok(Math.abs(result.officialCost - 1.075) < 1e-12);
  assert.ok(Math.abs(result.cacheHitCost - 0.25) < 1e-12);
  assert.ok(Math.abs(result.cacheMissCost - 0.6) < 1e-12);
  assert.ok(Math.abs(result.responseCost - 0.225) < 1e-12);
  assert.equal(result.hourly.length, 2);
  assert.equal(result.models.length, 1);
  assert.equal("api_key" in result.models[0], false);
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
});

test("analyzeTodayUsage rejects an unsuccessful platform envelope", () => {
  assert.throws(
    () => analyzeTodayUsage({ code: 40003, data: {} }, envelope({ data: [] })),
    /DeepSeek platform usage error/
  );
});
