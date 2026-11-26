# Upgrading better-mastra

What an app changes when it moves to a new version: the removed exports with their replacements, the wiring as code, and what to check afterwards. One section per release that needs any of it, newest first. Read every section after the version you are on. `CHANGELOG.md` beside this file lists everything else a release changed.

Both files ship in the package, so the installed copy is at `node_modules/better-mastra/UPGRADING.md`.

## After every upgrade: one copy of each peer

better-mastra imports `@mastra/core`, `ai` and `zod` as peers. With two copies installed, its classes are not your classes (a `RequestContext`, a zod schema), which fails when the code runs, not at the typecheck. List the installed versions:

```sh
bun pm ls --all | grep -E " (@mastra/core|zod|ai)@" | sed -E 's/^[^@a-z]*//' | sort -u
```

Each name must appear on one line. With npm, `npm ls @mastra/core zod ai` shows the same and which package pulled in a second copy. Fix a duplicate by moving your own dependency into the range in better-mastra's `peerDependencies`.

## 0.12.0

No export was removed or renamed. `ToolTier` names a new tier, `plan`; the type stays open (`string & {}`), so a `switch` over tiers keeps typechecking, but give `plan` its own branch where tiers decide what a card shows.

### Change plans (opt-in)

A plan-tier tool drafts writes into the turn's change plan, which the user confirms once. Nothing changes for an app that does not use it. To adopt it:

```ts
import { pgRecordStore } from 'better-mastra/pg'
import { createChangePlanStore, readProposedChangePlans } from 'better-mastra/client'
import { useChangePlan } from 'better-mastra/react' // or 'better-mastra/vue'

// 1. Server: one store, created once by the process that migrates.
const records = pgRecordStore({ pool }) // a pg Pool; creates mastra.better_mastra_records
await records.init()

// 2. The turn: binds the turn's plan and offers it when the turn answered.
runChatTurn(request, { changePlans: { store: records }, /* … */ })

// 3. The route: GET/apply/discard under {path}/:threadId/plans/:planId. Needs ownsThread.
createChatRoute({
	/* …, */ ownsThread,
	changePlans: { store: records, tools: allDefinedTools, requestContext: (auth, threadId) => contextFor(auth, threadId) }
})

// 4. Cleanup: a deleted thread takes its plans along; expired plans go on a schedule.
createThreadHandlers({ records, /* … */ })
await sweepOldThreads({ memory, olderThan, records })
await records.deleteExpired(new Date())

// 5. Client: the plan store hears the turn's plan part.
const plans = createChangePlanStore({ api: '/chat', fetch: chatFetch })
const session = createChatSession({ /* …, */ onData: plans.onData })
// per assistant message, once the turn is no longer busy:
for (const { planId, steps } of readProposedChangePlans(message)) {
	// <PlanCard planId={planId} fallbackSteps={steps} />, with useChangePlan(plans, threadId, planId)
}
```

Then move a bulk write tool from `tier: 'approval'` with `execute` to `tier: 'plan'` with `plan: { propose, read, write, guard }` (see the README). Keep `tier: 'approval'` for single writes.

**Check afterwards.**

- `bun run test` in the app: a plan-tier tool's `propose` must not write. The README's guard test pattern (count writes in the data layer across a whole turn, with a negative control) is in `src/turn/changePlans.test.ts`.
- The apply route's request context carries what your guards read (the user, the workspace, the role): it is built from the apply request, not copied from the turn.
- Your platform does not buffer `application/x-ndjson` responses, or the progress arrives all at once at the end.

### Turn datasets (opt-in)

Data tools register rows by id and display tools show them by id, so tables and charts show stored numbers, never ones the model typed. It uses the same `ChatRecordStore` as change plans.

