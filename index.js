/**
 * dsh-prompt-enhancer — Host half.
 *
 * One POST route on the Host web server: enhance a draft with a system + user
 * double template through the Harness LLM service. The Client half owns
 * all draft reading/writing; this half never touches sessions.
 *
 * Route contract (browser JSON):
 *   POST /plugins/prompt-enhancer/enhance
 *   { "text": string, "sessionId"?: string }
 *   -> 200 { ok: true,  text: string, model: string, elapsedMs: number }
 *   -> 200 { ok: false, error: string, code: string }
 *   -> 4xx { error: string }                       (transport-level)
 */
import { createHash, randomUUID } from 'node:crypto';

/** Route path — same-origin, browser calls it with POST. */
const ROUTE_PATH = '/plugins/prompt-enhancer/enhance';
/** Max accepted draft bytes (drafts are short; refuse absurd bodies early). */
const MAX_INPUT_BYTES = 64 * 1024;
/** Auxiliary-call timeout; prompt enhancement is a short one-shot. */
const TIMEOUT_MS = 60_000;
/** Billing/observability purpose tag on the LLM call. */
const PURPOSE = 'prompt-enhancer';

// ---------------------------------------------------------------------------
// Enhancement templates. SYSTEM_PROMPT = system message (role, analysis
// process, hard constraints); USER_TEMPLATE = user message ({input} carries
// the user's draft). Two scene phrases were adapted to this Harness agent:
// "a development code assistant" / "specializes in writing code".
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a Prompt Engineering Expert specializing in improving user prompts for a computer-use coding agent. When given a prompt, analyze and enhance it to create a more effective version while maintaining its core purpose. The requests are being made to an AI assistant that specializes in executing coding and workspace tasks.

	TASK: When given a prompt, analyze and enhance it to create a more effective version while maintaining its core purpose. The requests are being made to an AI assistant that specializes in executing coding and workspace tasks.

	ANALYSIS PROCESS:

	Evaluate the original prompt:
	Identify the main objective
	Note any ambiguities or gaps
	Assess the clarity of instructions
	Check for missing context
	Apply these prompt engineering principles:
	Write clear, specific instructions
	Include necessary context
	Set explicit parameters and constraints
	Structure the output format
	Add relevant examples
	Match tone and complexity to the use case
	Remove redundant information
	Create the enhanced version:
	Maintain the original goal
	Incorporate identified improvements
	Ensure clarity and completeness
	Be realistic in the features to add
	Do NOT request guides/how-tos unless the user asks
	Do NOT ask for code snippets
	Do NOT suggest specific technologies unless mentioned in the user's prompt
	Do NOT explain HOW to do things, focus on WHAT
	Do NOT answer questions - expand/rewrite them to be more detailed
	REFERENCE PRESERVATION (highest priority, added for this harness):
	1. The user's input may contain @-reference tokens such as @file.txt, @folder/ or @"path with spaces". These are live file references of the target assistant.
	2. You MUST copy every such token verbatim into the enhanced prompt: same @ prefix, same path characters, same opening/closing double quotes when present. Never translate, reword, complete, abbreviate or drop any reference token, and never add reference tokens that are not in the input.
	3. The enhanced prompt must keep working when every reference token is replaced by its literal path, so keep each token's surrounding wording natural.
	IMPORTANT CONSTRAINTS:
	1. Language matching is the highest priority - You MUST strictly respond in the exact same language as the user's input. If the user writes in Chinese, respond in Chinese; if the user writes in English, respond in English; if the user uses another language, respond in that same language. Do not mix languages unless the user's input itself mixes languages.
	2. Keep the enhanced prompt concise - maximum length should be around 800 characters
	FORMAT: Provide only the enhanced prompt with no additional commentary.`;

const USER_TEMPLATE = `You are a prompt enhancement assistant. Improve the user prompt while preserving its intent and language.

USER INPUT:
{input}

TASK:
Rewrite the user input into a clearer, more specific prompt for the target AI assistant.

