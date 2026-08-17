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
		const BALANCE_PATH = "/api/codex-meter/balance";

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
				platformTokenStatus: body && typeof body === "object" ? body.platformTokenStatus : "unset"
			};
		}

		// 余额载荷是否无变化（余额 + 今日消费 + 来源 + token 状态均相同则跳过）。
		function sameBalance(a, b) {
			if (a === null || b === null) return a === b;
			return a.todayConsumed === b.todayConsumed &&
				a.source === b.source &&
				a.platformTokenStatus === b.platformTokenStatus &&
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

		// ---- the widget -------------------------------------------------
		function CodexMeter() {
			const [data, setData] = useState(null);
			const [phase, setPhase] = useState("loading"); // loading | ready | error
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

			return jsx("section", {
				"data-plugin": "dsh-codex-meter",
				style: usagePanel,
				children: jsxs(Fragment, {
					children: [
						jsx("h2", { style: { margin: "0 0 6px", fontSize: 18, lineHeight: "28px" }, children: "Usage" }),
						jsx("p", { style: { margin: "0 0 14px", color: "var(--dsw-alias-label-secondary)", fontSize: 13 }, children: "DeepSeek API balance and usage today." }),
						jsxs("div", { style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, overflow: "hidden", marginBottom: 14 }, children: [
							jsxs("div", { style: popoverRow, children: [jsx("span", { children: "Account balance" }), jsxs("span", { style: { ...value, display: "inline-flex", alignItems: "center", gap: 6 }, children: [jsx("span", { "aria-hidden": true, style: { ...dot, background: phase === "loading" ? "var(--dsw-alias-label-secondary)" : stateColor } }), balanceValue] })] }),
							jsx("div", { style: divider }),
							jsxs("div", { style: popoverRow, children: [jsx("span", { style: label, children: tokenBroken ? "Today (refresh needed)" : "Today" }), jsx("span", { style: todaySource === "official" ? value : { ...value, ...estimate }, children: todayValue })] })
						] }),
						jsx("button", { type: "button", style: detailButton, onClick: () => window.open("https://platform.deepseek.com/usage", "_blank", "noopener"), children: jsxs(Fragment, { children: [jsx("span", { children: "View full usage on DeepSeek Platform" }), jsx("span", { "aria-hidden": true, style: label, children: "›" })] }) })
					]
				})
			});
		}

		// ---- client plugin body -----------------------------------------
		const inject = ["slots"];

		function apply(ctx) {
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
