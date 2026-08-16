// dsh-codex-meter — browser half.
//
// A Codex-style compact meter for the dsh web GUI: one tiny monospace status
// pill pinned to the bottom-right corner (registered into the frame-wide
// `shell.overlay` slot). It shows, at a glance:
//
//   ↑1.2k ↓3.4k · ¥1.23 · 余额¥45.67
//
//   ↑ / ↓     tokens in (input + cache read) / tokens out, abbreviated k/M
//   ¥1.23     current session cost (host prices the session log; 5s poll)
//   ¥45.67    remaining DeepSeek API balance (official /user/balance; 60s poll)
//
// Hover shows details (granted / topped-up balance, today's consumption,
// updated time); click forces a refresh. Uses only `--dsw-*` theme tokens, so
// it follows light/dark mode and the app's display-size scaling.
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
		const COST_POLL_MS = 5 * 1000;
		const BALANCE_PATH = "/api/codex-meter/balance";
		const COST_PATH = "/api/codex-meter/session-cost";

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

		// token 缩写（Codex 风格）：1.2k / 3.4k / 5.6M。
		function formatTokens(value) {
			const n = Math.round(value);
			if (n < 1000) return String(n);
			if (n < 1e6) {
				const k = n / 1000;
				return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k`;
			}
			return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
		}

		function formatTime(date) {
			const hh = String(date.getHours()).padStart(2, "0");
			const mm = String(date.getMinutes()).padStart(2, "0");
			const ss = String(date.getSeconds()).padStart(2, "0");
			return `${hh}:${mm}:${ss}`;
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
			return { payload, todayConsumed, source: body && typeof body === "object" ? body.todayConsumedSource : null };
		}

		async function fetchSessionCost(sessionId) {
			const res = await fetch(`${COST_PATH}?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
			const body = await res.json();
			if (body === null || typeof body !== "object" || body.ok !== true) return null;
			return body;
		}

		// 会话费用是否无变化（避免空闲时每 5s 无谓重渲染）。
		function sameCost(a, b) {
			if (a === null || b === null) return a === b;
			return a.cost === b.cost &&
				a.costUsd === b.costUsd &&
				a.calls === b.calls &&
				a.inputTokens === b.inputTokens &&
				a.cacheReadTokens === b.cacheReadTokens &&
				a.outputTokens === b.outputTokens;
		}

		// 余额载荷是否无变化（余额 + 今日消费 + 来源均相同则跳过）。
		function sameBalance(a, b) {
			if (a === null || b === null) return a === b;
			return a.todayConsumed === b.todayConsumed &&
				a.source === b.source &&
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
			gap: 6,
			maxWidth: "min(320px, calc(100vw - 24px))",
			borderRadius: 999,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-overlay)",
			boxShadow: "0 1px 4px rgba(0, 0, 0, 0.12)",
			padding: "3px 10px",
			color: "var(--dsw-alias-label-secondary)",
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			fontSize: 11,
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

		const tokensIn = {
			color: "var(--dsw-alias-label-secondary)"
		};

		const tokensOut = {
			color: "var(--dsw-alias-label-secondary)"
		};

		const cost = {
			color: "var(--dsw-alias-label-primary)",
			fontWeight: 600
		};

		const balance = {
			color: "var(--dsw-alias-label-primary)",
			fontWeight: 600
		};

		const balanceLabel = {
			color: "var(--dsw-alias-label-secondary)",
			fontWeight: 400
		};

		// ---- the widget -------------------------------------------------
		function CodexMeter(props) {
			const useSessions = props.useSessions;
			const [data, setData] = useState(null);
			const [phase, setPhase] = useState("loading"); // loading | ready | error
			const [message, setMessage] = useState("");
			const [updatedAt, setUpdatedAt] = useState(null);
			const [conversation, setConversation] = useState(null);
			const [hover, setHover] = useState(false);
			const mounted = useRef(true);

			// 当前会话 id（SessionListState.current，由框架标准属性注入）。
			const currentSessionId = typeof useSessions === "function" ? useSessions((s) => s.current) : void 0;

			// 轮询当前对话费用（宿主按会话日志回放计价）。只在窗口可见时轮询
			// （隐藏时暂停，恢复可见立即补一次），且仅当数值确实变化时才触发
			// 重渲染——空闲时不再每 5s 白白刷新。
			useEffect(() => {
				if (currentSessionId === void 0) {
					setConversation(null);
					return;
				}
				let cancelled = false;
				const loadCost = async () => {
					if (document.hidden) return; // 窗口隐藏/最小化：暂停轮询
					try {
						const body = await fetchSessionCost(currentSessionId);
						if (cancelled || body === null) return;
						setConversation((prev) => sameCost(prev, body) ? prev : body);
					} catch {}
				};
				const onVisible = () => {
					if (!document.hidden) loadCost();
				};
				loadCost();
				const timer = setInterval(loadCost, COST_POLL_MS);
				document.addEventListener("visibilitychange", onVisible);
				return () => {
					cancelled = true;
					clearInterval(timer);
					document.removeEventListener("visibilitychange", onVisible);
				};
			}, [currentSessionId]);

			const load = useCallback(async () => {
				if (document.hidden) return; // 窗口隐藏：暂停余额轮询
				try {
					const result = await fetchBalance();
					if (!mounted.current) return;
					setData((prev) => sameBalance(prev, result) ? prev : result);
					setPhase("ready");
					setMessage("");
					setUpdatedAt(new Date());
				} catch (error) {
					if (!mounted.current) return;
					setPhase("error");
					setMessage(error instanceof Error ? error.message : String(error));
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
			const granted = balanceInfo ? Number(balanceInfo.granted_balance) : NaN;
			const toppedUp = balanceInfo ? Number(balanceInfo.topped_up_balance) : NaN;
			const todayConsumed = data ? data.todayConsumed : null;
			const todaySource = data ? data.source : null;

			const convCost = conversation && typeof conversation.cost === "number" ? conversation.cost : null;
			const inputTokens = conversation && typeof conversation.inputTokens === "number" ? conversation.inputTokens : 0;
			const cacheReadTokens = conversation && typeof conversation.cacheReadTokens === "number" ? conversation.cacheReadTokens : 0;
			const outputTokens = conversation && typeof conversation.outputTokens === "number" ? conversation.outputTokens : 0;
			const calls = conversation && typeof conversation.calls === "number" ? conversation.calls : 0;

			const stateColor =
				phase === "error"
					? "var(--dsw-alias-state-error-primary)"
					: available === false
						? "var(--dsw-alias-state-error-primary)"
						: "var(--dsw-alias-state-success-primary)";

			// 悬浮详情（原生 title，保持极简）。
			const detailLines = [];
			if (phase === "error") {
				detailLines.push(`错误：${message}`);
			} else {
				detailLines.push(`DeepSeek 余额 ${formatBalance(totalBalance, currency)} · ${available === false ? "不可用" : "可用"}`);
				if (currentSessionId !== void 0 && convCost !== null) {
					detailLines.push(`本会话 ${formatCost(convCost, currency)}（↑${formatTokens(inputTokens + cacheReadTokens)} 输入 / ↓${formatTokens(outputTokens)} 输出 / ${calls} 次调用）`);
				}
				if (todayConsumed !== null) {
					detailLines.push(`今日${todaySource === "official" ? "已消费" : "约消费"} ${formatBalance(todayConsumed, currency)}`);
				}
				if (Number.isFinite(granted) || Number.isFinite(toppedUp)) {
					detailLines.push(`赠送 ${formatBalance(granted, currency)} · 充值 ${formatBalance(toppedUp, currency)}`);
				}
				detailLines.push(`更新于 ${updatedAt ? formatTime(updatedAt) : "—"} · 点击刷新`);
			}
			const title = detailLines.join("\n");

			// 组装分段：仅当存在时才渲染，段间自动加 "·" 分隔符。
			const showTokens = currentSessionId !== void 0 && (inputTokens > 0 || outputTokens > 0);
			const showCost = currentSessionId !== void 0 && convCost !== null && calls > 0;

			const segments = [];
			if (showTokens) {
				segments.push(jsx("span", {
					style: segment,
					key: "tokens",
					children: [
						jsx("span", { style: tokensIn, children: `↑${formatTokens(inputTokens + cacheReadTokens)}` }),
						jsx("span", { style: tokensOut, children: `↓${formatTokens(outputTokens)}` })
					]
				}));
			}
			if (showCost) {
				segments.push(jsx("span", {
					style: segment,
					key: "cost",
					children: [
						jsx("span", { style: balanceLabel, children: "会话" }),
						jsx("span", { style: cost, children: formatCost(convCost, currency) })
					]
				}));
			}
			segments.push(jsx("span", {
				style: segment,
				key: "balance",
				children: [
					jsx("span", { style: balanceLabel, children: "余额" }),
					jsx("span", {
						style: {
							...balance,
							color: phase === "error" ? "var(--dsw-alias-state-error-primary)" : balance.color
						},
						children: phase === "error" ? "—" : formatBalance(totalBalance, currency)
					})
				]
			}));

			const rowChildren = [];
			for (let index = 0; index < segments.length; index++) {
				if (index > 0) rowChildren.push(jsx("span", { style: sep, key: `sep-${index}`, children: "·" }));
				rowChildren.push(segments[index]);
			}

			return jsx("div", {
				role: "status",
				"aria-live": "polite",
				"data-plugin": "dsh-codex-meter",
				title,
				onClick: () => { load(); },
				onMouseEnter: () => { setHover(true); },
				onMouseLeave: () => { setHover(false); },
				style: hover ? { ...pill, ...pillHover } : pill,
				children: jsxs(Fragment, {
					children: [
						jsx("span", {
							"aria-hidden": true,
							style: { ...dot, background: phase === "loading" ? "var(--dsw-alias-label-secondary)" : stateColor }
						}),
						...rowChildren
					]
				})
			});
		}

		// ---- client plugin body -----------------------------------------
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "codex-meter",
				order: 100,
				label: "Codex 用量"
			}, CodexMeter));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
