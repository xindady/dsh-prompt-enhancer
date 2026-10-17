/**
 * dsh-prompt-enhancer — Client half.
 *
 * A ✦ icon button in the composer toolbar's right seat (left of the credit
 * badge). Interaction contract:
 *
 * 1. hover shows an interactive background (theme token, injected stylesheet);
 * 2. click -> busy state: spinning indicator, button disabled, tooltip「优化中」;
 * 3. success -> a 撤回 button appears beside the icon and stays until clicked,
 *    the draft is edited again, or the session changes; clicking restores the
 *    original draft;
 * 4. the icon is an outlined (stroked) sparkle.
 *
 * Write-back strategy (unchanged):
 * - no reference chips  -> single undoable insertText over the whole draft;
 * - with reference chips -> chips are atomic nodes plain text cannot rebuild,
 *   so keep the chips and splice the enhanced text around them.
 *
 * Reference audit runs in the browser too: every original token must survive
 * verbatim, or the result is rejected with a visible toast (the Host audits
 * and retries first).
 */
window.__ModuleLoader__.load({
	id: 'dsh-prompt-enhancer',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		const PLUGIN_ID = 'dsh-prompt-enhancer';
		const STYLE_TAG_ID = `${PLUGIN_ID}/styles`;

		/** Inject the plugin stylesheet once (hover/spinner classes); returns its disposer. */
		function injectStyles() {
			if (typeof document === 'undefined') return () => {};
			if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`)) return () => {};
			const tag = document.createElement('style');
			tag.dataset.plugin = PLUGIN_ID;
			tag.dataset.pluginCss = STYLE_TAG_ID;
			tag.textContent = [
				`.pe-enhance-button,.pe-revert-button{background:transparent;transition:background-color .12s ease}`,
				`.pe-enhance-button:hover:not(:disabled),.pe-revert-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}`,
				`.pe-enhance-button:active:not(:disabled),.pe-revert-button:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover))}`,
				`.pe-spin{animation:pe-spin .8s linear infinite}`,
				`@keyframes pe-spin{to{transform:rotate(360deg)}}`
			].join('\n');
			document.head.appendChild(tag);
			return () => tag.remove();
		}

		/** Every @-reference token (@path, @folder/, @"quoted path"). */
		function extractReferences(text) {
			const tokens = [];
			for (const match of text.matchAll(/@"[^"\n]+"|@[^\s@,，。;;!！?？、）)]+/gu)) tokens.push(match[0]);
			return tokens;
		}

		/** Result cleaning: trim + strip one wrapping quote pair. */
		function cleanResult(text) {
			return text.trim().replace(/^["'"“”‘’]|["'"“”‘’]$/g, '').trim();
		}

		/**
		 * Replace the whole draft with `next`.
		 * Strategy A (no chips): single insertText over the whole draft span.
		 * Strategy B (chips): keep the chip nodes, splice plain text into the
		 * gaps around them. Each splice re-captures the live draft revision and
		 * tracks the cumulative offset shift of earlier inserts (left-to-right),
		 * so no edit trips the revision guard of the next one.
		 * Returns 'undoable' | 'programmatic' | false.
		 */
		function writeDraft(inputActions, state, next) {
			if (state.draftRev !== inputActions.captureInsertion().draftRev) return false;
			const hasChips = state.occurrences.length > 0;
			if (!hasChips) {
				// clipboard == detect without chips, so the span bounds are exact
				const whole = { start: 0, end: state.draft.length, draftRev: state.draftRev };
				return inputActions.insertText(next, whole) ? 'undoable' : false;
			}
			// chips in document order carry their verbatim mention text
			const tokens = [];
			for (const occ of state.occurrences) {
				const token = typeof occ.clipboardText === 'string' && occ.clipboardText !== '' ? occ.clipboardText : occ.ref;
				if (typeof token !== 'string' || token === '') return false;
				tokens.push(token);
			}
			// locate each token in the enhanced text, in chip order
			const located = [];
			let searchFrom = 0;
			for (const token of tokens) {
				const at = next.indexOf(token, searchFrom);
				if (at < 0) return false;
				located.push({ start: at, end: at + token.length });
				searchFrom = at + token.length;
			}
			located.sort((a, b) => a.start - b.start);
			for (let i = 1; i < located.length; i += 1) {
				if (located[i].start < located[i - 1].end) return false;
			}
			// left-to-right splices anchored at chip boundaries (a zero-width span
			// at a chip's detect start inserts before the chip)
			const n = state.occurrences.length;
			const tailStart = located[n - 1].end;
			const plan = [];
			for (let i = 0; i < n; i += 1) {
				const gapFrom = i === 0 ? 0 : located[i - 1].end;
				if (located[i].start > gapFrom) plan.push({ at: state.occurrences[i].offset, text: next.slice(gapFrom, located[i].start) });
			}
			if (tailStart < next.length) plan.push({ at: state.occurrences[n - 1].offset + 1, text: next.slice(tailStart) });
			let delta = 0;
			for (const edit of plan) {
				const fresh = inputActions.captureInsertion();
				const span = { start: edit.at + delta, end: edit.at + delta, draftRev: fresh.draftRev };
				if (!inputActions.insertText(edit.text, span)) return false;
				delta += edit.text.length;
			}
			return 'programmatic';
		}

		/**
		 * Sparkle icon supplied by the user (three-star glyph, 1131x1024 source).
		 * Filled with currentColor so it inherits the theme like its neighbours.
		 */
		const SPARK_PATH = 'M556.651163 4.167442C524.502326 11.906977 513.190698 33.339535 461.395349 190.511628c-53.581395 162.530233-48.818605 157.172093-202.418605 208.372093C80.967442 458.418605 65.488372 467.348837 65.488372 512c0.595349 40.483721 13.097674 47.627907 164.316279 100.018605 66.083721 23.218605 128 45.84186 137.525582 50.604651 38.102326 19.646512 51.2 44.055814 96.446511 176.818604 49.413953 144.074419 54.772093 156.576744 73.227907 169.07907 19.051163 13.097674 55.962791 11.906977 69.655814-1.786046 18.455814-18.455814 26.195349-36.911628 66.083721-158.362791 41.07907-125.023256 51.2-148.24186 73.227907-168.483721 9.525581-8.930233 65.488372-31.553488 150.027907-61.32093 169.674419-58.344186 180.986047-65.488372 181.581395-108.353489 0-39.888372-17.265116-50.604651-154.790697-96.446511-145.860465-48.223256-174.437209-61.916279-193.488372-94.660465-7.739535-13.693023-32.744186-77.990698-55.367442-143.47907-22.623256-65.488372-44.651163-126.213953-47.627907-135.144186-10.12093-25.004651-43.460465-42.269767-69.655814-36.316279z m52.390697 231.590698c38.102326 110.734884 44.651163 125.618605 73.823256 157.767441 27.981395 30.95814 55.962791 44.651163 170.269768 82.15814 51.2 17.265116 93.469767 33.339535 93.469767 35.125581 0 2.381395-39.293023 17.265116-86.92093 33.339535-110.139535 36.911628-149.432558 55.962791-177.413954 84.539535-29.767442 30.362791-36.911628 45.84186-77.990697 164.911628-19.051163 54.772093-35.125581 98.827907-35.72093 98.232558-1.190698-1.190698-16.669767-45.246512-34.530233-98.232558-39.293023-114.306977-50.604651-137.525581-81.562791-168.483721-30.362791-30.362791-42.865116-36.316279-153.6-75.013953-51.795349-17.860465-97.637209-33.934884-102.4-35.720931-4.762791-1.786047 35.125581-19.051163 89.302326-37.506976 128.595349-44.651163 137.525581-48.818605 166.102325-77.395349 30.95814-30.95814 45.246512-60.725581 83.944186-175.032558 17.860465-51.2 33.934884-91.683721 36.31628-89.302326 2.381395 2.976744 19.051163 48.223256 36.911627 100.613954zM986.493023 60.130233c-4.167442 11.311628-11.311628 30.362791-15.47907 42.269767-8.930233 27.386047-21.432558 36.316279-70.846511 52.986047-20.837209 7.144186-35.72093 14.883721-32.744186 17.265116 2.381395 2.381395 19.051163 8.930233 36.316279 14.883721 45.246512 14.288372 62.511628 31.553488 75.609302 74.418604 5.953488 19.646512 13.097674 37.506977 15.47907 39.293024 2.381395 1.190698 8.930233-11.906977 14.883721-28.576745 18.455814-57.748837 22.027907-61.916279 70.846512-80.372093 24.409302-8.930233 44.651163-18.455814 44.651162-20.24186 0-2.381395-17.265116-10.12093-38.102325-17.265116-44.651163-14.883721-58.344186-27.981395-72.03721-71.441861-13.693023-43.460465-18.455814-47.032558-28.576744-23.218604zM123.237209 697.153488c-4.167442 11.311628-11.311628 30.362791-15.479069 42.269768-8.930233 27.386047-21.432558 36.316279-70.846512 52.986046-20.837209 7.144186-35.72093 14.883721-32.744186 17.265117 2.381395 2.381395 19.051163 8.930233 36.316279 14.883721 45.246512 14.288372 62.511628 31.553488 75.609302 74.418604 5.953488 19.646512 13.097674 37.506977 15.47907 39.293023 2.381395 1.190698 8.930233-11.906977 14.883721-28.576744 18.455814-57.748837 22.027907-61.916279 70.846512-80.372093 24.409302-8.930233 44.651163-18.455814 44.651162-20.24186 0-2.381395-17.265116-10.12093-38.102325-17.265117-44.651163-14.883721-58.344186-27.981395-72.03721-71.44186-13.693023-43.460465-18.455814-47.032558-28.576744-23.218605z';

		/** Filled sparkle glyph in the composer toolbar (14px, currentColor). */
		function SparkIcon() {
			return h('svg', {
				viewBox: '0 0 1131 1024', width: 14, height: 14, 'aria-hidden': true,
				fill: 'currentColor'
			}, h('path', { d: SPARK_PATH }));
		}

		/** Outlined counter-clockwise arrow for the 撤回 state. */
		function RevertIcon({ size = 13 }) {
			return h('svg', {
				viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true,
				fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round'
			}, h('path', { d: 'M3.2 7.2a5 5 0 1 1 1.1 4.6' }), h('path', { d: 'M3 3.6v3.6h3.6' }));
		}

		/** Spinner ring shown while the enhance call is in flight. */
		function SpinIcon() {			return h('span', {
				className: 'pe-spin',
				'aria-hidden': true,
				style: {
					display: 'inline-block', width: 12, height: 12, boxSizing: 'border-box',
					borderRadius: '50%', border: '1.5px solid transparent',
					borderTopColor: 'currentColor', borderRightColor: 'currentColor',
					opacity: .9
				}
			});
		}

		function EnhanceButton({ inputActions, useInput, sessionId }) {
			const input = useInput((s) => s);
			const [busy, setBusy] = React.useState(false);
			const [toast, setToast] = React.useState(null); // { level, text }
			/** Original draft behind the current 撤回 offer (null = no offer). */
			const [revertible, setRevertible] = React.useState(null);
			/** The draft text we last wrote, so a later user edit drops the offer. */
			const lastWritten = React.useRef(null);
			const toastTimer = React.useRef(null);

			// session switched: drop every transient state from the previous draft
			React.useEffect(() => {
				lastWritten.current = null;
				setRevertible(null);
				setToast(null);
				setBusy(false);
			}, [sessionId]);
			React.useEffect(() => () => clearTimeout(toastTimer.current), []);

			// a user edit after a successful write invalidates the revert offer
			React.useEffect(() => {
				if (revertible === null || lastWritten.current === null) return;
				if (input !== undefined && input.draft !== lastWritten.current) {
					lastWritten.current = null;
					setRevertible(null);
				}
			}, [input?.draft, revertible]);

			if (input === undefined || inputActions === undefined || sessionId === undefined) return null;
			const draft = input.draft;
			const empty = draft.trim() === '';

			const showToast = (value) => {
				clearTimeout(toastTimer.current);
				setToast(value);
				toastTimer.current = setTimeout(() => setToast(null), 6000);
			};

			const run = async () => {
				if (busy || empty || input.phase !== 'plain') return;
				setBusy(true);
				setToast(null);
				setRevertible(null);
				lastWritten.current = null;
				const snapshot = { draft, draftRev: input.draftRev, occurrences: input.occurrences };
				try {
					const route = typeof window !== 'undefined' && window.DSH_WEB_URL
						? new URL('plugins/prompt-enhancer/enhance', window.DSH_WEB_URL)
						: '/plugins/prompt-enhancer/enhance';
					const response = await fetch(route, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ text: draft, sessionId })
					});
					const data = await response.json();
					if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
					if (!data.ok) throw new Error(data.error ?? 'enhance failed');
					const next = cleanResult(data.text);
					if (next === '') throw new Error('增强结果为空');
					// browser-side reference audit (mirrors the Host's)
					for (const token of extractReferences(draft)) {
						if (!next.includes(token)) {
							showToast({ level: 'error', text: '引用校验失败：优化结果丢失或改动了 @引用（原文未动）' });
							return;
						}
					}
					const outcome = writeDraft(inputActions, snapshot, next);
					if (outcome === false) {
						showToast({ level: 'error', text: '写回失败：草稿刚被修改过或正被占用，请重试' });
						return;
					}
					// offer 撤回 regardless of strategy; it restores this exact original
					lastWritten.current = next;
					setRevertible(snapshot.draft);
				} catch (error) {
					showToast({ level: 'error', text: `增强失败：${error instanceof Error ? error.message : String(error)}` });
				} finally {
					setBusy(false);
				}
			};

			const revert = () => {
				if (revertible === null || busy) return;
				inputActions.setDraft(revertible);
				lastWritten.current = null;
				setRevertible(null);
			};

			// One seat, three explicit states:
			//   idle      ✦ 增强提示词   -> click runs the enhance call
			//   busy      spinner        -> disabled, no repeat clicks
			//   revertable ↺ 撤回        -> click restores the pre-enhance draft
			const locked = empty || input.phase !== 'plain';
			const state = busy ? 'busy' : revertible !== null ? 'revert' : 'idle';
			const disabled = state === 'busy' || (state === 'idle' && locked);
			// No draft, no seat: the icon appears only once there is something to enhance.
			if (empty && state === 'idle') return null;
			return h('div', { style: { display: 'flex', alignItems: 'center', minHeight: 0, position: 'relative' } },
				h('button', {
					type: 'button',
					className: state === 'revert' ? 'pe-revert-button' : 'pe-enhance-button',
					onClick: state === 'revert' ? revert : run,
					disabled,
					'aria-label': state === 'busy' ? '正在优化提示词' : state === 'revert' ? '撤回优化，恢复原提示词' : '增强提示词',
					title: state === 'busy' ? '正在优化提示词…' : state === 'revert' ? '撤回' : '增强提示词',
					onMouseDown: (event) => event.preventDefault(), // keep composer focus
					style: {
						display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
						minWidth: 26, height: 26, padding: state === 'revert' ? '0 8px' : 0,
						border: 'none', borderRadius: 6,
						color: disabled ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-secondary)',
						font: 'inherit', fontSize: 12, lineHeight: '20px',
						cursor: disabled ? 'default' : 'pointer'
					}
				},
					state === 'busy' ? h(SpinIcon)
					: state === 'revert' ? h(RevertIcon, { size: 13 })
					: h(SparkIcon),
					state === 'revert' ? '撤回' : null)
			);
		}

		return {
			inject: ['slots'],
			apply(ctx) {
				ctx.effect(() => injectStyles(), 'prompt-enhancer: stylesheet');
				ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
					name: 'conversation.input.right',
					id: 'prompt-enhancer-button',
					order: 0
				}, EnhanceButton));
			}
		};
	}
});
