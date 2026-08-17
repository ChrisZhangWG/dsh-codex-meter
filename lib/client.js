// dsh-codex-meter — browser half.
//
// A native DSH Settings -> Usage page. It shows account balance and today's
// consumption. Polling pauses while the window is
// hidden and only re-renders when a value actually changed. Uses only
// `--dsw-*` theme tokens, so it follows light/dark mode and display scaling.

// Tailscale's HTTP-only fallback is still encrypted by the tailnet, but Chrome
// does not expose crypto.randomUUID() to a non-secure web origin. DSH's RPC
// client needs UUIDs before it can load sessions/workspaces, so provide the
// standard v4 construction from getRandomValues (which remains available).
if (globalThis.crypto && typeof globalThis.crypto.randomUUID !== "function") {
	Object.defineProperty(globalThis.crypto, "randomUUID", {
		configurable: true,
		value: () => {
			const bytes = new Uint8Array(16);
			globalThis.crypto.getRandomValues(bytes);
			bytes[6] = (bytes[6] & 15) | 64;
			bytes[8] = (bytes[8] & 63) | 128;
			const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
			return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
		}
	});
}
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

		function localDateString() {
			const now = new Date();
			const year = now.getFullYear();
			const month = String(now.getMonth() + 1).padStart(2, "0");
			const day = String(now.getDate()).padStart(2, "0");
			return `${year}-${month}-${day}`;
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
				icon.setAttribute("viewBox", "0 0 16 16");
				icon.setAttribute("fill", "none");
				icon.innerHTML = '<path d="M12.55 11.63A5.55 5.55 0 1 0 10.8 13l2.45.72-.7-2.09Z" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/><circle cx="7.15" cy="7.45" r="1.05" fill="currentColor"/>';
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

		// ---- the widget -------------------------------------------------
		function CodexMeter() {
			const [data, setData] = useState(null);
			const [phase, setPhase] = useState("loading"); // loading | ready | error
			const [period, setPeriod] = useState("7d");
			const [activity, setActivity] = useState(null);
			const mounted = useRef(true);

			const load = useCallback(async () => {
				if (document.hidden) return; // 窗口隐藏：暂停余额轮询
				try {
					const result = await fetchBalance();
					if (!mounted.current) return;
					setData((prev) => sameBalance(prev, result) ? prev : result);
					setPhase("ready");
				} catch {
					if (!mounted.current) return;
					setPhase("error");
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
						jsx("p", { style: { margin: "0 0 14px", color: "var(--dsw-alias-label-secondary)", fontSize: 13 }, children: "DeepSeek API balance and official usage history." }),
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
		function RemoteAccess() {
			const [state, setState] = useState(null);
			const [pairState, setPairState] = useState(null);
			const [pairLink, setPairLink] = useState(null);
			const [error, setError] = useState(null);
			const [approvalUrl, setApprovalUrl] = useState(null);
			const [copied, setCopied] = useState(false);
			const [pairCopied, setPairCopied] = useState(false);
			const [busy, setBusy] = useState(false);
			const load = useCallback(async () => {
				try {
					const [remoteRes, pairRes] = await Promise.all([
						fetch("/api/codex-meter/remote-status", { cache: "no-store" }),
						fetch("/api/pair/status", { cache: "no-store" })
					]);
					const remoteBody = await remoteRes.json();
					if (!remoteRes.ok) throw new Error(remoteBody.message || "Unable to read Tailscale status");
					setState(remoteBody);
					if (pairRes.ok) setPairState(await pairRes.json());
					setError(null);
				} catch (e) { setError(e.message); }
			}, []);
			useEffect(() => {
				load();
				const timer = setInterval(load, 5000);
				return () => clearInterval(timer);
			}, [load]);
			const createPairLink = async () => {
				setBusy(true);
				try {
					const res = await fetch("/api/pair/issue", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
					const body = await res.json();
					if (!res.ok || !body.url) throw new Error("Unable to create a pairing link");
					setPairLink(body.url); setError(null); await load();
				} catch (e) { setError(e.message); } finally { setBusy(false); }
			};
			const toggle = async (enable) => {
				const message = enable
					? "Enable private Tailscale access to DSH? Only devices signed in to your Tailscale network can open it."
					: "Disable Tailscale remote access? Your saved phone link will stop working.";
				if (!window.confirm(message)) return;
				setBusy(true);
				try {
					const res = await fetch(enable ? "/api/codex-meter/remote-enable" : "/api/codex-meter/remote-disable", { method: "POST" });
					const body = await res.json();
					if (!res.ok) {
						if (body.authorizationUrl) { setApprovalUrl(body.authorizationUrl); setError(null); return; }
						throw new Error(body.message || "Request failed");
					}
					setState(body); setApprovalUrl(null); setError(null);
				} catch (e) { setError(e.message); } finally { setBusy(false); }
			};
			const remoteCard = { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, overflow: "hidden", marginTop: 14 };
			const remoteRow = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "11px 12px" };
			const remoteButton = { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 7, padding: "7px 10px", cursor: "pointer", background: "var(--dsw-alias-bg-overlay)", color: "var(--dsw-alias-label-primary)" };
			const status = state?.serving ? "Enabled" : "Disabled";
			const phoneStatus = pairState?.deviceCount > 0 ? `${pairState.deviceCount} paired` : "Not paired";
			return jsx("section", { style: usagePanel, children: jsxs(Fragment, { children: [
				jsx("h2", { style: { margin: "0 0 6px", fontSize: 18, lineHeight: "28px" }, children: "Remote access" }),
				jsx("p", { style: { margin: "0 0 14px", ...label, fontSize: 13 }, children: "Open DSH from your phone through your private Tailscale network." }),
				jsx("div", { style: remoteCard, children: state ? jsxs(Fragment, { children: [
					jsxs("div", { style: remoteRow, children: [jsx("span", { children: "Tailscale" }), jsx("strong", { style: value, children: state.online ? "Connected" : "Not connected" })] }),
					jsx("div", { style: divider }),
					jsxs("div", { style: remoteRow, children: [jsx("span", { children: "Remote link" }), jsx("strong", { style: value, children: status })] }),
					jsx("div", { style: divider }),
					jsxs("div", { style: remoteRow, children: [jsx("span", { children: "Phone access" }), jsx("strong", { style: value, children: phoneStatus })] })
				] }) : jsx("div", { style: { ...remoteRow, ...label }, children: "Checking status…" }) }),
				state?.url && jsxs("div", { style: { ...remoteRow, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, marginTop: 14 }, children: [jsx("code", { style: { fontSize: 12 }, children: state.url }), jsx("button", { type: "button", style: copied ? { ...remoteButton, background: "var(--dsw-alias-state-success-primary)", borderColor: "var(--dsw-alias-state-success-primary)", color: "#fff" } : remoteButton, onClick: async () => { await navigator.clipboard.writeText(state.url); setCopied(true); setTimeout(() => setCopied(false), 1600); }, children: copied ? "Copied" : "Copy" })] }),
				jsxs("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }, children: [
					jsx("button", { type: "button", disabled: busy || !state?.online, style: { ...remoteButton, opacity: busy || !state?.online ? .55 : 1 }, onClick: () => toggle(!state?.serving), children: busy ? "Working…" : state?.serving ? "Disable remote access" : "Enable remote access" }),
					state?.serving && jsx("button", { type: "button", style: remoteButton, onClick: createPairLink, children: "Pair a phone" }),
					state?.serving && state?.url && jsx("button", { type: "button", style: remoteButton, onClick: () => window.open("/m", "_blank", "noopener"), children: "Open mobile UI" })
				] }),
				pairLink && jsxs("div", { style: { ...remoteRow, border: "1px solid var(--dsw-alias-state-success-primary)", borderRadius: 8, marginTop: 14 }, children: [jsxs("div", { style: { minWidth: 0 }, children: [jsx("div", { style: { ...value, marginBottom: 4 }, children: "Pairing link ready" }), jsx("code", { style: { display: "block", maxWidth: 430, overflow: "hidden", textOverflow: "ellipsis", fontSize: 11 }, children: pairLink })] }), jsx("button", { type: "button", style: pairCopied ? { ...remoteButton, background: "var(--dsw-alias-state-success-primary)", borderColor: "var(--dsw-alias-state-success-primary)", color: "#fff" } : remoteButton, onClick: async () => { await navigator.clipboard.writeText(pairLink); setPairCopied(true); setTimeout(() => setPairCopied(false), 1600); }, children: pairCopied ? "Copied" : "Copy pairing link" })] }),
				approvalUrl && jsxs("div", { style: { marginTop: 12, padding: "12px", border: "1px solid var(--dsw-alias-state-warn-primary)", borderRadius: 8 }, children: [jsx("div", { style: { ...value, marginBottom: 5 }, children: "One-time Tailscale approval required" }), jsx("p", { style: { margin: "0 0 10px", ...label, fontSize: 13 }, children: "Approve Tailscale Serve in the browser, then return here and click Enable remote access again." }), jsx("button", { type: "button", style: remoteButton, onClick: () => window.open(approvalUrl, "_blank", "noopener"), children: "Approve in Tailscale" })] }),
				jsx("p", { style: { margin: "14px 0 0", ...label, fontSize: 13, lineHeight: "20px" }, children: "DSH stays on this Mac. Tailscale is the only remote entry point; no public URL is created." }),
				error && jsx("p", { style: { margin: "10px 0 0", color: "var(--dsw-alias-state-error-primary)", fontSize: 13 }, children: error })
			] }) });
		}

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
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section", id: "tailscale-remote", order: 110, label: () => "Remote access"
			}, RemoteAccess));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
