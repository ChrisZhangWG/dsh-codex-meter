/**
 * dsh-codex-meter — host half.
 *
 * A compact, Codex-style usage meter for the DSH web GUI. Registers exact
 * HTTP routes on the dsh web server:
 *
 *   GET /api/codex-meter/balance
 *   GET /api/codex-meter/session-cost?sessionId=<id>
 *   GET /api/codex-meter/api-activity
 *
 * The balance route resolves the DeepSeek API key through the credentials seam
 * (the same `DEEPSEEK_API_KEY` reference the llm-deepseek adapter uses), calls
 * DeepSeek's public `/user/balance` endpoint, and returns:
 *
 *   { ok, balance: <provider payload>, todayConsumed, todayConsumedSource }
 *
 * `todayConsumed` comes from one of two sources:
 *   1. **Official (preferred)**: when the optional `DEEPSEEK_PLATFORM_TOKEN`
 *      credential is configured, the host queries the DeepSeek platform
 *      dashboard usage API and picks today's row.
 *   2. **Estimate (fallback)**: the host meters the balance delta from the
 *      first balance observed today, persisted under
 *      `$DSH_HOME/storages/codex-meter-day.json`.
 *
 * The session-cost route replays the session's persisted log and prices every
 * `assistant/message` event with the official DeepSeek price table (peak /
 * off-peak aware), so the figure covers the whole conversation — including
 * messages from before this plugin was installed. A live in-memory ledger
 * covers messages not yet flushed to the log.
 *
 * Ported from dsh-deepseek-quota (MIT, https://github.com/yingjunnan/dsh-deepseek-quota)
 * which itself ports the pricing engine from bpc-oss/dsh-web-billing (MIT).
 * The API key never leaves the host: the browser only talks to these routes.
 */
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { costOf, priceAt } from "./pricing.js";

const name = "dsh-codex-meter";
const inject = ["credentials", "webServer", "llm"];

const PUBLIC_BASE_URL = "https://api.deepseek.com";
/** Environment override honored for parity with the llm-deepseek adapter. */
const BASE_URL_ENV = "DEEPSEEK_BASE_URL";
const CREDENTIAL_REF = credentialRef("DEEPSEEK_API_KEY");
/** Optional platform session token (localStorage `userToken` of platform.deepseek.com). */
const PLATFORM_TOKEN_REF = credentialRef("DEEPSEEK_PLATFORM_TOKEN");
const BALANCE_PATH = "/user/balance";
const ROUTE_PATH = "/api/codex-meter/balance";
const SESSION_COST_ROUTE_PATH = "/api/codex-meter/session-cost";
const API_ACTIVITY_ROUTE_PATH = "/api/codex-meter/api-activity";
const TIMEOUT_MS = 15000;
/** Daily-meter state file name inside `$DSH_HOME/storages`. */
const DAY_STATE_FILE = "codex-meter-day.json";
/** Observed account-balance changes, kept separately from official usage rows. */
const BALANCE_HISTORY_FILE = "codex-meter-balance-history.json";
/** Platform usage (cost) endpoint: per-day cost for one month, filterable by date. */
const PLATFORM_USAGE_URL = "https://platform.deepseek.com/api/v0/usage/cost";
const TAILSCALE = "/usr/local/bin/tailscale";
const REMOTE_STATUS_ROUTE = "/api/codex-meter/remote-status";
const REMOTE_ENABLE_ROUTE = "/api/codex-meter/remote-enable";
const REMOTE_DISABLE_ROUTE = "/api/codex-meter/remote-disable";
const execFileAsync = promisify(execFile);

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function balanceUrl() {
  const base = process.env[BASE_URL_ENV] ?? PUBLIC_BASE_URL;
  return `${base.replace(/\/+$/, "")}${BALANCE_PATH}`;
}

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** Wrap one LLM stream and expose only non-sensitive live call metadata. */
function trackApiStream(activeCalls, callId, options, stream) {
  return (async function* () {
    activeCalls.set(callId, {
      id: callId,
      startedAt: Date.now(),
      provider: typeof options?.provider === "string" ? options.provider : "unknown",
      model: typeof options?.model === "string" ? options.model : "unknown",
      purpose: typeof options?.purpose === "string" ? options.purpose : null,
      sessionId: typeof options?.sessionId === "string" ? options.sessionId : null
    });
    try {
      yield* stream;
    } finally {
      activeCalls.delete(callId);
    }
  })();
}