```ts
import { registerDataset } from 'better-mastra/tools'
import { createDatasetStore } from 'better-mastra/client'
import { useDataset } from 'better-mastra/react' // or 'better-mastra/vue'

runChatTurn(request, { datasets: { store: records }, /* … */ })
createChatRoute({ /* …, */ ownsThread, datasets: { store: records } })

// a data tool's execute returns the handle instead of the rows
execute: async (input, context) => registerDataset(context, { rows, columns, title, summary })

// a display tool names the datasets its input shows
defineTool({ /* … */ datasets: (input) => [input.datasetId] })

// client: one onData for every store
const datasets = createDatasetStore({ api: '/chat', fetch: chatFetch })
createChatSession({ /* …, */ onData: (part) => { plans.onData(part); datasets.onData(part) } })
```

**Check afterwards.** A data tool whose rows used to reach the model as its result now gives a handle: move what the model needs to talk about into `summary`, worked out in code, and tell it in the instructions to show tables and charts with the display tools.

### Three unions grew: `declined`, `user_paused`, `screening`

Message screening (`runChatTurn({ screening })`, opt-in) adds a value to three unions an app may switch over. Nothing changes until you pass `screening`, but an exhaustive `switch` or `Record` stops typechecking until it has the case:

- `TurnOutcome` / `turnOutcomes`: `declined`, a message screening turned away. `sinks.scoreTurn` is not called for it and it has no reply suggestions.
- `ChatErrorCode` / `chatErrorCodes`: `user_paused` (429, with `retryAfterSeconds`), for a user paused after abuse strikes. The client counts it as worth trying again later; give it a sentence:

```ts
if (failure.kind === 'refused' && failure.refusal.code === 'user_paused') {
	return t('chat.paused', { minutes: Math.ceil((failure.refusal.retryAfterSeconds ?? 60) / 60) })
}
```

- `ChatTurnStage` / `chatTurnStages`: `screening`, in `stageMs` and in the stage of a logged failure.

To adopt screening, see the README's "Message screening": `createMessageScreener` on a cheap model, `reply` in your copy, and `strikes: screeningStrikes(createAbuseStrikes({ runScript, secret, keyPrefix }), (scope) => scope.userId)`.

**Check afterwards.** A dashboard of outcomes or refusal codes has the new labels. A declined message is not stored: a client that reloads the thread after it no longer shows it, which is intended.

## 0.11.0

No export was removed or renamed, and no existing union requires new switch cases. Several defaults changed for better prompt-cache hit rates, latency and safety, and new helpers remove boilerplate from apps.

### Default behaviour changes

