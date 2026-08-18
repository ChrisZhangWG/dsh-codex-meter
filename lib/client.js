// dsh-codex-meter — browser half.
//
// A native DSH Settings -> Usage page. It shows account balance and today's
// consumption. Polling pauses while the window is
// hidden and only re-renders when a value actually changed. Uses only
// `--dsw-*` theme tokens, so it follows light/dark mode and display scaling.

window.__ModuleLoader__.load({
	id: "dsh-codex-meter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let jsxRuntime = require("react/jsx-runtime");
		const { useState, useEffect, useCallback, useRef } = react;
		const { jsx, jsxs, Fragment } = jsxRuntime;

		// ---- constants -------------------------------------------------
		const BALANCE_POLL_MS = 60 * 1000;
		const ACTIVITY_POLL_MS = 1000;
		const BALANCE_PATH = "/api/codex-meter/balance";
		const API_ACTIVITY_PATH = "/api/codex-meter/api-activity";
		const USAGE_CACHE_KEY = "dsh-codex-meter:usage-cache:v1";
		const USAGE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

		// ---- small helpers ---------------------------------------------
		function currencySymbol(code) {
			switch (code) {
				case "CNY": return "¥";
				case "USD": return "$";
				case "EUR": return "€";
				case "JPY": return "¥";
				case "HKD": return "HK$";
				default: return code ? `${code} ` : "";
			}
		}

		// 余额展示：整数不带小数，其余保留 2 位。
		function formatBalance(value, currency) {
			const symbol = currencySymbol(currency);
			const n = Number(value);
			if (!Number.isFinite(n)) return `${symbol}—`;
			const text = Number.isInteger(n) ? String(n) : n.toFixed(2);
			return `${symbol}${text}`;
		}

		// 费用展示：按量级选择小数位，避免 ¥0.000000… 长尾。
		function formatCost(value, currency) {
			const symbol = currencySymbol(currency);
			if (!Number.isFinite(value) || value <= 0) return `${symbol}0`;
			if (value >= 100) return `${symbol}${value.toFixed(0)}`;
			if (value >= 1) return `${symbol}${value.toFixed(2)}`;
			if (value >= 0.01) return `${symbol}${value.toFixed(3)}`;
			return `${symbol}${value.toPrecision(2)}`;
		}

		function formatSignedCost(value, currency) {
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			if (Math.abs(n) < 0.005) return formatCost(0, currency);
			return `${n > 0 ? "+" : "−"}${formatCost(Math.abs(n), currency)}`;
		}

		function formatObservedTime(timestamp) {
			const value = Number(timestamp);
			if (!Number.isFinite(value)) return "Unknown time";
			return new Intl.DateTimeFormat(undefined, {
				month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
			}).format(new Date(value));
		}

		function formatTokens(value) {
			const number = Number(value);
			if (!Number.isFinite(number)) return "—";
			if (number >= 1e6) return `${(number / 1e6).toFixed(number >= 1e7 ? 1 : 2)}M`;
			if (number >= 1e3) return `${(number / 1e3).toFixed(number >= 1e5 ? 0 : 1)}K`;
			return Math.round(number).toLocaleString();
		}

		function formatPercent(value) {
			const number = Number(value);
			return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : "—";
		}

		function formatHour(epochSeconds) {
			return new Intl.DateTimeFormat(undefined, {
				hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai"
			}).format(new Date(Number(epochSeconds) * 1000));
		}

		function localDateString() {
			const now = new Date();
			const year = now.getFullYear();
			const month = String(now.getMonth() + 1).padStart(2, "0");
			const day = String(now.getDate()).padStart(2, "0");
			return `${year}-${month}-${day}`;
		}

		function isUsageData(value) {
			return value !== null &&
				typeof value === "object" &&
				(value.payload === null || typeof value.payload === "object") &&
				(value.todayConsumed === null || Number.isFinite(value.todayConsumed)) &&
				(value.source === null || typeof value.source === "string") &&
				typeof value.platformTokenStatus === "string" &&
				Array.isArray(value.usageHistory) &&
				(value.todayAnalysis === void 0 || value.todayAnalysis === null || typeof value.todayAnalysis === "object") &&
				Array.isArray(value.balanceChanges);
		}

		function loadUsageCache() {
			try {
				const raw = globalThis.localStorage?.getItem(USAGE_CACHE_KEY);
				if (!raw) return null;
				const cached = JSON.parse(raw);
				const age = Date.now() - Number(cached?.savedAt);
				if (cached?.version !== 1 || !Number.isFinite(age) || age < 0 || age > USAGE_CACHE_MAX_AGE_MS || !isUsageData(cached.data)) {
					return null;
				}
				return { savedAt: Number(cached.savedAt), data: cached.data };
			} catch {
				return null;
			}
		}

		function saveUsageCache(data) {
			if (!isUsageData(data)) return;
			try {
				globalThis.localStorage?.setItem(USAGE_CACHE_KEY, JSON.stringify({
					version: 1,
					savedAt: Date.now(),
					data
				}));
			} catch {
				// Usage still works if storage is unavailable or full.
			}
		}

		// The settings.section contract has no third-party icon option; unknown
		// section ids receive a gear. Replace only the Usage row's fallback glyph
		// with the compact meter mark requested for this plugin.
		function decorateUsageNavIcon() {
			for (const button of document.querySelectorAll('[role="dialog"] nav button')) {
				const labelNode = [...button.querySelectorAll("span")].find((node) => node.textContent?.trim() === "Usage");
				if (!labelNode) continue;
				const icon = button.querySelector("svg");
				if (!icon || icon.dataset.codexMeterIcon === "usage") continue;
				icon.dataset.codexMeterIcon = "usage";
				icon.setAttribute("viewBox", "0 0 24 24");
				icon.setAttribute("fill", "none");
				icon.innerHTML = '<path d="M15.6 2.7a10 10 0 1 0 5.7 5.7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="2" stroke="currentColor" stroke-width="2"/><path d="M13.4 10.6 19 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
			}
		}

		async function fetchBalance() {
			const res = await fetch(BALANCE_PATH, { cache: "no-store" });
			let body = null;
			try {
				body = await res.json();
			} catch {}
			if (!res.ok) {
				const message =
					body && typeof body.message === "string"
						? body.message
						: `请求失败（HTTP ${res.status}）`;
				const error = new Error(message);
				error.code = body && typeof body.error === "string" ? body.error : `http-${res.status}`;
				throw error;
			}
			const payload = body && typeof body === "object" && body.balance ? body.balance : body;
			const todayConsumed =
				body && typeof body === "object" && typeof body.todayConsumed === "number"
					? body.todayConsumed
					: null;
			return {
				payload,
				todayConsumed,
				source: body && typeof body === "object" ? body.todayConsumedSource : null,
				platformTokenStatus: body && typeof body === "object" ? body.platformTokenStatus : "unset",
				usageHistory: body && typeof body === "object" && Array.isArray(body.usageHistory)
					? body.usageHistory
						.filter((entry) => entry && typeof entry.date === "string" && entry.date <= localDateString() && Number.isFinite(Number(entry.cost)))
						.map((entry) => ({ date: entry.date, cost: Number(entry.cost) }))
					: [],
				todayAnalysis: body && typeof body === "object" && body.todayAnalysis && typeof body.todayAnalysis === "object"
					? body.todayAnalysis
					: null,
				balanceChanges: body && typeof body === "object" && Array.isArray(body.balanceChanges)
					? body.balanceChanges.filter((entry) => entry && Number.isFinite(Number(entry.delta)))
					: []
			};
		}

		async function fetchApiActivity() {
			const res = await fetch(API_ACTIVITY_PATH, { cache: "no-store" });
			if (!res.ok) throw new Error(`Activity request failed (HTTP ${res.status})`);
			const body = await res.json();
			return {
				active: body?.active === true,
				count: Number.isFinite(Number(body?.count)) ? Number(body.count) : 0,
				calls: Array.isArray(body?.calls) ? body.calls : []
			};
		}

		function formatElapsed(startedAt) {
			const seconds = Math.max(0, Math.floor((Date.now() - Number(startedAt)) / 1000));
			if (!Number.isFinite(seconds)) return "";
			if (seconds < 60) return `${seconds}s`;
			return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
		}

		// 余额载荷是否无变化（余额 + 今日消费 + 来源 + token 状态均相同则跳过）。
		function sameBalance(a, b) {
			if (a === null || b === null) return a === b;
			return a.todayConsumed === b.todayConsumed &&
				a.source === b.source &&
				a.platformTokenStatus === b.platformTokenStatus &&
				JSON.stringify(a.usageHistory) === JSON.stringify(b.usageHistory) &&
				JSON.stringify(a.todayAnalysis) === JSON.stringify(b.todayAnalysis) &&
				JSON.stringify(a.balanceChanges) === JSON.stringify(b.balanceChanges) &&
				JSON.stringify(a.payload) === JSON.stringify(b.payload);
		}

		// ---- inline styles ---------------------------------------------
		const pill = {
			position: "absolute",
			right: 12,
			bottom: 10,
			zIndex: 30,
			pointerEvents: "auto",
			boxSizing: "border-box",
			display: "inline-flex",
			alignItems: "center",
			gap: 4,
			maxWidth: "min(380px, calc(100vw - 24px))",
			borderRadius: 999,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-overlay)",
			boxShadow: "0 1px 4px rgba(0, 0, 0, 0.12)",
			padding: "2px 8px",
			color: "var(--dsw-alias-label-secondary)",
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			fontSize: 10.5,
			lineHeight: "16px",
			fontVariantNumeric: "tabular-nums",
			letterSpacing: "0.01em",
			whiteSpace: "nowrap",
			userSelect: "none",
			cursor: "pointer",
			transition: "border-color 120ms ease, background 120ms ease"
		};

		const pillHover = {
			borderColor: "var(--dsw-alias-border-l3)",
			background: "var(--dsw-alias-interactive-bg-hover)"
		};

		const dot = {
			flex: "none",
			width: 6,
			height: 6,
			borderRadius: "50%",
			flexShrink: 0
		};

		const segment = {
			display: "inline-flex",
			alignItems: "baseline",
			gap: 3
		};

		const sep = {
			color: "var(--dsw-alias-border-l3)",
			flexShrink: 0
		};

		const value = {
			color: "var(--dsw-alias-label-primary)",
			fontWeight: 600
		};

		const label = {
			color: "var(--dsw-alias-label-secondary)",
			fontWeight: 400
		};

		const estimate = {
			color: "var(--dsw-alias-label-secondary)",
			fontWeight: 400
		};

		const warn = {
			color: "var(--dsw-alias-state-warn-primary)",
			fontWeight: 600
		};

		const warnBang = {
			color: "var(--dsw-alias-state-warn-primary)",
			fontWeight: 700
		};

		const usagePanel = {
			maxWidth: 640,
			padding: "4px 0 24px",
			fontFamily: "var(--dsw-font-family, ui-sans-serif, system-ui, sans-serif)",
			color: "var(--dsw-alias-label-primary)"
		};

		const detailButton = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 8,
			width: "100%",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-overlay)",
			color: "var(--dsw-alias-label-primary)",
			padding: "9px 12px",
			cursor: "pointer",
			textAlign: "left"
		};

		const popoverRow = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 12,
			padding: "10px 12px"
		};

		const divider = { height: 1, background: "var(--dsw-alias-border-l2)" };

		const periodButton = {
			border: 0,
			borderRadius: 6,
			padding: "4px 8px",
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 12,
			cursor: "pointer"
		};

		function UsageChart({ history, currency }) {
			if (!Array.isArray(history) || history.length === 0) {
				return jsx("div", {
					style: { display: "grid", placeItems: "center", minHeight: 150, color: "var(--dsw-alias-label-secondary)", fontSize: 13 },
					children: "No official daily records are available for this period."
				});
			}
			const max = Math.max(...history.map((entry) => entry.cost), 0.01);
			const width = 620;
			const height = 180;
			const top = 32;
			const bottom = 30;
			const plotHeight = height - top - bottom;
			const inset = 10;
			const plotWidth = width - inset * 2;
			const baseline = top + plotHeight;
			const labelEvery = history.length <= 8 ? 1 : history.length <= 16 ? 2 : 5;
			const points = history.map((entry, index) => {
				const x = history.length === 1 ? width / 2 : inset + (index / (history.length - 1)) * plotWidth;
				const y = baseline - (entry.cost / max) * plotHeight;
				return { ...entry, x, y };
			});
			const linePoints = points.map((point) => `${point.x},${point.y}`).join(" ");
			const areaPoints = `${points[0].x},${baseline} ${linePoints} ${points[points.length - 1].x},${baseline}`;
			return jsx("svg", {
				viewBox: `0 0 ${width} ${height}`,
				role: "img",
				"aria-label": "Official DeepSeek daily API cost",
				style: { display: "block", width: "100%", height: 180, overflow: "visible" },
				children: jsxs(Fragment, { children: [
					jsx("line", { x1: inset, y1: baseline, x2: width - inset, y2: baseline, stroke: "var(--dsw-alias-border-l2)" }),
					jsx("polygon", { points: areaPoints, fill: "var(--dsw-alias-accent-primary, #4f7cff)", fillOpacity: 0.1 }),
					jsx("polyline", { points: linePoints, fill: "none", stroke: "var(--dsw-alias-accent-primary, #4f7cff)", strokeWidth: 2.5, strokeLinejoin: "round", strokeLinecap: "round" }),
					...points.map((point, index) => {
						const day = point.date.slice(8).replace(/^0/, "");
						const labelOffset = index % 2 === 0 ? 8 : 18;
						const dataLabelY = Math.max(index % 2 === 0 ? 10 : 20, point.y - labelOffset);
						return jsxs("g", { children: [
							jsx("title", { children: `${point.date}: ${formatCost(point.cost, currency)}` }),
							jsx("text", { x: point.x, y: dataLabelY, textAnchor: "middle", fill: "var(--dsw-alias-label-primary)", fontSize: history.length > 14 ? 8.5 : 10, fontWeight: 600, children: formatCost(point.cost, currency) }),
							jsx("circle", { cx: point.x, cy: point.y, r: history.length <= 8 ? 4 : 2.7, fill: "var(--dsw-alias-bg-overlay)", stroke: "var(--dsw-alias-accent-primary, #4f7cff)", strokeWidth: 2 }),
							(index % labelEvery === 0 || index === history.length - 1) && jsx("text", { x: point.x, y: height - 8, textAnchor: "middle", fill: "var(--dsw-alias-label-secondary)", fontSize: 10, children: day })
						] }, point.date);
					})
				] })
			});
		}

		function RangeMetric({ title, valueText, status, tone, marker, segments }) {
			return jsxs("div", { style: { padding: "11px 12px 10px" }, children: [
				jsxs("div", { style: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }, children: [
					jsxs("div", { children: [
						jsx("div", { style: { ...label, fontSize: 11 }, children: title }),
						jsx("div", { style: { ...value, marginTop: 2, fontSize: 20, lineHeight: 1.2, fontVariantNumeric: "tabular-nums" }, children: valueText })
					] }),
					jsx("span", { style: { borderRadius: 999, padding: "3px 8px", background: `color-mix(in srgb, ${tone} 16%, transparent)`, color: tone, fontSize: 11, fontWeight: 600 }, children: status })
				] }),
				jsxs("div", { style: { position: "relative", margin: "11px 5px 0" }, children: [
					jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 2, height: 7, overflow: "hidden", borderRadius: 999 }, children: segments.map((segment) => jsx("div", { style: { background: segment.color } }, segment.label)) }),
					jsx("span", { "aria-hidden": true, style: { position: "absolute", left: `${Math.max(2, Math.min(98, marker))}%`, top: "50%", width: 11, height: 11, borderRadius: "50%", background: "var(--dsw-alias-label-primary)", border: "2px solid var(--dsw-alias-bg-overlay)", boxShadow: "0 1px 3px rgba(0,0,0,.35)", transform: "translate(-50%, -50%)" } })
				] }),
				jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginTop: 6 }, children: segments.map((segment) => jsxs("div", { style: { textAlign: "center", fontSize: 10, lineHeight: 1.25 }, children: [
					jsx("div", { style: { color: "var(--dsw-alias-label-primary)" }, children: segment.label }),
					jsx("div", { style: label, children: segment.range })
				] }, segment.label)) })
			] });
		}

		// ---- the widget -------------------------------------------------
		function CodexMeter() {
			const [initialCache] = useState(() => loadUsageCache());
			const [data, setData] = useState(() => initialCache?.data ?? null);
			const [phase, setPhase] = useState(() => initialCache ? "ready" : "loading"); // loading | ready | error
			const [cacheNotice, setCacheNotice] = useState(() => initialCache ? "refreshing" : null); // refreshing | failed | null
			const [period, setPeriod] = useState("7d");
			const [activity, setActivity] = useState(null);
			const mounted = useRef(true);
			const dataRef = useRef(initialCache?.data ?? null);

			const load = useCallback(async () => {
				if (document.hidden) return; // 窗口隐藏：暂停余额轮询
				try {
					const result = await fetchBalance();
					if (!mounted.current) return;
					saveUsageCache(result);
					dataRef.current = result;
					setData((prev) => sameBalance(prev, result) ? prev : result);
					setPhase("ready");
					setCacheNotice(null);
				} catch {
					if (!mounted.current) return;
					if (dataRef.current) {
						setPhase("ready");
						setCacheNotice("failed");
					} else {
						setPhase("error");
					}
				}
			}, []);

			useEffect(() => {
				mounted.current = true;
				load();
				const timer = setInterval(load, BALANCE_POLL_MS);
				const onVisible = () => {
					if (!document.hidden) load();
				};
				document.addEventListener("visibilitychange", onVisible);
				return () => {
					mounted.current = false;
					clearInterval(timer);
					document.removeEventListener("visibilitychange", onVisible);
				};
			}, [load]);

			useEffect(() => {
				let disposed = false;
				const loadActivity = async () => {
					if (document.hidden) return;
					try {
						const next = await fetchApiActivity();
						if (!disposed) setActivity(next);
					} catch {
						if (!disposed) setActivity(null);
					}
				};
				loadActivity();
				const timer = setInterval(loadActivity, ACTIVITY_POLL_MS);
				return () => { disposed = true; clearInterval(timer); };
			}, []);

			const payload = data ? data.payload : null;
			// DeepSeek 返回的 balance_infos 顺序不稳定（CNY / USD 可能互换），
			// 取 total_balance 最大的条目作为账户主余额，避免偶尔取到副币种 0.00。
			const balanceInfo = payload && Array.isArray(payload.balance_infos)
				? payload.balance_infos.reduce((best, b) => {
					if (b === null || typeof b !== "object") return best;
					if (best === null) return b;
					const bn = Number(b.total_balance) || 0;
					const bestN = Number(best.total_balance) || 0;
					return bn > bestN ? b : best;
				}, null)
				: null;
			const available = payload ? payload.is_available !== false : null;
			const currency = balanceInfo ? balanceInfo.currency : "CNY";
			const totalBalance = balanceInfo ? Number(balanceInfo.total_balance) : NaN;
			const todayConsumed = data ? data.todayConsumed : null;
			const todaySource = data ? data.source : null;
			const platformTokenStatus = data ? data.platformTokenStatus : "unset";
			const officialHistory = data ? data.usageHistory : [];
			const chartHistory = period === "7d" ? officialHistory.slice(-7) : officialHistory;
			const chartTotal = chartHistory.reduce((sum, entry) => sum + entry.cost, 0);
			const chartAverage = chartHistory.length > 0 ? chartTotal / chartHistory.length : 0;
			const chartPeak = chartHistory.length > 0 ? Math.max(...chartHistory.map((entry) => entry.cost)) : 0;
			const balanceChanges = data ? data.balanceChanges : [];
			const latestChange = balanceChanges.length > 0 ? balanceChanges[balanceChanges.length - 1] : null;
			const todayAnalysis = data?.todayAnalysis ?? null;
			const cacheRate = todayAnalysis ? Number(todayAnalysis.cacheHitRate) : NaN;
			const averageInputTokens = todayAnalysis ? Number(todayAnalysis.averageInputTokens) : NaN;
			const cacheState = cacheRate >= .9
				? { label: "Healthy", tone: "var(--dsw-alias-state-success-primary)", marker: 66.667 + Math.min(1, (cacheRate - .9) / .1) * 33.333, phrase: "Cache is healthy" }
				: cacheRate >= .7
					? { label: "Fair", tone: "var(--dsw-alias-state-warn-primary)", marker: 33.333 + ((cacheRate - .7) / .2) * 33.333, phrase: "Cache reuse was mixed" }
					: { label: "Low", tone: "var(--dsw-alias-state-error-primary)", marker: Math.max(0, cacheRate / .7) * 33.333, phrase: "Cache reuse was low" };
			const contextState = averageInputTokens > 100000
				? { label: "Heavy", tone: "var(--dsw-alias-state-warn-primary)", marker: 66.667 + Math.min(1, (averageInputTokens - 100000) / 100000) * 33.333, phrase: "long contexts were common today", action: "Finish this step  →  Create a compact handoff  →  Start a new session" }
				: averageInputTokens >= 50000
					? { label: "Growing", tone: "var(--dsw-alias-state-warn-primary)", marker: 33.333 + ((averageInputTokens - 50000) / 50000) * 33.333, phrase: "context size was growing today", action: "Keep the task focused  →  Create a handoff at the next milestone" }
					: { label: "Light", tone: "var(--dsw-alias-state-success-primary)", marker: Math.max(0, averageInputTokens / 50000) * 33.333, phrase: "context stayed light today", action: "No session change is needed based on today's average" };
			const analysisBreakdown = todayAnalysis ? [
				{ label: "Cache hit input", tokens: todayAnalysis.cacheHitTokens, cost: todayAnalysis.cacheHitCost },
				{ label: "Cache miss input", tokens: todayAnalysis.cacheMissTokens, cost: todayAnalysis.cacheMissCost },
				{ label: "Output", tokens: todayAnalysis.responseTokens, cost: todayAnalysis.responseCost }
			] : [];
			// Show a warning label if the platform token has expired or failed.
			const tokenBroken = platformTokenStatus === "expired" || platformTokenStatus === "error";

			const stateColor =
				phase === "error"
					? "var(--dsw-alias-state-error-primary)"
					: available === false
						? "var(--dsw-alias-state-error-primary)"
						: "var(--dsw-alias-state-success-primary)";

			// The two fields are always shown: balance and today.
			const todayValue = todayConsumed !== null
				? todaySource === "official"
					? formatCost(todayConsumed, currency)
					: `≈${formatCost(todayConsumed, currency)}`
				: "—";
			const balanceValue = phase === "error" ? "—" : formatBalance(totalBalance, currency);
			const activeCall = activity?.calls?.[0] ?? null;
			const activityText = activity === null
				? "Unavailable"
				: activity.active
					? `Active · ${activity.count} call${activity.count === 1 ? "" : "s"}${activeCall ? ` · ${formatElapsed(activeCall.startedAt)}` : ""}`
					: "Idle";

			return jsx("section", {
				"data-plugin": "dsh-codex-meter",
				style: usagePanel,
				children: jsxs(Fragment, {
					children: [
						jsx("h2", { style: { margin: "0 0 6px", fontSize: 18, lineHeight: "28px" }, children: "Usage" }),
						jsxs("p", { style: { margin: "0 0 14px", color: "var(--dsw-alias-label-secondary)", fontSize: 13 }, children: [
							"DeepSeek API balance and official usage history.",
							cacheNotice === "refreshing" && jsx("span", { style: { display: "block", marginTop: 3 }, children: "Showing saved data · refreshing…" }),
							cacheNotice === "failed" && jsx("span", { style: { display: "block", marginTop: 3, color: "var(--dsw-alias-state-warn-primary)" }, children: "Refresh failed · showing the last saved data." })
						] }),
						jsxs("div", { style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, overflow: "hidden", marginBottom: 14 }, children: [
							jsxs("div", { style: popoverRow, children: [jsx("span", { children: "Account balance" }), jsxs("span", { style: { ...value, display: "inline-flex", alignItems: "center", gap: 6 }, children: [jsx("span", { "aria-hidden": true, style: { ...dot, background: phase === "loading" ? "var(--dsw-alias-label-secondary)" : stateColor } }), balanceValue] })] }),
							jsx("div", { style: divider }),
							jsxs("div", { style: popoverRow, children: [jsx("span", { style: label, children: tokenBroken ? "Today (refresh needed)" : "Today" }), jsx("span", { style: todaySource === "official" ? value : { ...value, ...estimate }, children: todayValue })] }),
							jsx("div", { style: divider }),
							jsxs("div", { style: popoverRow, children: [
								jsxs("span", { children: [jsx("span", { children: "API activity" }), jsx("span", { style: { display: "block", marginTop: 2, ...label, fontSize: 11 }, children: activity?.active ? "A model request is in progress; final cost appears after completion." : "No model API call is currently in progress." })] }),
								jsxs("span", { style: { ...value, display: "inline-flex", alignItems: "center", gap: 6, color: activity?.active ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-label-primary)" }, children: [jsx("span", { "aria-hidden": true, style: { ...dot, background: activity?.active ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-label-secondary)" } }), activityText] })
							] }),
							jsx("div", { style: divider }),
							jsxs("div", { style: popoverRow, children: [
								jsxs("span", { children: [jsx("span", { children: "Last balance change" }), latestChange && jsx("span", { style: { display: "block", marginTop: 2, ...label, fontSize: 11 }, children: `Observed ${formatObservedTime(latestChange.at)}` })] }),
								jsx("span", { style: { ...value, color: latestChange && Number(latestChange.delta) > 0 ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-label-primary)" }, children: latestChange ? formatSignedCost(latestChange.delta, currency) : "No change observed" })
							] })
						] }),
						todayAnalysis && jsxs("div", { style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, overflow: "hidden", marginBottom: 14 }, children: [
							jsxs("div", { style: { padding: "11px 12px 9px" }, children: [
								jsx("div", { style: value, children: "Today's token analysis" }),
								jsx("div", { style: { ...label, marginTop: 2, fontSize: 11 }, children: "Today's overall pattern · DeepSeek Official · all API keys" })
							] }),
							jsx("div", { style: divider }),
							jsx("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 1, background: "var(--dsw-alias-border-l2)" }, children: [
								["Requests", Number(todayAnalysis.requests).toLocaleString()],
								["Today's cost", formatCost(todayAnalysis.officialCost, currency)]
							].map(([metricLabel, metricValue]) => jsxs("div", { style: { padding: "10px 12px", background: "var(--dsw-alias-bg-overlay)" }, children: [
								jsx("div", { style: { ...label, fontSize: 11 }, children: metricLabel }),
								jsx("div", { style: { ...value, marginTop: 3, fontVariantNumeric: "tabular-nums" }, children: metricValue })
							] }, metricLabel)) }),
							jsx("div", { style: divider }),
							jsx(RangeMetric, {
								title: "Cache efficiency",
								valueText: formatPercent(cacheRate),
								status: cacheState.label,
								tone: cacheState.tone,
								marker: cacheState.marker,
								segments: [
									{ label: "Low", range: "<70%", color: "color-mix(in srgb, var(--dsw-alias-state-error-primary) 65%, transparent)" },
									{ label: "Fair", range: "70–90%", color: "color-mix(in srgb, var(--dsw-alias-state-warn-primary) 70%, transparent)" },
									{ label: "Healthy", range: ">90%", color: "color-mix(in srgb, var(--dsw-alias-state-success-primary) 70%, transparent)" }
								]
							}),
							jsx("div", { style: divider }),
							jsx(RangeMetric, {
								title: "Context size",
								valueText: `${formatTokens(averageInputTokens)} / request`,
								status: contextState.label,
								tone: contextState.tone,
								marker: contextState.marker,
								segments: [
									{ label: "Light", range: "<50K", color: "color-mix(in srgb, var(--dsw-alias-state-success-primary) 70%, transparent)" },
									{ label: "Growing", range: "50–100K", color: "color-mix(in srgb, var(--dsw-alias-state-warn-primary) 70%, transparent)" },
									{ label: "Heavy", range: ">100K", color: "color-mix(in srgb, #ed7d31 78%, transparent)" }
								]
							}),
							jsxs("div", { style: { margin: "0 12px 11px", padding: "9px 10px", borderRadius: 8, background: `color-mix(in srgb, ${contextState.tone} 10%, transparent)`, color: "var(--dsw-alias-label-primary)", fontSize: 12, lineHeight: 1.45 }, children: [
								jsx("div", { style: { fontWeight: 600 }, children: `${cacheState.phrase}, but ${contextState.phrase}.` }),
								jsx("div", { style: { marginTop: 4, color: contextState.tone, fontWeight: 600 }, children: contextState.action })
							] }),
							jsxs("details", { style: { borderTop: "1px solid var(--dsw-alias-border-l2)" }, children: [
								jsx("summary", { style: { padding: "9px 12px", cursor: "pointer", color: "var(--dsw-alias-label-primary)", fontSize: 12 }, children: `Why did today cost ${formatCost(todayAnalysis.officialCost, currency)}?` }),
								jsx("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l2)", padding: "6px 12px" }, children: analysisBreakdown.map((entry) => jsxs("div", { style: { display: "grid", gridTemplateColumns: "1fr auto auto", gap: 12, alignItems: "baseline", padding: "4px 0", fontSize: 12 }, children: [
									jsx("span", { children: entry.label }),
									jsx("span", { style: label, children: formatTokens(entry.tokens) }),
									jsx("strong", { style: value, children: formatCost(Number(entry.cost), currency) })
								] }, entry.label)) })
							] }),
							Array.isArray(todayAnalysis.hourly) && todayAnalysis.hourly.length > 0 && jsxs("details", { style: { borderTop: "1px solid var(--dsw-alias-border-l2)" }, children: [
								jsx("summary", { style: { padding: "9px 12px", cursor: "pointer", color: "var(--dsw-alias-label-primary)", fontSize: 12 }, children: `Hourly records (${todayAnalysis.hourly.length})` }),
								jsx("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l2)", maxHeight: 240, overflowY: "auto" }, children: todayAnalysis.hourly.map((entry) => jsxs("div", { style: { display: "grid", gridTemplateColumns: "52px 1fr auto", gap: 10, padding: "7px 12px", borderBottom: "1px solid var(--dsw-alias-border-l2)", fontSize: 12 }, children: [
									jsx("span", { style: value, children: formatHour(entry.time) }),
									jsx("span", { style: label, children: `${Number(entry.requests).toLocaleString()} requests · ${formatTokens(Number(entry.cacheHitTokens) + Number(entry.cacheMissTokens) + Number(entry.responseTokens))}` }),
									jsx("span", { style: value, children: formatCost(Number(entry.officialCost), currency) })
								] }, entry.time)) })
							] })
						] }),
						jsxs("div", { style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, padding: "12px 12px 4px", marginBottom: 14 }, children: [
							jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 2 }, children: [
								jsxs("div", { children: [jsx("div", { style: value, children: "Official cost trend" }), jsx("div", { style: { ...label, marginTop: 2, fontSize: 11 }, children: "DeepSeek Official" })] }),
								jsxs("div", { style: { display: "inline-flex", padding: 2, borderRadius: 8, background: "var(--dsw-alias-bg-base, rgba(127,127,127,.1))" }, children: [
									jsx("button", { type: "button", style: period === "7d" ? { ...periodButton, background: "var(--dsw-alias-bg-overlay)", color: "var(--dsw-alias-label-primary)", boxShadow: "0 1px 2px rgba(0,0,0,.08)" } : periodButton, onClick: () => setPeriod("7d"), children: "7D" }),
									jsx("button", { type: "button", style: period === "month" ? { ...periodButton, background: "var(--dsw-alias-bg-overlay)", color: "var(--dsw-alias-label-primary)", boxShadow: "0 1px 2px rgba(0,0,0,.08)" } : periodButton, onClick: () => setPeriod("month"), children: "Month" })
								] })
							] }),
							chartHistory.length > 0 && jsxs("div", { style: { display: "flex", gap: 18, flexWrap: "wrap", margin: "10px 0 0", fontSize: 11 }, children: [
								jsxs("span", { style: label, children: ["Total ", jsx("strong", { style: value, children: formatCost(chartTotal, currency) })] }),
								jsxs("span", { style: label, children: ["Daily avg ", jsx("strong", { style: value, children: formatCost(chartAverage, currency) })] }),
								jsxs("span", { style: label, children: ["Peak ", jsx("strong", { style: value, children: formatCost(chartPeak, currency) })] })
							] }),
							jsx(UsageChart, { history: chartHistory, currency })
						] }),
						officialHistory.length > 0 && jsxs("details", { style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, marginBottom: 14, overflow: "hidden" }, children: [
							jsx("summary", { style: { padding: "10px 12px", cursor: "pointer", color: "var(--dsw-alias-label-primary)", fontSize: 13 }, children: `Official daily records (${officialHistory.length})` }),
							jsx("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l2)", maxHeight: 260, overflowY: "auto" }, children: [...officialHistory].reverse().map((entry) => jsxs("div", { style: { ...popoverRow, padding: "8px 12px", borderBottom: "1px solid var(--dsw-alias-border-l2)", fontSize: 12 }, children: [jsx("span", { style: label, children: entry.date }), jsx("span", { style: value, children: formatCost(entry.cost, currency) })] }, entry.date)) })
						] }),
						jsx("button", { type: "button", style: detailButton, onClick: () => window.open("https://platform.deepseek.com/usage", "_blank", "noopener"), children: jsxs(Fragment, { children: [jsx("span", { children: "View full usage on DeepSeek Platform" }), jsx("span", { "aria-hidden": true, style: label, children: "›" })] }) })
					]
				})
			});
		}

		// ---- client plugin body -----------------------------------------
		const inject = ["slots"];

		function apply(ctx) {
			ctx.effect(() => {
				decorateUsageNavIcon();
				const observer = new MutationObserver(decorateUsageNavIcon);
				observer.observe(document.body, { childList: true, subtree: true });
				return () => observer.disconnect();
			}, "dsh-codex-meter: Usage navigation icon");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "codex-meter",
				order: 100,
				// DSH evaluates the label when building the Settings navigation.
				// It must be a resolver, not a string (otherwise the Settings shell
				// attempts to call the string and renders a blank page).
				label: () => "Usage"
			}, CodexMeter));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
