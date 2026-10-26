# better-mastra

A small layer on Mastra and the AI SDK: model registry, chat turns, resumable streams and chat clients for React and Vue.

Work in progress.

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
```

`pgStorage` and `libsqlStorage` from the package root are the same presets loaded on call (they return promises); they stay for compatibility.

## Resumable streams (`better-mastra/resumable`)

Opt-in. A dropped connection no longer aborts the turn: the client reconnects with AI SDK `reconnectToStream` (`useChat({ resume: true })`) and gets a full replay of the current assistant message plus the live tail (`resumeStreamIsReplay: true`, the `DefaultChatTransport` default).

With the chat route, pass the registry and an ownership check; the route then adds `GET {path}/:threadId/stream` and `POST {path}/:threadId/stop`, which the chat client in `better-mastra/client` already calls:

```ts
import { RedisClient } from 'bun'
import { createChatRoute } from 'better-mastra/hono'
import { bunRedis, createResumableStreams } from 'better-mastra/resumable'

const resumable = createResumableStreams({ redis: bunRedis(new RedisClient(process.env.REDIS_URL)) })

app.route('/', createChatRoute({ path: '/chat', auth, parseBody, runTurn, resumable, ownsThread }))

// shutdown: waits for active turns (drainTimeoutMs)
await resumable.close()
```

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

The adapters need Redis 6.2 or newer (`SET … GET`). Use `ioRedis(client)` for ioredis. Both adapters open extra connections with `duplicate()`: one subscriber per replica, and one per cross-replica reader (for `XREAD BLOCK`). Sticky sessions keep reconnects on the owner, where they cost nothing.

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

How it works: chunks are buffered in memory (consecutive text, reasoning and tool-input deltas merged) and fanned out to subscribers. A per-thread locator `{ streamId, owner }` in Redis says which replica owns the turn; the owner writes it once it listens on its control channel. Reconnecting to the owner is served from memory. Reconnecting to another replica publishes a spill request on the owner's control channel; on the first request the owner writes its buffer in one `XADD` to the turn's spill stream, then mirrors new chunks in 50 ms batches (first one immediate), one `XADD` at a time so entries stay ordered on HTTP clients too, until a terminal marker. Every reader of the turn, including one that reconnects again, follows that same stream with `XREAD` from the start.

Redis ops for a ~1,500-chunk turn:

| Design | Redis ops |
|---|---|
| Mastra durable agents (`CachingPubSub`: cache write + publish per chunk) | ~3,000–4,500 |
| Coalesced SETEX + PUBLISH (hellu support-turn) | ~600 |
| This, no reconnect | 2 (locator SET … GET, final PEXPIRE) + 1 PEXPIRE per 10 s of turn, +1 PUBLISH when the thread's last turn ran on another replica |
| This, same-replica reconnect | +0 for a running turn, +1 GET for a finished one |
| This, cross-replica reconnect | +1 GET and PUBLISH per reconnect; once per turn +1 XADD per 50 ms batch, 2 EXPIREs and 1 EXPIRE per 30 s; reader XREADs |

Failure behaviour: a buffer over `maxBufferBytes` (2 MB) keeps streaming but new reconnects get 204. If the owner crashes, a cross-replica reconnect gets 204 within 2 s, and a reader already following ends with an `error` chunk after `idleTimeoutMs`; the client reloads the thread from Mastra memory. A reader whose own Redis read fails ends with an `error` chunk too; a failed liveness check is taken as a blip and the reader keeps waiting. If Redis is down, turns still run and same-replica reconnects work; cross-replica reconnects return 204. Finished turns stay resumable for `graceMs` (30 s).

## Per-user request limits (`better-mastra/usage`)

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