- **Parallel read-tool execution even with approval tools registered.** `createChatAgent` now defaults `toolCallConcurrency` to `{ limit: 10, strategy: 'called' }` (Mastra's default `'available'` strategy forced sequential execution on every step whenever any approval/suspend tool existed in the catalog). Steps that only call read tools now execute in parallel; steps calling an approval/suspend tool still run sequentially. Override via `toolCallConcurrency` on `createChatAgent` or `ChatTurnPlan`.
- **Observational Memory idle buffering.** `createMemory` now enables `bufferOnIdle: true` by default so background observations run between user turns instead of blocking the next turn's TTFT (pass `bufferOnIdle: false` to opt out).
- **Pre-TTFT abort short-circuit.** `runChatTurn` now checks `request.signal.aborted` between pre-stream stages (`scope`, `gate`/`thread`, `thread_lock`, `usage_limit`, `preparation`) and stops early if the caller already disconnected instead of burning DB, quota, or LLM work.
- **Automatic Anthropic caching with 1–3 explicit breakpoints.** `anthropicRoute` now sets top-level `cacheControl: { type: 'ephemeral' }` whenever a request carries fewer than 4 explicit cache markers (previously only when it had 0). Callers with 1–3 explicit instruction/message breakpoints now also get automatic sliding-tail caching across tool hops and turns within Anthropic's 4-slot limit.
- **Chat agent defaults.** `createChatAgent` now includes Mastra's `PrefillErrorHandler` (`errorProcessors`) and compacts verbose string-format regexes on all tool schemas (including oRPC/MCP tools via `compactTool`) while sorting tool keys deterministically for cache stability. Opt out with `prefillErrorHandler: false` or `compactToolSchemas: false`. If you added `new PrefillErrorHandler()` to `errorProcessors` yourself, it is deduplicated automatically and you can remove it.
- **Postgres connection timeout.** `pgStorage` and `createPgPool` now default `connectionTimeoutMillis` to `10_000` ms (pass `0` to wait indefinitely) and accept `statementTimeoutMs`.
- **Framework chat subscription throttling.** `useChatSession` in both `better-mastra/vue` and `better-mastra/react` now defaults `throttleMs` to `40` ms (`DEFAULT_CHAT_THROTTLE_MS`), flushing status, message-count and error transitions immediately while throttling intra-message deltas. Pass `{ throttleMs: 0 }` to restore unthrottled per-delta updates.
- **Non-idempotent `POST` retry safety.** `createChatFetch` no longer retries ambiguous post-receipt failures (`timeout`, `connection reset`, `unexpected end of stream`) on `POST` requests, preventing duplicate turns; it still retries pre-receipt connect failures (`Failed to fetch`, `offline`, `ECONNREFUSED`, `ENOTFOUND`) and honors `Retry-After` on `503 draining` responses (up to `drainingRetries`, default `2`).
- **Compact Redis embeddings.** `createEmbedder` writes cached query embeddings as compact base64 `Float32Array` values (`f32:...`, ~3x smaller than JSON) and reads both the new format and existing JSON arrays seamlessly.

### Worth adopting

- **Extended prompt cache TTLs & OpenAI cache routing.** Set `cacheTtl: { instructions: '1h', conversation: '5m' }` (or `'1h'`) on `ChatTurnPlan`, `cacheTtl: '1h'` on `anthropicRoute`, and `promptCacheKey` / `promptCacheRetention: '24h'` on `openAiRoute` or `ChatTurnPlan` to keep shared prefixes warm across longer pauses between user turns.
- **Tool output size caps & per-turn read deduplication.** Pass `maxModelOutputChars` on `defineTool` to cap oversized payloads seen by the model (keeping full structured data for UI cards) and `memoizePerTurn: true` on `tier: 'read'` tools to deduplicate identical reads within a turn (auto-invalidated on any write).
- **Unified thread lock + resumable stream coordinator.** Replace separate `createThreadLock` + `createResumableStreams` wiring with `createChatCoordinator` from `better-mastra/resumable` to share one Redis key and one renewal timer per active turn, and pass `resumable` to `ownsThread` for turn-1 ownership checks before the first message persists. Also pass `resumable` to `createShutdown` so active streams drain before closing Postgres/Redis.
- **O(1) cross-replica resumable streams.** On `bunRedis` and `ioRedis`, cross-replica reconnects now multiplex live chunks over each replica's single shared control Pub/Sub connection with non-blocking `XREAD` gap catch-up instead of opening a dedicated Redis connection per reconnecting client.
- **Cache-stable page actions.** Use `createClientActionDispatcherTool` + `formatClientActionsSignal` from `better-mastra/tools` so changing pages never alters the `tools` array and never invalidates the prompt cache. `createChatSession` automatically unwraps `run_page_action` calls.
- **Provider-aware deferred tools.** Use `createDeferredToolSupport` from `better-mastra/tools` to pick Anthropic native `deferLoading` on direct Anthropic routes and a Mastra `InputProcessor` elsewhere.
- **CI prompt-prefix drift check.** Use `diffPromptPrefixes` from `better-mastra/turn` in tests to assert that two pages or users share the exact same cached system + tool prefix.
- **Vue thread composable & safe web markdown.** Replace hand-rolled Vue thread switching/loading composables with `useChatThread` (and reactive `useChatSession(() => session)`) from `better-mastra/vue`, and configure web `markdown-it` safely with `configureSafeMarkdownIt` from `better-mastra/client`.
- **Single-call PostHog batching.** `posthogGenerations` automatically uses `capture.batch` (PostHog `/batch/`) when given `createPostHogCapture(...)`, sending multi-step turns in one HTTP request.
- **Lightweight manifest generation.** `better-mastra-tool-manifest` now supports `--preload <module>`, factory exports `() => DefinedTool[] | ToolManifest`, and static `defineToolManifest(...)` exports.

## 0.10.0

### A turn cut off at the output-token limit is `truncated`, not `answered`

A model call that ends on its output-token limit used to be reported as an answer: `outcome: 'answered'`, `toolCalls: 0`, and a tool card on the client that waited forever, because a tool call the model was still writing never runs. The turn now reads Mastra's finish reason (`finishReason: 'length'` on the stream's `finish` chunk) on the server and in the chat session. Nothing is wired; two unions grew, and code that switches over them needs a case.

