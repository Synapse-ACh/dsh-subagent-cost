/**
 * subagent-cost — browser half.
 *
 * Hand-written `__ModuleLoader__` bundle (no build step), modelled on the
 * already-installed @kidli1412/dsh-session-cost client half: it registers one
 * entry into the conversation `composer.dock` list slot (the status row at the
 * bottom of the conversation) and fetches its numbers from the host half's
 * loopback-only endpoint.
 *
 *   🧑‍🤝‍🧑 3 个子智能体 · ¥0.42        ← the pill
 *   ┌────────────────────────────────┐
 *   │ 子智能体用量               ¥0.42│  ← click opens the panel
 *   │ 第 1 轮 · 15:20 · 25 个   ¥0.97 │
 *   │   [study-worker] Part 1/9 …  63.3k  ¥0.2102 │
 *   │ …                              │
 *   └────────────────────────────────┘
 *
 * Refresh policy: refetch whenever the client `tokenUsage` projection moves
 * (debounced 600 ms), every 30 s while mounted, and when the tab becomes
 * visible again. The host half keeps an incremental per-child fold, so a poll
 * only pays for events appended since the previous one.
 */
window.__ModuleLoader__.load({
	id: '@local/subagent-cost',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		let react = require('react');
		const h = react.createElement;

		//#region dictionaries
		const zh = {
			'pill.unit': '个子智能体',
			'pill.loading': '子智能体 …',
			'pill.error': '子智能体 ?',
			'panel.title': '子智能体用量',
			'panel.empty': '本会话还没有派发过子智能体。',
			'panel.turn': '第 {turn} 轮',
			'panel.untracked': '未归属轮次',
			'panel.count': '{count} 个',
			'panel.total': '合计',
			'panel.tokens': 'tokens',
			'panel.running': '运行中',
			'panel.done': '已结束',
			'panel.estimated': '按 DeepSeek V4.1 峰谷价估算（CNY / 1M tokens）',
			'panel.updated': '更新于 {time}',
			'panel.refresh': '刷新',
			'panel.loading': '读取中…',
			'panel.warn': '注意：{warn}',
		};
		const en = {
			'pill.unit': 'subagents',
			'pill.loading': 'subagents …',
			'pill.error': 'subagents ?',
			'panel.title': 'Subagent usage',
			'panel.empty': 'This conversation has not spawned any subagent yet.',
			'panel.turn': 'Turn {turn}',
			'panel.untracked': 'No turn attribution',
			'panel.count': '{count}',
			'panel.total': 'total',
			'panel.tokens': 'tokens',
			'panel.running': 'running',
			'panel.done': 'done',
			'panel.estimated': 'Estimated at DeepSeek V4.1 peak/off-peak rates (CNY / 1M tokens)',
			'panel.updated': 'updated {time}',
			'panel.refresh': 'Refresh',
			'panel.loading': 'loading…',
			'panel.warn': 'Note: {warn}',
		};
		//#endregion

		//#region css
		const CSS = [
			'.sac_root{display:inline-flex;align-items:center;min-width:0}',
			'.sac_pill{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:1px 8px;margin:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-text-2,inherit);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}',
			'.sac_pill:hover{background:var(--dsw-alias-fill-2,rgba(127,127,127,.14))}',
			'.sac_pill[aria-expanded="true"]{background:var(--dsw-alias-fill-2,rgba(127,127,127,.18))}',
			'.sac_pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4b7bff);outline-offset:1px}',
			'.sac_dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#2f9e6a)}',
			'.sac_dot[data-state="running"]{background:var(--dsw-alias-brand-primary,#4b7bff)}',
			'.sac_dot[data-state="error"]{background:var(--dsw-alias-state-danger-primary,#c94b4b)}',
			'.sac_dot[data-state="idle"]{background:var(--dsw-alias-text-3,rgba(127,127,127,.6))}',
			'.sac_text{overflow:hidden;text-overflow:ellipsis}',
			'.sac_panel{position:fixed;z-index:80;box-sizing:border-box;width:min(480px,calc(100vw - 24px));max-height:min(460px,66vh);overflow:auto;padding:10px 12px 8px;border-radius:var(--dsw-radius-lg,10px);border:1px solid var(--dsw-alias-border-1,rgba(127,127,127,.28));background:var(--dsw-specific-menu,#fff);color:var(--dsw-alias-text-1,inherit);box-shadow:0 10px 30px rgba(0,0,0,.18);font-size:12px;line-height:18px}',
			'.sac_head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-weight:600}',
			'.sac_head_cost{font-variant-numeric:tabular-nums;font-weight:600}',
			'.sac_sub{margin-top:2px;color:var(--dsw-alias-text-3,inherit);font-size:11px;display:flex;justify-content:space-between;gap:10px}',
			'.sac_group{margin-top:8px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-1,rgba(127,127,127,.18))}',
			'.sac_grouphead{display:flex;justify-content:space-between;gap:10px;color:var(--dsw-alias-text-2,inherit);font-size:11px;margin-bottom:2px}',
			'.sac_row{display:flex;align-items:baseline;gap:8px;padding:2px 4px;border-radius:5px}',
			'.sac_row:hover{background:var(--dsw-alias-fill-2,rgba(127,127,127,.12))}',
			'.sac_chip{flex:none;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 4px;border-radius:4px;font-size:10px;line-height:15px;background:var(--dsw-alias-fill-3,rgba(127,127,127,.18));color:var(--dsw-alias-text-2,inherit)}',
			'.sac_label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.sac_num{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-text-3,inherit);white-space:nowrap}',
			'.sac_foot{margin-top:8px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-1,rgba(127,127,127,.18));color:var(--dsw-alias-text-3,inherit);font-size:10px;line-height:15px;display:flex;justify-content:space-between;gap:10px}',
			'.sac_warn{margin-top:6px;color:var(--dsw-alias-state-warning-primary,#a86b00);font-size:10px}',
			'.sac_err{color:var(--dsw-alias-state-danger-primary,#c94b4b)}',
			'.sac_muted{color:var(--dsw-alias-text-3,inherit)}',
		].join('\n');

		function ensureStyles() {
			const id = 'subagent-cost-style';
			if (document.getElementById(id) !== null) return;
			const el = document.createElement('style');
			el.id = id;
			el.textContent = CSS;
			document.head.appendChild(el);
		}
		//#endregion

		//#region helpers
		/** Monotonic request guard: only the newest load may write state. */
		function createLoader() {
			let seq = 0;
			return {
				start() {
					seq += 1;
					return seq;
				},
				isCurrent(token) {
					return token === seq;
				},
			};
		}

		/** Fetch a same-origin JSON endpoint, rejecting `{ok:false}` payloads. */
		async function fetchJson(url) {
			const response = await fetch(url, { headers: { accept: 'application/json' } });
			const text = await response.text();
			let payload = null;
			try {
				payload = text === '' ? null : JSON.parse(text);
			} catch {
				payload = null;
			}
			if (!response.ok) {
				const detail = payload !== null && typeof payload.message === 'string' ? payload.message : '';
				throw new Error(detail !== '' ? detail : `HTTP ${response.status}`);
			}
			if (payload === null || payload.ok !== true) {
				throw new Error(payload !== null && typeof payload.error === 'string' ? payload.error : 'unexpected response');
			}
			return payload;
		}

		/** `¥0.42` — two decimals, enough for a status pill. */
		function fmtYuan(value) {
			const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
			if (n > 0 && n < 0.01) return '¥' + n.toFixed(4);
			return '¥' + n.toFixed(2);
		}

		/** `¥0.4213` — four decimals, for a single row. */
		function fmtYuanExact(value) {
			const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
			return '¥' + n.toFixed(4);
		}

		/** `546.0k` / `1.23M` / `912` */
		function fmtTokens(value) {
			const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
			if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
			if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
			return String(Math.round(n));
		}

		/** `15:20:05` in the browser's local zone. */
		function fmtClock(ms) {
			if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
			const d = new Date(ms);
			const pad = (v) => String(v).padStart(2, '0');
			return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
		}

		function fmtTurnClock(ms) {
			if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
			const d = new Date(ms);
			const pad = (v) => String(v).padStart(2, '0');
			return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
		}

		/** Fill `{name}` placeholders. */
		function interpolate(template, vars) {
			return template.replace(/\{(\w+)\}/g, (whole, key) => (vars !== null && vars !== undefined && key in vars ? String(vars[key]) : whole));
		}

		/**
		 * Best-effort active UI language, for the inline dictionary fallback.
		 *
		 * @returns `'zh'` or `'en'`.
		 */
		function activeLanguage() {
			const lang = typeof document !== 'undefined' && document.documentElement !== null && document.documentElement.lang !== ''
				? document.documentElement.lang
				: typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language : 'zh';
			return String(lang).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
		}
		//#endregion

		//#region component
		/**
		 * The composer-dock entry.
		 *
		 * @param props - slot runtime props: `useSession`, `useProjection`, and
		 *   `t` bound by the slot's locale seat (may be undefined; falls back to
		 *   the inline dictionary).
		 */
		function SubagentCostDock({ useSession, useProjection, t }) {
			// The seat translator leaves a key untouched when our namespace is not
			// registered (e.g. an earlier client-body failure). Never show a raw key.
			const dict = (key, vars) => {
				if (t !== undefined && t !== null) {
					const resolved = t(key, vars);
					if (typeof resolved === 'string' && resolved !== key) return resolved;
				}
				const table = activeLanguage() === 'zh' ? zh : en;
				const text = table[key] !== undefined ? table[key] : zh[key] !== undefined ? zh[key] : key;
				return interpolate(text, vars);
			};
			ensureStyles();
			const sessionId = useSession((snapshot) => snapshot.sessionId);
			const tokenUsage = useProjection('tokenUsage');

			const [summary, setSummary] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [open, setOpen] = react.useState(false);
			const [anchor, setAnchor] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const loaderRef = react.useRef(null);
			const debounceRef = react.useRef(null);
			const rootRef = react.useRef(null);
			if (loaderRef.current === null) loaderRef.current = createLoader();

			const load = react.useCallback(async () => {
				if (sessionId === undefined || sessionId === null || sessionId === '') return false;
				const seq = loaderRef.current.start();
				try {
					const payload = await fetchJson(`/api/subagent-cost/summary?session=${encodeURIComponent(sessionId)}`);
					if (loaderRef.current.isCurrent(seq)) {
						setSummary(payload);
						setError(null);
					}
					return true;
				} catch (err) {
					if (loaderRef.current.isCurrent(seq)) setError(err instanceof Error ? err.message : String(err));
					return false;
				}
			}, [sessionId]);

			const refresh = react.useCallback(async () => {
				setBusy(true);
				try {
					await load();
				} finally {
					setBusy(false);
				}
			}, [load]);

			// Initial load + 30 s poll + refetch when the tab becomes visible.
			react.useEffect(() => {
				load();
				const timer = window.setInterval(load, 30 * 1000);
				const onVisible = () => {
					if (document.visibilityState === 'visible') load();
				};
				document.addEventListener('visibilitychange', onVisible);
				return () => {
					window.clearInterval(timer);
					document.removeEventListener('visibilitychange', onVisible);
				};
			}, [load]);

			// Refetch shortly after the client-side token projection moves.
			react.useEffect(() => {
				if (tokenUsage === undefined || tokenUsage === null) return;
				if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
				debounceRef.current = window.setTimeout(() => {
					debounceRef.current = null;
					load();
				}, 600);
				return () => {
					if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
					debounceRef.current = null;
				};
			}, [tokenUsage, load]);

			// Anchor the fixed-position panel to the pill, above it.
			const place = react.useCallback(() => {
				const el = rootRef.current;
				if (el === null) return;
				const rect = el.getBoundingClientRect();
				const width = Math.min(480, window.innerWidth - 24);
				const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
				const bottom = Math.max(12, window.innerHeight - rect.top + 8);
				setAnchor({ left, bottom });
			}, []);

			react.useEffect(() => {
				if (!open) return undefined;
				place();
				const onPointerDown = (event) => {
					const el = rootRef.current;
					if (el !== null && event.target instanceof Node && !el.contains(event.target)) setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === 'Escape') setOpen(false);
				};
				const onResize = () => place();
				document.addEventListener('pointerdown', onPointerDown);
				document.addEventListener('keydown', onKeyDown);
				window.addEventListener('resize', onResize);
				window.addEventListener('scroll', onResize, true);
				return () => {
					document.removeEventListener('pointerdown', onPointerDown);
					document.removeEventListener('keydown', onKeyDown);
					window.removeEventListener('resize', onResize);
					window.removeEventListener('scroll', onResize, true);
				};
			}, [open, place]);

			const totals = summary !== null && typeof summary.totals === 'object' && summary.totals !== null ? summary.totals : null;
			const rows = summary !== null && Array.isArray(summary.children) ? summary.children : [];
			const groups = summary !== null && Array.isArray(summary.turns) ? summary.turns : [];
			const childCount = totals !== null && typeof totals.children === 'number' ? totals.children : 0;
			const totalTokens = totals !== null && totals.tokens !== null && typeof totals.tokens === 'object' ? Number(totals.tokens.total ?? 0) : 0;
			const totalCost = totals !== null && typeof totals.cost === 'number' ? totals.cost : 0;
			const running = rows.filter((row) => row.status === 'running').length;

			const dotState = error !== null && summary === null ? 'error' : running > 0 ? 'running' : childCount === 0 ? 'idle' : 'done';
			const pillText = summary === null ? (error !== null ? dict('pill.error') : dict('pill.loading')) : `${childCount} ${dict('pill.unit')} · ${fmtYuan(totalCost)}`;
			const pillTitle = summary === null ? (error !== null ? error : dict('panel.loading')) : `${childCount} ${dict('pill.unit')} · ${fmtTokens(totalTokens)} ${dict('panel.tokens')} · ${fmtYuanExact(totalCost)}${running > 0 ? ` · ${running} ${dict('panel.running')}` : ''}`;

			const rowNode = (row) => {
				const state = row.status === 'running' ? dict('panel.running') : row.status === 'done' ? dict('panel.done') : '?';
				return h(
					'div',
					{ className: 'sac_row', key: row.id ?? `${row.label}:${row.startedAt}` },
					h('span', { className: 'sac_chip', title: row.mode ?? '' }, row.preset ?? row.mode ?? '?'),
					h('span', { className: 'sac_label', title: `${row.label ?? ''}\n${state}` }, row.label !== undefined && row.label !== '' ? row.label : (row.id ?? '')),
					h('span', { className: 'sac_num' }, `${fmtTokens(row.tokens?.total ?? 0)} ${dict('panel.tokens')}`),
					h('span', { className: 'sac_num' }, fmtYuanExact(row.cost ?? 0))
				);
			};

			const groupNode = (group) => {
				const groupRows = rows.filter((row) => (row.turnIndex ?? -1) === group.index);
				if (groupRows.length === 0) return null;
				const label = group.turn === null || group.turn === undefined ? dict('panel.untracked') : interpolate(dict('panel.turn'), { turn: group.turn });
				const clock = fmtTurnClock(group.startedAt);
				return h(
					'div',
					{ className: 'sac_group', key: `g${group.index}` },
					h(
						'div',
						{ className: 'sac_grouphead' },
						h('span', null, `${label}${clock !== '' ? ` · ${clock}` : ''} · ${interpolate(dict('panel.count'), { count: groupRows.length })}`),
						h('span', null, `${fmtTokens(group.tokens?.total ?? 0)} ${dict('panel.tokens')} · ${fmtYuanExact(group.cost ?? 0)}`)
					),
					groupRows.map(rowNode)
				);
			};

			const panel = open
				? h(
						'div',
						{
							className: 'sac_panel',
							role: 'dialog',
							'aria-label': dict('panel.title'),
							style: anchor !== null ? { left: `${anchor.left}px`, bottom: `${anchor.bottom}px` } : { visibility: 'hidden' },
						},
						h(
							'div',
							{ className: 'sac_head' },
							h('span', null, dict('panel.title')),
							h('span', { className: 'sac_head_cost' }, fmtYuanExact(totalCost))
						),
						h(
							'div',
							{ className: 'sac_sub' },
							h('span', null, `${childCount} ${dict('pill.unit')} · ${fmtTokens(totalTokens)} ${dict('panel.tokens')}${running > 0 ? ` · ${running} ${dict('panel.running')}` : ''}`),
							h(
								'button',
								{
									type: 'button',
									className: 'sac_pill',
									disabled: busy,
									onClick: () => {
										refresh();
									},
								},
								busy ? dict('panel.loading') : dict('panel.refresh')
							)
						),
						error !== null ? h('div', { className: 'sac_err' }, error) : null,
						summary === null
							? h('div', { className: 'sac_muted' }, dict('panel.loading'))
							: childCount === 0
								? h('div', { className: 'sac_muted' }, dict('panel.empty'))
								: groups.map(groupNode),
						summary !== null && Array.isArray(summary.warnings) && summary.warnings.length > 0
							? h('div', { className: 'sac_warn' }, interpolate(dict('panel.warn'), { warn: summary.warnings.join('; ') }))
							: null,
						h(
							'div',
							{ className: 'sac_foot' },
							h('span', null, dict('panel.estimated')),
							h('span', null, summary !== null ? interpolate(dict('panel.updated'), { time: fmtClock(summary.updatedAt) }) : '')
						)
				  )
				: null;

			return h(
				'div',
				{ className: 'sac_root', ref: rootRef },
				h(
					'button',
					{
						type: 'button',
						className: 'sac_pill',
						'aria-expanded': open ? 'true' : 'false',
						title: pillTitle,
						onClick: () => setOpen((value) => !value),
					},
					h('span', { className: 'sac_dot', 'data-state': dotState }),
					h('span', { className: 'sac_text' }, pillText)
				),
				panel
			);
		}
		//#endregion

		//#region plugin body
		/**
		 * Services required by the client plugin body.
		 *
		 * `locale` is a HARD dependency: the dock's `t` seat is bound to our
		 * namespace, so the dictionaries must be registered before (or with) the
		 * entry. Reading `locale` through `ctx.get()` let a load-order change
		 * skip registration and the pill rendered raw keys.
		 */
		const inject = ['slots', 'locale'];

		/**
		 * Client plugin body: publish the dictionaries and register the composer-dock
		 * entry. Both services arrive as hard dependencies, so the registration and
		 * the entry's `t` seat always share one namespace.
		 *
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register('subagent-cost', { zh, en }), 'subagent-cost: dictionaries');
			ctx.slots.inject('conversation.composer.dock', () =>
				ctx.slots.register(
					{
						name: 'conversation.composer.dock',
						id: 'subagent-cost',
						order: 101,
						locale: 'subagent-cost',
					},
					SubagentCostDock
				)
			);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.SubagentCostDock = SubagentCostDock;
		exports.fmtYuan = fmtYuan;
		exports.fmtTokens = fmtTokens;
		return module.exports;
	},
});