function isLocalRequest(req) {
  const address = req.socket?.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function tailscale(args) {
  const { stdout } = await execFileAsync(TAILSCALE, args, { timeout: 15000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function dshListenPort() {
  const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(process.pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { timeout: 5000 });
  const ports = [...stdout.matchAll(/^n127\.0\.0\.1:(\d+)$/gm)].map((match) => match[1]);
  if (ports.length === 0) throw new Error("DSH Desktop local server is not ready. Please wait a moment and try again.");
  return ports[0];
}

async function remoteState() {
  const status = JSON.parse(await tailscale(["status", "--json"]));
  const serveStatus = await tailscale(["serve", "status"]);
  const dshPort = await dshListenPort();
  const raw = status?.Self?.DNSName;
  const dnsName = typeof raw === "string" ? raw.replace(/\.$/, "") : null;
  // Serve over HTTP inside the tailnet. The WireGuard tunnel still encrypts
  // the traffic, and this avoids a separate public ACME certificate dependency.
  const origin = dnsName ? `http://${dnsName}` : null;
  return {
    ok: true,
    online: status?.BackendState === "Running" && status?.Self?.Online === true,
    dnsName,
    url: origin ? `${origin}/m` : null,
    desktopUrl: origin ? `${origin}/?dsh-desktop-mode=compatibility&dsh-desktop-platform=darwin&remote-rev=2` : null,
    dshPort,
    serving: new RegExp(`127\\.0\\.0\\.1:${dshPort}`).test(serveStatus),
    serveStatus: serveStatus || "No serve config"
  };
}

/** Extract a readable provider message from a DeepSeek error body. */
function providerMessage(text, status) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === "object" && parsed.error !== null && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
  } catch {}
  return `DeepSeek 接口返回 HTTP ${status}`;
}

// ---- daily consumption: official platform source -------------------------

/** Local calendar day as `YYYY-MM-DD` (dashboard rows are keyed by date). */
function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Coerce a possibly-string number to a finite number, or NaN. */
function toFinite(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * Fetch this month's official daily costs from the DeepSeek platform dashboard API.
 * Response envelope: `{ code: 0, data: { biz_code: 0, biz_data: { days: [
 *   { date: "YYYY-MM-DD", data: [ { usage: [ { cost|amount, ... } ] } ] }
 * ] } } }`. Parsing is defensive; an absent today's row leaves `todayCost`
 * null so the caller can fall back to the observed balance-delta estimate.
 * @returns today's cost plus the available official daily history.
 * @throws on transport errors, non-zero envelope codes, and HTTP failures.
 */
async function fetchPlatformUsage(token) {
  const now = new Date();
  const url = `${PLATFORM_USAGE_URL}?month=${now.getMonth() + 1}&year=${now.getFullYear()}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "x-app-version": "1.0.0",
      Origin: "https://platform.deepseek.com",
      Referer: "https://platform.deepseek.com/usage"
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`DeepSeek 平台用量接口返回 HTTP ${response.status}`);
  const body = await response.json();
  const biz = body && typeof body === "object" ? body.data : void 0;
  if (body?.code !== 0 || biz === void 0 || biz.biz_code !== 0) {
    const code = body?.code ?? biz?.biz_code;
    if (code === 40002 || code === 40003) {
      throw new Error("DEEPSEEK_PLATFORM_TOKEN 已过期：请重新登录 platform.deepseek.com 并更新 userToken");
    }
    throw new Error(`DeepSeek 平台用量接口错误 (code ${code ?? "unknown"})`);
  }
  const bizData = biz.biz_data;
  const container = Array.isArray(bizData) ? bizData[0] : bizData;
  const days = container && typeof container === "object" ? container.days : void 0;
  if (!Array.isArray(days)) return { todayCost: null, history: [] };
  const history = [];
  const todayDate = localDate();
  for (const entry of days) {
    if (!entry || typeof entry.date !== "string" || !Array.isArray(entry.data)) continue;
    // The platform returns zero-value placeholders for every remaining day of
    // the month. They are not usage history and must not appear in the chart.
    if (entry.date > todayDate) continue;
    let total = 0;
    for (const modelEntry of entry.data) {
      if (!modelEntry || typeof modelEntry !== "object" || !Array.isArray(modelEntry.usage)) continue;
      for (const usage of modelEntry.usage) {
        if (!usage || typeof usage !== "object") continue;
        const value = toFinite(usage.cost ?? usage.amount);
        if (Number.isFinite(value)) total += value;
      }
    }
    history.push({ date: entry.date, cost: Math.round(total * 100) / 100 });
  }
  history.sort((a, b) => a.date.localeCompare(b.date));
  const today = history.find((entry) => entry.date === todayDate);
  return { todayCost: today?.cost ?? null, history };
}

// ---- daily consumption: balance-delta estimate ---------------------------

/**
 * Absolute path of the daily-meter state file. Prefers the harness-provided
 * `dshHomePath` service, then `$DSH_HOME`, then the default home.
 */
function dayStatePath(ctx) {
  let storages;
  const homeFn = typeof ctx.get === "function" ? ctx.get("dshHomePath") : void 0;
  if (typeof homeFn === "function") {
    storages = homeFn("storages");
  } else if (process.env.DSH_HOME) {
    storages = join(process.env.DSH_HOME, "storages");
  } else {
    storages = join(homedir(), ".dsh", "storages");
  }
  return join(storages, DAY_STATE_FILE);
}

/** Resolve a file inside the active DSH storage directory. */
function storageFilePath(ctx, fileName) {
  let storages;
  const homeFn = typeof ctx.get === "function" ? ctx.get("dshHomePath") : void 0;
  if (typeof homeFn === "function") storages = homeFn("storages");
  else if (process.env.DSH_HOME) storages = join(process.env.DSH_HOME, "storages");
  else storages = join(homedir(), ".dsh", "storages");
  return join(storages, fileName);
}

/** Record real observed balance changes; the first observation is only a baseline. */
function observeBalanceChanges(ctx, balance, currency) {
  if (!Number.isFinite(balance)) return [];
  const path = storageFilePath(ctx, BALANCE_HISTORY_FILE);
  let state = null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.changes)) state = parsed;
  } catch {}
  const rounded = Math.round(balance * 100) / 100;
  if (state === null || state.currency !== currency || !Number.isFinite(state.lastBalance)) {
    state = { currency, lastBalance: rounded, changes: [] };
  } else if (Math.abs(state.lastBalance - rounded) >= 0.005) {
    const before = Math.round(state.lastBalance * 100) / 100;
    state.changes.push({
      at: Date.now(),
      before,
      after: rounded,
      delta: Math.round((rounded - before) * 100) / 100
    });
    state.changes = state.changes.slice(-100);
    state.lastBalance = rounded;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, path);
  } catch {}
  return state.changes.slice(-20);
}

/** Read the persisted meter state; `null` when absent or malformed. */
function loadDayState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.date === "string" &&
      typeof parsed.opening === "number" &&
      typeof parsed.last === "number"
    ) {
      return parsed;
    }
  } catch {}
  return null;
}

/** Persist the meter state (best-effort; a failure just resets the meter). */
function saveDayState(path, state) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, path);
  } catch {}
}

/**
 * Advance the daily meter with one observed balance and return today's
 * consumption estimate (`max(0, opening − balance)`, rounded to cents), or
 * `null` when the balance is unusable.
 */
function computeTodayConsumed(ctx, balance) {
  if (!Number.isFinite(balance)) return null;
  const path = dayStatePath(ctx);
  const today = localDate();
  const stored = loadDayState(path);
  const opening = stored !== null && stored.date === today ? stored.opening : (stored !== null ? stored.last : balance);
  saveDayState(path, { date: today, opening, last: balance });
  const consumed = Math.max(0, opening - balance);
  return Math.round(consumed * 100) / 100;
}

// ---- session costing -----------------------------------------------------

/** Round a cost to 6 decimals for the wire (costs can be fractions of a cent). */
function roundCost(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** Empty per-session cost record (flat sums). */
function emptyCostRecord() {
  return {
    calls: 0,
    cost: 0,
    costUsd: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0
  };
}

/** Price one `assistant/message` event into a cost record (shared by live and replay paths). */
function priceEventInto(record, event) {
  const data = event.data;
  const usage = data?.usage;
  if (usage === void 0 || usage === null) return false;
  if (typeof usage.outputTokens !== "number" && typeof usage.inputTokens !== "number") return false;
  const source = data.message?.source;
  const model = typeof source?.model === "string" ? source.model : "unknown";
  const unit = priceAt(model, event.time ?? Date.now());
  const sample = costOf(usage, unit);
  record.calls += 1;
  record.cost += sample.cost;
  record.costUsd += sample.costUsd;
  record.inputTokens += sample.inputTokens;
  record.cacheReadTokens += sample.cacheReadTokens;
  record.outputTokens += sample.outputTokens;
  return true;
}

/** Min interval between log re-decodings of the same session (avoids churn during active turns). */
const REPLAY_MIN_INTERVAL_MS = 2000;

/**
 * Replay a session's persisted log and price EVERY assistant/message event, so
 * the reported cost covers the whole conversation (including messages that
 * happened before this plugin loaded). Cached per session by the log's stat
 * revision with a short minimum re-decode interval.
 */
async function replaySessionCost(ctx, sessionId) {
  const persistence = ctx.get("sessionPersistence");
  if (persistence === void 0 || typeof persistence.readRaw !== "function" || typeof persistence.readStoredRevision !== "function") {
    return null;
  }
  let revision;
  try {
    revision = await persistence.readStoredRevision(sessionId);
  } catch (error) {
    ctx.logger.warn("dsh-codex-meter: failed to read session log revision");
    ctx.logger.warn(error);
    return null;
  }
  if (revision === void 0) return null;
  const cached = logCostCache.get(sessionId);
  if (cached !== void 0) {
    if (cached.revision === revision) return cached;
    if (Date.now() - cached.at < REPLAY_MIN_INTERVAL_MS) return cached;
  }
  try {
    const raw = await persistence.readRaw(sessionId);
    if (raw === void 0 || raw === null || typeof raw.content !== "string") return null;
    const record = emptyCostRecord();
    for (const line of raw.content.split("\n")) {
      if (line === "") continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event === null || typeof event !== "object" || event.type !== "assistant/message") continue;
      try {
        priceEventInto(record, event);
      } catch {
        // one malformed message must not fail the whole replay
      }
    }
    const result = { ...record, revision, at: Date.now() };
    logCostCache.set(sessionId, result);
    return result;
  } catch (error) {
    ctx.logger.warn("dsh-codex-meter: failed to replay session log for costing");
    ctx.logger.warn(error);
    return null;
  }
}

/** Whole-session log replay cache: sessionId -> { revision, calls, cost, ..., at }. */
const logCostCache = new Map();

function apply(ctx) {
  // ---- current-conversation cost ledger ----------------------------------
  // 订阅 session/event 实时累计（覆盖尚未落盘的进行中消息）；查询时优先用
  // 全量日志回放（replaySessionCost）以获得包含重启前历史的整段会话费用。
  const bySession = new Map();
  const activeApiCalls = new Map();
  let nextApiCallId = 1;

  // This wraps the actual model stream, so tool execution and approval waits
  // are not misreported as active API calls. No prompt or credential data is
  // retained or returned by the status endpoint.
  ctx.on("llm/stream", (options, next) => {
    const callId = nextApiCallId++;
    return trackApiStream(activeApiCalls, callId, options, next());
  }, { global: true, prepend: true });

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: API_ACTIVITY_ROUTE_PATH,
      handler: (_req, res) => {
        const calls = [...activeApiCalls.values()].sort((a, b) => a.startedAt - b.startedAt);
        sendJson(res, 200, { ok: true, active: calls.length > 0, count: calls.length, calls });
      }
    }),
    "dsh-codex-meter: API activity route"
  );

  // DSH Desktop chooses a fresh loopback port after each restart. If the user
  // previously enabled the HTTP tailnet entry, keep it pointed at this run.
  Promise.resolve().then(async () => {
    try {
      const serveStatus = await tailscale(["serve", "status"]);
      if (/http:\/\/[^\s]+\.ts\.net/.test(serveStatus)) {
        await tailscale(["serve", "--bg", "--http=80", await dshListenPort()]);
      }
    } catch (error) {
      ctx.logger.warn("dsh-codex-meter: failed to refresh Tailscale Serve after restart");
      ctx.logger.warn(error);
    }
  });

  // A remote phone may view the status, but only this Mac can change Serve.
  ctx.effect(() => ctx.webServer.register({
    kind: "exact", path: REMOTE_STATUS_ROUTE,
    handler: async (_req, res) => { try { sendJson(res, 200, await remoteState()); } catch (error) { sendJson(res, 502, { ok: false, message: error instanceof Error ? error.message : String(error) }); } }
  }), "dsh-codex-meter: remote status route");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact", path: REMOTE_ENABLE_ROUTE,
    handler: async (req, res) => {
      if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, message: "This action must be started locally on this Mac." });
      try {
        await tailscale(["serve", "--bg", "--http=80", await dshListenPort()]);
        sendJson(res, 200, await remoteState());
      } catch (error) {
        // On first use Tailscale prints a one-time approval URL and waits.
        // Preserve it for the client instead of exposing a terminal error.
        const detail = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n");
        const authorizationUrl = detail.match(/https:\/\/login\.tailscale\.com\/[^\s]+/)?.[0] ?? null;
        sendJson(res, authorizationUrl ? 409 : 502, { ok: false, authorizationUrl, message: authorizationUrl ? "Tailscale needs one-time approval." : (error instanceof Error ? error.message : String(error)) });
      }
    }
  }), "dsh-codex-meter: remote enable route");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact", path: REMOTE_DISABLE_ROUTE,
    handler: async (req, res) => {
      if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, message: "This action must be started locally on this Mac." });
      try {
        // Either HTTP or HTTPS may be absent; that is already the desired state.
        for (const args of [["serve", "--https=443", "off"], ["serve", "--http=80", "off"]]) {
          try { await tailscale(args); }
          catch (error) { if (!String(error?.stderr ?? error?.message ?? error).includes("handler does not exist")) throw error; }
        }
        sendJson(res, 200, await remoteState());
      } catch (error) { sendJson(res, 502, { ok: false, message: error instanceof Error ? error.message : String(error) }); }
    }
  }), "dsh-codex-meter: remote disable route");

  ctx.on("session/event", (session, event) => {
    try {
      if (event?.type !== "assistant/message") return;
      let record = bySession.get(session.id);
      if (record === void 0) {
        record = { ...emptyCostRecord(), updatedAt: 0 };
        bySession.set(session.id, record);
      }
      priceEventInto(record, event);
      record.updatedAt = event.time ?? Date.now();
    } catch (error) {
      ctx.logger.warn("dsh-codex-meter: failed to price an assistant/message event");
      ctx.logger.warn(error);
    }
  });

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: ROUTE_PATH,
      handler: async (req, res) => {
        try {
          const hit = await ctx.credentials.resolve(CREDENTIAL_REF);
          if (hit === void 0) {
            sendJson(res, 503, {
              ok: false,
              error: "no-api-key",
              message: "未配置 DEEPSEEK_API_KEY：请在 设置 → 模型 中填写 DeepSeek API Key。"
            });
            return;
          }
          const response = await fetch(balanceUrl(), {
            headers: {
              Authorization: `Bearer ${hit.value}`,
              Accept: "application/json"
            },
            signal: AbortSignal.timeout(TIMEOUT_MS)
          });
          const text = await response.text();
          if (!response.ok) {
            sendJson(res, response.status, {
              ok: false,
              error: "provider",
              message: providerMessage(text, response.status)
            });
            return;
          }
          let body = null;
          try {
            body = JSON.parse(text);
          } catch {}
          // DeepSeek 返回的 balance_infos 顺序不稳定（CNY / USD 可能互换），
          // 取 total_balance 最大的条目作为账户主余额，避免把副币种 0.00 误当
          // 当前余额，污染今日消费的余额差值估算。
          const primaryBalance = body && Array.isArray(body.balance_infos)
            ? body.balance_infos.reduce((best, b) => {
              if (b === null || typeof b !== "object") return best;
              if (best === null) return b;
              const bn = Number(b.total_balance) || 0;
              const bestN = Number(best.total_balance) || 0;
              return bn > bestN ? b : best;
            }, null)
            : null;
          const total = primaryBalance ? Number(primaryBalance.total_balance) : NaN;

          // Today's consumption: official platform data first, then the
          // balance-delta estimate.
          let todayConsumed = null;
          let todayConsumedSource = "estimate";
          // 平台 token 状态：ok（官方数据）| expired（已过期）| error（其他失败）
          // | no-data（接口正常但无今日行）| unset（未配置）——透传给 UI 提示。
          let platformTokenStatus = "unset";
          let usageHistory = [];
          const platformHit = await ctx.credentials.resolve(PLATFORM_TOKEN_REF);
          if (platformHit !== void 0) {
            try {
              const official = await fetchPlatformUsage(platformHit.value);
              usageHistory = official.history;
              if (official.todayCost !== null) {
                todayConsumed = official.todayCost;
                todayConsumedSource = "official";
                platformTokenStatus = "ok";
              } else {
                ctx.logger.warn("dsh-codex-meter: platform usage returned no today row; falling back to the balance-delta estimate");
                platformTokenStatus = "no-data";
              }
            } catch (error) {
              ctx.logger.warn("dsh-codex-meter: platform usage fetch failed; falling back to the balance-delta estimate");
              ctx.logger.warn(error);
              platformTokenStatus = error instanceof Error && String(error.message).includes("已过期") ? "expired" : "error";
            }
          }
          if (todayConsumedSource !== "official" && Number.isFinite(total)) {
            todayConsumed = computeTodayConsumed(ctx, total);
          }
          const balanceChanges = observeBalanceChanges(ctx, total, primaryBalance?.currency ?? "CNY");

          sendJson(res, 200, {
            ok: true,
            balance: body,
            todayConsumed,
            todayConsumedSource,
            platformTokenStatus,
            usageHistory,
            balanceChanges
          });
        } catch (error) {
          ctx.logger.warn("dsh-codex-meter: failed to fetch DeepSeek balance");
          ctx.logger.warn(error);
          sendJson(res, 502, {
            ok: false,
            error: "fetch-failed",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }),
    "dsh-codex-meter: balance route"
  );

  // 当前对话费用查询：GET /api/codex-meter/session-cost?sessionId=<id>
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: SESSION_COST_ROUTE_PATH,
      handler: async (req, res) => {
        try {
          const sessionId = new URL(req.url ?? "/", "http://x").searchParams.get("sessionId") ?? "";
          // 优先：全量日志回放（包含重启前的历史）。兜底：实时内存记账。
          let record = null;
          let source = null;
          if (sessionId !== "") {
            const replay = await replaySessionCost(ctx, sessionId);
            if (replay !== null) {
              record = replay;
              source = "log";
            } else {
              const live = bySession.get(sessionId);
              if (live !== void 0) {
                record = live;
                source = "live";
              }
            }
          }
          if (record === null) {
            sendJson(res, 200, {
              ok: true,
              sessionId,
              cost: null,
              costUsd: null,
              calls: 0,
              inputTokens: 0,
              cacheReadTokens: 0,
              outputTokens: 0
            });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            sessionId,
            source,
            cost: roundCost(record.cost),
            costUsd: roundCost(record.costUsd),
            calls: record.calls,
            inputTokens: record.inputTokens,
            cacheReadTokens: record.cacheReadTokens,
            outputTokens: record.outputTokens
          });
        } catch (error) {
          ctx.logger.warn("dsh-codex-meter: session-cost lookup failed");
          ctx.logger.warn(error);
          sendJson(res, 500, { ok: false, error: "internal", message: "internal error" });
        }
      }
    }),
    "dsh-codex-meter: session cost route"
  );
}

export { name, inject, apply };