**Server.** `TurnOutcome` and `turnOutcomes` have a new value, `truncated`. An exhaustive `switch` or `Record<TurnOutcome, …>` stops typechecking until it has the case; a metric labelled by outcome gets a new label. For a truncated turn `sinks.scoreTurn` is not called and no reply suggestions are sent.

**Client.** `ChatTurnFailure` has a new kind, `truncated`, and the user turn ends `failed` with it. `canTryAgain` is true: Try again writes the answer again. `onFailure` reports it with `code: 'truncated'`, and `onSaved` is not called. Add the sentence where you map a failure to copy:

```ts
import type { ChatTurnFailure } from 'better-mastra/client'

function failureSentence(failure: ChatTurnFailure): string {
	switch (failure.kind) {
		case 'truncated':
			return t('chat.cutOff') // "The answer was cut off before it finished. Try again."
		// … refused, server-error, connection-lost, follow-up-budget-exhausted
	}
}
```

**Check afterwards.**

- A card that shows progress for a tool part without a result (`input-streaming`, `input-available`) should do so only while the turn is busy (`isChatTurnBusy(turn)`). Once the turn has ended, a part still in that state never ran.
- `plan.maxOutputTokens` has room for your longest tool input plus the reasoning before it: reasoning tokens count toward the limit. A count of `truncated` outcomes above zero means it does not.

## 0.9.0

### Removed exports

`better-mastra/models` lost its prompt-cache module, eight exports. The chat turn places the cache markers itself, so most apps delete the calls and import nothing instead.

| Removed from `better-mastra/models` | Replacement |
| --- | --- |
| `withPromptCache(model, provider)` | Nothing in a chat turn: `createChatAgent` wraps the plan's model. For a model you call yourself, `withConversationCache(model)` from `better-mastra/turn`. |
| `promptCacheMiddleware({ provider, conversation })` | `withConversationCache(model)` from `better-mastra/turn`. |
| `markConversationForCache(prompt, provider)` | `markConversationForCache(prompt)` from `better-mastra/turn`. It takes no provider. |
| `cacheMarker(provider)` | `CACHE_MARKER` from `better-mastra/turn`, or `withCacheControl(providerOptions)` to add it to options you already have. |
| `CacheProvider` | None. A marker is written under both the `anthropic` and the `openrouter` key. |
| `perTurnSystemMessage(content)` | `signal` on the turn plan: sent after the user's message, so the cached history before it stays a hit. |
| `PER_TURN_SYSTEM_MESSAGE_OPTIONS` | `signal` on the turn plan. |
| `movePerTurnContext(prompt, provider)` | `signal` on the turn plan. For context that changes per thread, not per request, `perRequestInstructions`. |

No other subpath lost an export in 0.8.0 or 0.9.0.

### Wire the thread lock

`runChatTurn` has had a `lock` port since 0.1, but no lock shipped with it: an app that passed none ran two turns on one thread at once. `createThreadLock` is that lock, shared across replicas through the Redis adapter the resumable streams already use.

```ts
import { bunRedis, createThreadLock } from 'better-mastra/resumable'
import { createThreadHandlers, runChatTurn, sweepAbandonedRuns } from 'better-mastra/turn'

// One per process. Without `redis` it locks within the process, which is right for one instance and for tests.
export const chatThreadLock = createThreadLock({
	redis: bunRedis(redis), // or ioRedis(redis), upstashRedis(redis)
	keyPrefix: 'myapp:chat:thread-lock:',
	logger
})

// 1. The turn: a second request on a busy thread is refused with `turn_in_progress` (409).
runChatTurn(request, { lock: chatThreadLock /* … */ })

// 2. The thread handlers: a thread is not deleted under a running turn. `delete` returns 'locked'; answer 409.
createThreadHandlers({ lock: chatThreadLock /* … */ })

// 3. The sweep of abandoned approvals, if you run one: a run being answered right now is left to the next sweep.
await sweepAbandonedRuns({
	workflows,
	olderThan,
	withLock: async (run, remove) => {
		if (!run.threadId) {
			await remove()
			return true
		}

		const release = await chatThreadLock({ threadId: run.threadId })
		if (!release) return false

		try {
			await remove()
		} finally {
			await release()
		}
		return true
	}
})
```

