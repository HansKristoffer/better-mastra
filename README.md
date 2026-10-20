# better-mastra

A small layer on Mastra and the AI SDK: model registry, chat turns, resumable streams and chat clients for React and Vue.

Work in progress.

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
