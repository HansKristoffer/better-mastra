# Upgrading better-mastra

What an app changes when it moves to a new version: the removed exports with their replacements, the wiring as code, and what to check afterwards. One section per release that needs any of it, newest first. Read every section after the version you are on. `CHANGELOG.md` beside this file lists everything else a release changed.

Both files ship in the package, so the installed copy is at `node_modules/better-mastra/UPGRADING.md`.

## After every upgrade: one copy of each peer

better-mastra imports `@mastra/core`, `ai` and `zod` as peers. With two copies installed, its classes are not your classes (a `RequestContext`, a zod schema), which fails when the code runs, not at the typecheck. List the installed versions:

```sh
bun pm ls --all | grep -E " (@mastra/core|zod|ai)@" | sed -E 's/^[^@a-z]*//' | sort -u
```

Each name must appear on one line. With npm, `npm ls @mastra/core zod ai` shows the same and which package pulled in a second copy. Fix a duplicate by moving your own dependency into the range in better-mastra's `peerDependencies`.

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
