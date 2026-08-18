import { costOf, priceAt } from "./pricing.js";

const PLATFORM_BASE_URL = "https://platform.deepseek.com/api/v0/usage/by_api_key";
const DASHBOARD_TIMEZONE_SECONDS = 8 * 60 * 60;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function dashboardData(body) {
  const data = body && typeof body === "object" ? body.data : null;
  if (body?.code !== 0 || data?.biz_code !== 0 || data.biz_data === null || typeof data.biz_data !== "object") {
    const code = body?.code ?? data?.biz_code ?? "unknown";
    const error = new Error(`DeepSeek platform usage error (code ${code})`);
    error.code = code;
    throw error;
  }
  return data.biz_data;
}

export function dashboardDayRange(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  const day = `${value("year")}-${value("month")}-${value("day")}`;
  const start = Math.floor(Date.parse(`${day}T00:00:00+08:00`) / 1000);
  return { start, end: start + 24 * 60 * 60, timezone: DASHBOARD_TIMEZONE_SECONDS };
}

export function todayUsageUrls(date = new Date()) {
  const { start, end, timezone } = dashboardDayRange(date);
  const query = `start=${start}&end=${end}&tz=${timezone}`;
  return {
    amount: `${PLATFORM_BASE_URL}/amount?${query}`,
    cost: `${PLATFORM_BASE_URL}/cost?${query}`
  };
}

function aggregateCost(costBody) {
  const bizData = dashboardData(costBody);
  const currencies = Array.isArray(bizData.data) ? bizData.data : [];
  const cny = currencies.find((entry) => entry?.currency === "CNY") ?? currencies[0];
  const byBucket = new Map();
  for (const series of Array.isArray(cny?.series) ? cny.series : []) {
    const model = typeof series?.model === "string" ? series.model : "unknown";
    for (const bucket of Array.isArray(series?.buckets) ? series.buckets : []) {
      const time = finiteNumber(bucket?.time);
      const key = `${model}\u0000${time}`;
      byBucket.set(key, (byBucket.get(key) ?? 0) + finiteNumber(bucket?.cost));
    }
  }
  return byBucket;
}

export function analyzeTodayUsage(amountBody, costBody) {
  const bizData = dashboardData(amountBody);
  const officialCosts = aggregateCost(costBody);
  const buckets = new Map();

  for (const series of Array.isArray(bizData.series) ? bizData.series : []) {
    const model = typeof series?.model === "string" ? series.model : "unknown";
    for (const bucket of Array.isArray(series?.buckets) ? series.buckets : []) {
      const time = finiteNumber(bucket?.time);
      const usage = bucket?.usage && typeof bucket.usage === "object" ? bucket.usage : {};
      const key = `${model}\u0000${time}`;
      const current = buckets.get(key) ?? {
        model,
        time,
        requests: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        responseTokens: 0,
        officialCost: 0
      };
      current.requests += finiteNumber(usage.REQUEST);
      current.cacheHitTokens += finiteNumber(usage.PROMPT_CACHE_HIT_TOKEN);
      current.cacheMissTokens += finiteNumber(usage.PROMPT_CACHE_MISS_TOKEN);
      current.responseTokens += finiteNumber(usage.RESPONSE_TOKEN);
      current.officialCost = officialCosts.get(key) ?? current.officialCost;
      buckets.set(key, current);
    }
  }

  const totals = {
    requests: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    responseTokens: 0,
    officialCost: 0,
    cacheHitCost: 0,
    cacheMissCost: 0,
    responseCost: 0
  };
  const hourly = new Map();
  const models = new Map();

  for (const bucket of buckets.values()) {
    if (bucket.requests === 0 && bucket.cacheHitTokens === 0 && bucket.cacheMissTokens === 0 && bucket.responseTokens === 0 && bucket.officialCost === 0) continue;
    const priced = costOf({
      inputTokens: bucket.cacheMissTokens,
      cacheReadTokens: bucket.cacheHitTokens,
      outputTokens: bucket.responseTokens
    }, priceAt(bucket.model, bucket.time * 1000));
    const row = {
      ...bucket,
      cacheHitCost: priced.cacheReadTokens * priceAt(bucket.model, bucket.time * 1000).cny.cacheRead / 1e6,
      cacheMissCost: priced.inputTokens * priceAt(bucket.model, bucket.time * 1000).cny.input / 1e6,
      responseCost: priced.outputTokens * priceAt(bucket.model, bucket.time * 1000).cny.output / 1e6
    };
    for (const key of Object.keys(totals)) totals[key] += row[key] ?? 0;

    const hour = hourly.get(bucket.time) ?? {
      time: bucket.time,
      requests: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      responseTokens: 0,
      officialCost: 0
    };
    for (const key of ["requests", "cacheHitTokens", "cacheMissTokens", "responseTokens", "officialCost"]) hour[key] += row[key];
    hourly.set(bucket.time, hour);

    const modelRow = models.get(bucket.model) ?? {
      model: bucket.model,
      requests: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      responseTokens: 0,
      officialCost: 0
    };
    for (const key of ["requests", "cacheHitTokens", "cacheMissTokens", "responseTokens", "officialCost"]) modelRow[key] += row[key];
    models.set(bucket.model, modelRow);
  }

  const inputTokens = totals.cacheHitTokens + totals.cacheMissTokens;
  const totalTokens = inputTokens + totals.responseTokens;
  const cacheHitRate = inputTokens > 0 ? totals.cacheHitTokens / inputTokens : null;
  const averageInputTokens = totals.requests > 0 ? inputTokens / totals.requests : null;
  return {
    ...totals,
    inputTokens,
    totalTokens,
    cacheHitRate,
    averageInputTokens,
    highContext: averageInputTokens !== null && averageInputTokens >= 100000,
    hourly: [...hourly.values()].sort((a, b) => a.time - b.time),
    models: [...models.values()].sort((a, b) => b.officialCost - a.officialCost)
  };
}

export async function fetchTodayUsageAnalysis(token, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15000;
  const urls = todayUsageUrls(options.date ?? new Date());
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "x-app-version": "1.0.0",
    Origin: "https://platform.deepseek.com",
    Referer: "https://platform.deepseek.com/usage"
  };
  const [amountResponse, costResponse] = await Promise.all([
    fetchImpl(urls.amount, { headers, signal: AbortSignal.timeout(timeoutMs) }),
    fetchImpl(urls.cost, { headers, signal: AbortSignal.timeout(timeoutMs) })
  ]);
  if (!amountResponse.ok || !costResponse.ok) {
    throw new Error(`DeepSeek platform detail returned HTTP ${!amountResponse.ok ? amountResponse.status : costResponse.status}`);
  }
  return analyzeTodayUsage(await amountResponse.json(), await costResponse.json());
}
