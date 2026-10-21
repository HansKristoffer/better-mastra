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

```ts
import { RedisClient } from 'bun'
import { bunRedis, createResumableStreams } from 'better-mastra/resumable'

const resumable = createResumableStreams({ redis: bunRedis(new RedisClient(process.env.REDIS_URL)) })

// POST /chat/:threadId — do not tie the run to request.signal
const abort = new AbortController()
const stream = await resumable.start({ threadKey: threadId, stream: uiMessageStream, abort })

// GET /chat/:threadId/stream
const resumed = await resumable.reconnect(threadId, request.signal)
if (!resumed) return new Response(null, { status: 204 })

// POST /chat/:threadId/stop — works from any replica
await resumable.stop(threadId)

// shutdown: waits for active turns (drainTimeoutMs)
await resumable.close()
```

Use `ioRedis(client)` for ioredis. Both adapters open extra connections with `duplicate()`: one subscriber per replica, and one per cross-replica reader (for `XREAD BLOCK`).

Use `upstashRedis(client)` for `@upstash/redis`. Upstash has no blocking `XREAD`, so a cross-replica reader polls every `pollMs` (200 ms); pass `() => Redis.fromEnv()` to create the client on first use.

An app that already holds a per-thread lock can keep the locator in the lock's value with `locator: { read, write, expire }`. The locator then lives exactly as long as the lock. `expire` renews it while the turn runs and shortens it to `graceMs` after; leave it out when the lock renews itself:

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

How it works: chunks are buffered in memory (consecutive `text-delta`s merged) and fanned out to subscribers. A per-thread locator `{ streamId, owner }` in Redis says which replica owns the turn. Reconnecting to the owner is served from memory. Reconnecting to another replica publishes a spill request on the owner's control channel; the owner writes its buffer in one `XADD`, then mirrors new chunks in 50 ms batches (first one immediate) until a terminal marker, and the reader follows with `XREAD BLOCK`.

Redis ops for a ~1,500-chunk turn:

| Design | Redis ops |
|---|---|
| Mastra durable agents (`CachingPubSub`: cache write + publish per chunk) | ~3,000–4,500 |
| Coalesced SETEX + PUBLISH (hellu support-turn) | ~600 |
| This, no reconnect | 2 (locator SET, final PEXPIRE) + 1 PEXPIRE per 10 s of turn |
| This, same-replica reconnect | +0 for a running turn, +1 GET for a finished one |
| This, cross-replica reconnect | +1 PUBLISH, +1 XADD and EXPIRE per 50 ms batch, reader XREADs |

Failure behaviour: a buffer over `maxBufferBytes` (2 MB) keeps streaming but new reconnects get 204. If the owner crashes, its locator expires and the cross-replica reader ends with an `error` chunk after `idleTimeoutMs`; the client reloads the thread from Mastra memory. If Redis is down, turns still run and same-replica reconnects work; cross-replica reconnects return 204. Finished turns stay resumable for `graceMs` (30 s).