CRITICAL PRIORITY - LANGUAGE CONSISTENCY:
1. You MUST detect the language of the user input above and write the enhanced prompt in that same language.
2. If the user writes in Chinese, the enhanced prompt MUST be entirely in Chinese.
3. If the user writes in English, the enhanced prompt MUST be entirely in English.
4. If the user writes in any other language, the enhanced prompt MUST use that exact same language.
5. If the user mixes languages, keep a natural matching mix. Do not translate the user's intent into a single language.
6. These language rules are behavior instructions only; never include language analysis or language labels in the output.

REFERENCE PRESERVATION:
1. Every @-reference token in the user input above (@path, @folder/, @"quoted path") MUST appear in the enhanced prompt verbatim, byte for byte.
2. Never translate, rename, shorten or explain a reference token, and never invent new ones.

ENHANCEMENT REQUIREMENTS:
1. Return only the enhanced prompt text; do not add explanations, prefaces, markdown fences, labels, or analysis.
2. Do not include language labels or meta notes such as "User input is in Chinese" or "Response must be in Chinese".
3. Preserve the user's original intent, topic, constraints, and target output type. Do not answer the request.
4. Always make a substantive enhancement when possible: clarify the task, scope, constraints, and expected output.
5. If the original prompt is already clear, lightly polish it instead of returning it unchanged.
6. Keep the enhanced prompt complete and concise. Do not end with an unfinished list, dangling conjunction, or trailing colon.
7. Do not add unrelated requirements, unsupported facts, or unnecessary sections.`;

/**
 * Result cleaning: trim, then strip one pair of wrapping quotes, straight or
 * curly. Applied before the reference audit.
 */
function cleanResult(text) {
	return text.trim().replace(/^["'"“”‘’]|["'"“”‘’]$/g, '').trim();
}

/** Every @-reference token in the original draft (@path, @folder/, @"quoted"). */
function extractReferences(text) {
	const tokens = [];
	for (const match of text.matchAll(/@"[^"\n]+"|@[^\s@,，。;;!！?？、）)]+/gu)) tokens.push(match[0]);
	return tokens;
}

/** True when every original reference survives verbatim in the output. */
function referencesSurvive(original, enhanced) {
	return extractReferences(original).every((token) => enhanced.includes(token));
}

/**
 * Resolve the model route, in priority order:
 * 1. plugin config override (patch config: provider/model),
 * 2. the session's current model (the Client posts its model-seat selection),
 * 3. the deployment default (agentDefaultModel service, same source the
 *    composer's model seat shows as fallback), else fail with no_route.
 */
function resolveRoute(config, body, deps) {
	if (config.provider && config.model) return { provider: config.provider, model: config.model };
	const route = body.sessionRoute;
	if (route && typeof route.provider === 'string' && typeof route.model === 'string') {
		return { provider: route.provider, model: route.model };
	}
	const fallback = deps?.defaultRoute?.();
	if (fallback && typeof fallback.provider === 'string' && typeof fallback.model === 'string'
		&& fallback.provider !== '' && fallback.model !== '') {
		return { provider: fallback.provider, model: fallback.model };
	}
	throw Object.assign(new Error('prompt-enhancer: no model route (no session model and no configured default)'), { code: 'no_route' });
}

/** Wire the route once the webServer context is available. */
function registerRoute(ctx, config, deps) {
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: 'exact',
			path: ROUTE_PATH,
			handler: async (req, res) => {
				if (req.method !== 'POST') {
					res.statusCode = 405;
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify({ error: 'method not allowed' }));
					return;
				}
				let body;
				try {
					const chunks = [];
					let bytes = 0;
					for await (const chunk of req) {
						bytes += chunk.length;
						if (bytes > MAX_INPUT_BYTES) throw new Error('body too large');
						chunks.push(chunk);
					}
					body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
				} catch {
					res.statusCode = 400;
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify({ error: 'invalid JSON body' }));
					return;
				}
				const original = typeof body?.text === 'string' ? body.text : '';
				if (original.trim() === '') {
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify({ ok: false, code: 'empty_input', error: 'draft is empty' }));
					return;
				}
				const started = Date.now();
				try {
					const route = resolveRoute(config, body, deps);
					const user = USER_TEMPLATE.replace('{input}', original);
					const controller = new AbortController();
					const options = {
						provider: route.provider,
						model: route.model,
						system: SYSTEM_PROMPT,
						messages: [{
							role: 'user',
							content: [{ type: 'text', text: user }]
						}],
						maxTokens: 2048,
						purpose: PURPOSE,
						signal: controller.signal
					};
					let text = '';
					const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
					try {
						for await (const chunk of ctx.llm.stream(options)) {
							if (chunk.type === 'text-delta') text += chunk.text;
							else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
								throw new Error(chunk.reason.failure?.message ?? 'model call failed');
							} else if (chunk.type === 'finish' && chunk.reason?.kind === 'aborted') {
								throw new Error('model call aborted');
							}
						}
					} finally {
						clearTimeout(timer);
					}
					const cleaned = cleanResult(text);
					if (cleaned === '') {
						res.setHeader('content-type', 'application/json');
						res.end(JSON.stringify({ ok: false, code: 'llm_error', error: 'model produced no text' }));
						return;
					}
					// Guard the user's live references: retry once with an explicit
					// repair demand before giving up.
					let final = cleaned;
					let repaired = false;
					if (!referencesSurvive(original, final)) {
						const repairUser = `${USER_TEMPLATE.replace('{input}', original)}\n\nSTRICT OUTPUT REPAIR: Your previous draft lost or altered @-reference tokens. Regenerate the enhanced prompt and copy every one of these tokens verbatim, byte for byte: ${extractReferences(original).join(' ')}`;
						let retryText = '';
						const retryController = new AbortController();
						const retryTimer = setTimeout(() => retryController.abort(), TIMEOUT_MS);
						try {
							for await (const chunk of ctx.llm.stream({ ...options, messages: [{ role: 'user', content: [{ type: 'text', text: repairUser }] }] })) {
								if (chunk.type === 'text-delta') retryText += chunk.text;
								else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
									throw new Error(chunk.reason.failure?.message ?? 'model call failed');
								}
							}
						} finally {
							clearTimeout(retryTimer);
						}
						const retryCleaned = cleanResult(retryText);
						if (retryCleaned !== '' && referencesSurvive(original, retryCleaned)) {
							final = retryCleaned;
							repaired = true;
						}
					}
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify({
						ok: true,
						text: final,
						model: `${route.provider}/${route.model}`,
						elapsedMs: Date.now() - started,
						...repaired ? { repaired: true } : {},
						...referencesSurvive(original, final) ? {} : { referencesDropped: true }
					}));
				} catch (error) {
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify({
						ok: false,
						code: error?.code ?? 'llm_error',
						error: error instanceof Error ? error.message.slice(0, 300) : String(error)
					}));
				}
			}
		});
		return () => dispose();
	}, 'prompt-enhancer: enhance route');
}

/** Host plugin entry. */
export function apply(ctx, config = {}) {
	const resolved = {
		provider: typeof config.provider === 'string' && config.provider !== '' ? config.provider : undefined,
		model: typeof config.model === 'string' && config.model !== '' ? config.model : undefined
	};
	ctx.inject(['webServer', 'llm'], (scope) => {
		// Optional: the deployment default model (optional service — the plugin
		// stays inactive for route resolution when absent).
		let defaultRoute = undefined;
		try {
			// cordis ctx.get(name, strict): strict=false reads even an inactive impl
			const service = scope.get('agentDefaultModel', false);
			if (service && typeof service.currentSelection === 'function') {
				defaultRoute = () => {
					try {
						return service.currentSelection();
					} catch {
						return undefined;
					}
				};
			}
		} catch {
			defaultRoute = undefined;
		}
		registerRoute(scope, resolved, { defaultRoute });
	});
}

/** Optional single-run CLI self test: node index.js "text". */
export async function selfTest(text, env = process.env) {
	const sample = text ?? '@docs/guide.md 帮我把这个文件总结成三句话';
	const refs = extractReferences(sample);
	return {
		refs,
		systemBytes: Buffer.byteLength(SYSTEM_PROMPT, 'utf8'),
		userBytes: Buffer.byteLength(USER_TEMPLATE.replace('{input}', sample), 'utf8'),
		routePath: ROUTE_PATH
	};
}

if (process.argv[1] && process.argv[1].endsWith('index.js') && process.argv.length > 2) {
	console.log(JSON.stringify(await selfTest(process.argv[2]), null, 2));
}