Pass the same adapter you give `createResumableStreams` when you have one. The lock only sends commands and never opens a connection, so a command client that cannot `duplicate()` works with `bunRedis(client, { connect })` whatever `connect` does. When Redis does not answer, the turn runs under the process's own lock and the outage is logged through `logger.warn`.

### Give `turn_in_progress` its own sentence

With the lock wired, a message sent from a second tab or during a reload mid-answer is refused. The chat session does not retry it: the turn ends `failed` with `failure.kind === 'refused'`, `failure.refusal.code === 'turn_in_progress'` and `canTryAgain` true. Without a sentence of its own the user reads your generic error for something that is not one.

```ts
import { canTryAgain, type ChatTurnFailure } from 'better-mastra/client'

function failureSentence(failure: ChatTurnFailure): string {
	if (failure.kind === 'refused' && failure.refusal.code === 'turn_in_progress') {
		return t('chat.busy') // "The last answer is still being written. Try again in a moment."
	}
	// …
}

const showTryAgain = canTryAgain(failure)
```

An app that renamed the code with `defineChatErrors({ rename })` matches its own code.

### Worth adopting

- `sinks.turnFinished` carries `stageMs` and `streamStartedMs`. Log them with the turn: `timeToFirstTextMs - streamStartedMs` is the model's share of the wait before the first token, the rest is your ports and Mastra's start.
- A sink or callback that throws is logged as `a turn port failed` and no longer cuts the answer. Remove a `try`/`catch` you added around a sink for that reason.

## 0.8.0

No export was removed. Three changes in behaviour need a look.

### Reply suggestions follow the answer's `finish`

The answer's `finish` chunk is no longer held until the replies are in: they follow it as transient parts on the same stream. `createChatSession` handles this and ends the user turn at the answer. A client of your own that stops reading at `finish` loses the replies; keep the earlier order for it:

```ts
runChatTurn(request, { replySuggestions: { agentId, holdFinish: true } /* … */ })
```

### Compact tool schemas reach only inputs built with `toolInputSchema`

`toolInputSchema(zodSchema)` from `better-mastra/tools` now leaves out the regular expression zod writes for a string format (190 characters for a UUID, 330 for a datetime). Nothing is wired, and nothing else is changed:

- A tool whose `inputSchema` is `toolInputSchema(…)` gets the compact schema. `{ stringChecks: 'full' }` keeps zod's.
- A tool made elsewhere and passed as `defineTool({ tool })` keeps the schema its maker wrote. That includes orpc-fn's `createMastraTool`, which converts with oRPC's own converter, and MCP tools.

`measureToolSchemas` from `better-mastra/turn` shows what each tool's schema costs, before and after. The changed schemas are a new prompt prefix, so the provider's cache is written once more on the first turn after the deploy.

### A list of instruction blocks is cached per block

`plan.instructions` may be a list. Each block is its own system message and the last two end in a cache breakpoint. A string behaves as before. To let the first block and the tools be read from the cache across users, put what every user shares first and what one workspace shares after it:

```ts
plan: {
	instructions: [sharedRules, workspaceInstructions],
	signal: `The user is on ${page}.` // what changes per request
}
```

### Worth adopting

- `parseChatTurnBody(chatTurnBodySchema.extend({ … }), json)` from `better-mastra/turn` checks every message part with the AI SDK, in place of a hand-written schema and a cast.
- `defineChatErrors({ codes, rename })` gives the app's own refusal codes one typed list for `gate`, `admit`, `refusals` and the client.
- `plan.outputProcessors` fixes in code what the prompt would otherwise need a rule for; the streamed text, the stored thread and the turn's report all get the rewritten text.
