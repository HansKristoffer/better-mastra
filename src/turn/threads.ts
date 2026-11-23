/**
 * Framework-free handlers for the chat's threads over Mastra memory: list,
 * read a page, delete, rate an answer, and the retention sweep. Every handler
 * takes the caller's scope and answers only threads of the scope's memory
 * resource. Ratings are thumbs feedback on the answer's trace in Mastra's
 * observability, beside its cost and metrics, by default; an app without
 * observability storage passes its own `ratings` store. Not the thread's
 * metadata when observational memory runs: it rewrites the metadata from an
 * earlier read.
 */

import { toAISdkMessages } from '@mastra/ai-sdk/ui'
import type { Agent } from '@mastra/core/agent'
import type { Mastra } from '@mastra/core/mastra'
import type {
	MastraDBMessage,
	MastraMemory,
	StorageThreadType
} from '@mastra/core/memory'
import {
	getSnapshotMemoryInfo,
	type MemoryStorage,
	type WorkflowRun,
	type WorkflowsStorage
} from '@mastra/core/storage'
import type { UIMessage } from 'ai'
import { compact, invariant, isRecord, must, pMap, safeJsonParse } from 'hanzio'

import {
	joinResumedAnswers,
	type ResumePointOptions
} from '../client/messages.js'
import type { ThreadLock } from '../resumable/lock.js'

import { listPendingChanges, type PendingChange } from './changes.js'
import { toUserFacingMessage } from './stream.js'
import type { ThreadKey } from './types.js'

export interface ThreadSummary {
	readonly id: string
	readonly title: string | undefined
	readonly createdAt: Date
	readonly updatedAt: Date
}

export interface ThreadPage {
	/** AI SDK 7 messages, user-facing parts only, oldest first. */
	readonly messages: readonly UIMessage[]
	readonly hasOlder: boolean
	/** ISO timestamp of the oldest message: the cursor for the next older page. */
	readonly nextCursor: string | undefined
	readonly title: string | undefined
	/** The caller's newest rating of each answer on the page. */
	readonly ratings: Readonly<Record<string, AnswerRating>>
	/** The approvals and suspended tool calls waiting in the thread. */
	readonly pendingChanges: readonly PendingChange[]
}

export interface AnswerRating {
	readonly rating: 'up' | 'down'
	readonly reason: string | undefined
}

export type DeleteThreadResult = 'deleted' | 'not_found' | 'locked'

/** Where the caller's answer ratings live, in place of Mastra's observability feedback. */
export interface AnswerRatingStore<TScope> {
	/** The caller's ratings of these answers of the thread, by message id. */
	read(
		scope: TScope,
		thread: StorageThreadType,
		answerIds: readonly string[]
	): Promise<Readonly<Record<string, AnswerRating>>>
	/** Stores the caller's rating of an answer of the thread, replacing an earlier one. */
	write(
		scope: TScope,
		thread: StorageThreadType,
		input: {
			readonly messageId: string
			readonly rating: 'up' | 'down'
			readonly reason?: string
		}
	): Promise<void>
}

export interface ThreadHandlersOptions<TScope> {
	readonly memory: MastraMemory
	/** The memory resource of the caller; `deriveThreadKey(scope).resourceId`. */
	resourceId(scope: TScope): string
	/** The user id ratings are stored for. */
	userId(scope: TScope): string
	/** Whether a stored thread of the resource is still the caller's (a membership that ended). Default: yes. */
	belongsTo?(thread: StorageThreadType, scope: TScope): boolean
	/** The Mastra instance (or lazy getter) with observability storage, for ratings. */
	readonly mastra?: Mastra | (() => Mastra)
	/** The rating store when ratings are not observability feedback; `mastra` is then not needed for them. */
	readonly ratings?: AnswerRatingStore<TScope>
	/** The chat agent (or lazy getter), for the thread's pending changes and their snapshots. */
	readonly agent?: Agent | (() => Agent)
	/** Runs a delete under the thread lock; null when a turn holds it. */
	lock?(key: ThreadKey): Promise<(() => Promise<void>) | null>
	/**
	 * Which parts a stored answer resumed after, so `get` shows the
	 * continuation in the same message (see `joinResumedAnswers`). Default:
	 * any tool result. Pass the same predicate to `mergeThreadMessages`.
	 */
	readonly isResumePoint?: (part: UIMessage['parts'][number]) => boolean
}

const USER_SOURCE = 'user'
const THUMBS = 'thumbs'
const RATING_VALUES = { up: 1, down: -1 } as const
/** More thumbs than one user leaves on one answer, even when two ratings race. */
const THUMBS_PER_READ = 100
/** Batch size for single-query thread rating lookup before falling back per trace. */
const BATCH_THUMBS_PER_READ = 500
/** The workflows an agent run is stored as: its loop and its execution, under one run id. */
const AGENT_RUN_WORKFLOWS = ['agentic-loop', 'executionWorkflow'] as const

/**
 * Whether a thread belongs to a memory resource, as `createChatRoute`'s
 * `ownsThread` answers: `undefined` when no such thread exists yet. When
 * `resumable` is passed, an in-flight first turn (not yet written to storage)
 * is checked against the active stream's recorded resource id.
 */
export async function ownsThread(input: {
	readonly memory: Pick<MastraMemory, 'getThreadById'>
	readonly threadId: string
	readonly resourceId: string
	readonly resumable?: {
		readonly resourceOf?: (threadKey: string) => Promise<string | null>
	}
}): Promise<boolean | undefined> {
	const thread = await input.memory.getThreadById({ threadId: input.threadId })

	if (thread) return thread.resourceId === input.resourceId

	const activeResource = await input.resumable?.resourceOf?.(input.threadId)
	return activeResource ? activeResource === input.resourceId : undefined
}

function resolveLazy<T>(value: T | (() => T) | undefined): T | undefined {
	return typeof value === 'function' ? (value as () => T)() : value
}

/** Whether any recalled message may be a Mastra signal or system reminder requiring `hideSignals: true`. */
function hasPossibleSignal(messages: readonly MastraDBMessage[]): boolean {
	for (const message of messages) {
		if ((message.role as string) === 'signal') return true
		const content = message.content
		if (!isRecord(content)) continue
		const metadata = content.metadata
		if (
			isRecord(metadata) &&
			(metadata.signal !== undefined ||
				metadata.systemReminder !== undefined ||
				metadata.isSystemReminder !== undefined)
		) {
			return true
		}
		if (Array.isArray(content.parts)) {
			for (const part of content.parts) {
				if (!isRecord(part)) continue
				if (part.type === 'data-signal' || part.type === 'data-user-message') {
					return true
				}
				if (
					part.type === 'text' &&
					typeof part.text === 'string' &&
					part.text.includes('<system-reminder>')
				) {
					return true
				}
			}
		}
	}
	return false
}

export function createThreadHandlers<TScope>(
	options: ThreadHandlersOptions<TScope>
) {
	const { memory } = options
	const ownThread = async (scope: TScope, threadId: string) => {
		const thread = await memory.getThreadById({ threadId })
		const isOwn =
			thread &&
			thread.resourceId === options.resourceId(scope) &&
			(options.belongsTo?.(thread, scope) ?? true)

		return isOwn ? thread : undefined
	}

	return {
		/** The caller's threads, newest first. */
		async list(
			scope: TScope,
			page: { readonly page: number; readonly perPage: number }
		): Promise<{
			readonly threads: readonly ThreadSummary[]
			readonly hasMore: boolean
		}> {
			const result = await memory.listThreads({
				filter: { resourceId: options.resourceId(scope) },
				page: page.page,
				perPage: page.perPage,
				orderBy: { field: 'updatedAt', direction: 'DESC' }
			})

			return {
				threads: result.threads.map((thread) => ({
					id: thread.id,
					title: thread.title || undefined,
					createdAt: thread.createdAt,
					updatedAt: thread.updatedAt
				})),
				hasMore: result.hasMore
			}
		},

		/**
		 * The page of messages older than the cursor (no cursor: the newest
		 * page), or undefined when the thread is not the caller's. Pages by the
		 * stored messages, signals included, so a page of signals still moves the
		 * cursor; then reads the visible messages from the oldest one's timestamp
		 * on, inclusively, so the next page's exclusive cursor loses none.
		 */
		async get(
			scope: TScope,
			input: {
				readonly threadId: string
				readonly cursor?: string
				readonly limit?: number
			}
		): Promise<ThreadPage | undefined> {
			const thread = await ownThread(scope, input.threadId)

			if (!thread) return undefined

			const key = { threadId: thread.id, resourceId: thread.resourceId }
			const end =
				input.cursor === undefined ? undefined : new Date(input.cursor)
			const stored = await memory.recall({
				threadId: key.threadId,
				resourceId: key.resourceId,
				perPage: input.limit ?? 30,
				hideSignals: false,
				includeTotal: false,
				filter: { dateRange: { ...(end && { end }), endExclusive: true } }
			})
			const oldest = stored.messages[0]
			// When the whole thread fits on one page and holds no signal messages,
			// the first recall is already exact—skip the redundant second DB query.
			const visible = !oldest
				? { messages: [] as MastraDBMessage[] }
				: !stored.hasMore && !hasPossibleSignal(stored.messages)
					? { messages: stored.messages }
					: await memory.recall({
							threadId: key.threadId,
							resourceId: key.resourceId,
							perPage: false,
							hideSignals: true,
							filter: {
								dateRange: {
									start: oldest.createdAt,
									...(end && { end }),
									endExclusive: true
								}
							}
						})
			const messages = toUiMessages(visible.messages, options)
			const agent = resolveLazy(options.agent)
			const [ratings, pendingChanges] = await Promise.all([
				readRatings(scope, thread, messages, visible.messages),
				agent ? listPendingChanges(agent, key) : []
			])

			return {
				messages,
				hasOlder: stored.hasMore,
				nextCursor:
					stored.hasMore && oldest ? oldest.createdAt.toISOString() : undefined,
				title: thread.title || undefined,
				ratings,
				pendingChanges
			}
		},

		/** Deletes the caller's thread with its messages, observations and suspended runs, unless a turn holds it. */
		async delete(scope: TScope, threadId: string): Promise<DeleteThreadResult> {
			const thread = await ownThread(scope, threadId)

			if (!thread) return 'not_found'

			const key = { threadId, resourceId: thread.resourceId }
			const release = options.lock ? await options.lock(key) : async () => {}

			if (!release) return 'locked'

			try {
				await deleteThreadEverywhere(memory, key, resolveLazy(options.agent))
				return 'deleted'
			} finally {
				await release().catch(() => {})
			}
		},

		/**
		 * Rates one answer of the caller's thread, replacing their earlier rating
		 * of it; false when the answer is not in the thread or has no trace.
		 */
		async rate(
			scope: TScope,
			input: {
				readonly threadId: string
				readonly messageId: string
				readonly rating: 'up' | 'down'
				readonly reason?: string
			}
		): Promise<boolean> {
			const thread = await ownThread(scope, input.threadId)
			const [answer] = thread
				? await findAnswers(memory, input.threadId, [input.messageId])
				: []

			if (thread && answer && options.ratings) {
				await options.ratings.write(scope, thread, {
					messageId: input.messageId,
					rating: input.rating,
					...(input.reason && { reason: input.reason })
				})

				return true
			}

			const traceId = answer && readTraceId(answer)

			if (!traceId) return false

			const mastra = requireMastra(resolveLazy(options.mastra))
			const userId = options.userId(scope)
			const earlier = await listThumbs(mastra, traceId, userId)
			const store = await mastra.getStorage()?.getStore('observability')

			if (earlier.length > 0 && store) {
				await store.deleteFeedback({
					feedbackIds: earlier.map((thumbs) => thumbs.feedbackId)
				})
			}

			invariant(
				mastra.observability.addFeedback,
				() => new Error('The Mastra observability cannot record feedback.')
			)

			await mastra.observability.addFeedback({
				traceId,
				feedback: {
					feedbackSource: USER_SOURCE,
					feedbackType: THUMBS,
					value: RATING_VALUES[input.rating],
					...(input.reason && { comment: input.reason }),
					feedbackUserId: userId
				}
			})
			// Feedback is exported in batches; without the flush a rating read right after is missing.
			await mastra.observability.flush()

			return true
		}
	}

	async function readRatings(
		scope: TScope,
		thread: StorageThreadType,
		messages: readonly UIMessage[],
		stored: readonly MastraDBMessage[]
	): Promise<Readonly<Record<string, AnswerRating>>> {
		const answerIds = new Set(
			messages.flatMap((message) =>
				message.role === 'assistant' ? [message.id] : []
			)
		)

		if (options.ratings) {
			return options.ratings.read(scope, thread, [...answerIds])
		}

		const mastra = resolveLazy(options.mastra)
		if (!mastra) return {}

		const tracedAnswers = stored.flatMap((message) => {
			const traceId = readTraceId(message)
			return answerIds.has(message.id) && traceId
				? [{ messageId: message.id, traceId, createdAt: message.createdAt }]
				: []
		})
		if (tracedAnswers.length === 0) return {}

		const userId = options.userId(scope)
		const toRating = (
			record: { value: number; comment: string | undefined } | undefined
		): AnswerRating | undefined => {
			const rating =
				record?.value === RATING_VALUES.up
					? 'up'
					: record?.value === RATING_VALUES.down
						? 'down'
						: undefined
			return rating ? { rating, reason: record?.comment } : undefined
		}

		// Batch-read all thumbs by this user since the oldest answer on this page
		// in one query instead of N+1 per-message queries.
		if (tracedAnswers.length > 1) {
			const store = await mastra.getStorage()?.getStore('observability')
			if (store) {
				let oldestTime = tracedAnswers[0]!.createdAt.getTime()
				for (const item of tracedAnswers) {
					const time = item.createdAt.getTime()
					if (time < oldestTime) oldestTime = time
				}
				const batch = await store.listFeedback({
					filters: {
						feedbackUserId: userId,
						feedbackSource: USER_SOURCE,
						feedbackType: THUMBS,
						timestamp: { start: new Date(oldestTime) }
					},
					pagination: { page: 0, perPage: BATCH_THUMBS_PER_READ },
					orderBy: { field: 'timestamp', direction: 'DESC' }
				})
				const byTrace = new Map<
					string,
					{ value: number; comment: string | undefined }
				>()
				for (const record of batch.feedback) {
					if (
						record.feedbackId &&
						record.traceId &&
						!byTrace.has(record.traceId)
					) {
						byTrace.set(record.traceId, {
							value: Number(record.value),
							comment: record.comment ?? undefined
						})
					}
				}
				if (!batch.pagination?.hasMore) {
					const entries = tracedAnswers.flatMap(({ messageId, traceId }) => {
						const rating = toRating(byTrace.get(traceId))
						return rating ? ([[messageId, rating]] as const) : []
					})
					return Object.fromEntries(entries)
				}
			}
		}

		const ratings = await Promise.all(
			tracedAnswers.map(async ({ messageId, traceId }) => {
				const [newest] = await listThumbs(mastra, traceId, userId)
				const rating = toRating(newest)

				return rating && ([messageId, rating] as const)
			})
		)

		return Object.fromEntries(compact(ratings))
	}
}

/**
 * Deletes a thread, its observations and, with the agent, its suspended runs.
 * Clears the observations on every call: once a first attempt has removed the
 * thread row, `deleteThread` no longer knows the resource and skips them.
 */
export async function deleteThreadEverywhere(
	memory: MastraMemory,
	key: ThreadKey,
	agent?: Agent
): Promise<void> {
	const runs = agent
		? (await agent.listSuspendedRuns(key)).runs.map((run) => run.runId)
		: []

	await memory.deleteThread(key.threadId)
	await (
		await memoryStore(memory)
	).clearObservationalMemory(key.threadId, key.resourceId)

	if (runs.length === 0) return

	const workflows = await memory.storage.getStore('workflows')

	for (const runId of runs) {
		for (const workflowName of AGENT_RUN_WORKFLOWS) {
			await workflows?.deleteWorkflowRunById({ runId, workflowName })
		}
	}
}

/**
 * Deletes every thread untouched since `olderThan` with everything tied to
 * it, in rounds of `batchSize`, oldest first: every expired thread sits ahead
 * of every live one. One failing thread does not stop the sweep; the next run
 * retries it. Returns how many were deleted and how many failed.
 */
export async function sweepOldThreads(input: {
	readonly memory: MastraMemory
	readonly olderThan: Date
	readonly batchSize?: number
	/** Only threads this accepts, such as one agent's thread id prefix. */
	readonly filter?: (thread: StorageThreadType) => boolean
	readonly agent?: Agent
	readonly onError?: (error: unknown, threadId: string) => void
}): Promise<{ readonly deleted: number; readonly failed: number }> {
	const batchSize = input.batchSize ?? 200
	let deleted = 0
	let failed = 0
	// Expired threads that stay (filtered out or failing) sit at the front of the
	// `updatedAt ASC` order; advance `page` past them with a fixed `batchSize`
	// so scanning never grows O(N^2) in shared databases.
	let kept = 0
	const skippedIds = new Set<string>()

	for (;;) {
		const page = Math.floor(kept / batchSize)
		const offsetInPage = kept - page * batchSize
		const { threads } = await input.memory.listThreads({
			page,
			perPage: batchSize,
			orderBy: { field: 'updatedAt', direction: 'ASC' }
		})
		const expired = threads.filter(
			(thread) => thread.updatedAt < input.olderThan
		)
		let deletedThisRound = 0
		let skippedThisRound = 0

		for (const thread of expired.slice(offsetInPage)) {
			if (skippedIds.has(thread.id)) {
				continue
			}

			if (!(input.filter?.(thread) ?? true)) {
				skippedIds.add(thread.id)
				kept += 1
				skippedThisRound += 1
				continue
			}

			try {
				await deleteThreadEverywhere(
					input.memory,
					{ threadId: thread.id, resourceId: thread.resourceId },
					input.agent
				)
				deletedThisRound += 1
			} catch (error) {
				failed += 1
				skippedIds.add(thread.id)
				kept += 1
				skippedThisRound += 1
				input.onError?.(error, thread.id)
			}
		}

		deleted += deletedThisRound

		// Done when we hit a live thread, reached the last page, or made no progress.
		if (
			expired.length < threads.length ||
			threads.length < batchSize ||
			(deletedThisRound === 0 && skippedThisRound === 0)
		) {
			break
		}
	}

	return { deleted, failed }
}

/** A suspended agent run a sweep found. */
export interface AbandonedRun {
	readonly runId: string
	/** The thread its snapshot names, when it names one. */
	readonly threadId: string | undefined
	readonly resourceId: string | undefined
	/** When its snapshot was last stored: when it suspended. */
	readonly suspendedAt: Date
}

/**
 * Deletes the snapshots of agent runs still suspended since before
 * `olderThan`, so an approval nobody answered can no longer be resumed.
 * Returns how many runs were deleted, or with `dryRun` how many would be.
 */
export async function sweepAbandonedRuns(input: {
	readonly workflows: WorkflowsStorage
	readonly olderThan: Date
	readonly pageSize?: number
	/** Concurrent deletions (default 5). */
	readonly concurrency?: number
	/** Which runs to sweep, such as only the threads of one agent. Default every one. */
	readonly filter?: (run: AbandonedRun) => boolean
	/**
	 * Thread lock (`createThreadLock`): acquires the run's thread before
	 * deleting so an active turn is left alone. Shorthand for `withLock`.
	 */
	readonly lock?: ThreadLock
	/**
	 * Runs `remove` under the app's lock of the run's thread, so a turn that
	 * is resuming the run keeps it. Resolves false when the thread is busy,
	 * which leaves the run to the next sweep.
	 */
	readonly withLock?: (
		run: AbandonedRun,
		remove: () => Promise<void>
	) => Promise<boolean>
	/** Counts the runs without deleting any. */
	readonly dryRun?: boolean
}): Promise<number> {
	const perPage = input.pageSize ?? 100
	const abandoned: AbandonedRun[] = []

	for (let page = 0; ; page++) {
		const { runs } = await input.workflows.listWorkflowRuns({
			workflowName: AGENT_RUN_WORKFLOWS[0],
			status: 'suspended',
			toDate: input.olderThan,
			perPage,
			page
		})

		abandoned.push(
			...runs
				.filter((run) => run.updatedAt <= input.olderThan)
				.map(toAbandonedRun)
				.filter((run) => input.filter?.(run) ?? true)
		)

		if (runs.length < perPage) break
	}

	if (input.dryRun) return abandoned.length

	const withLock =
		input.withLock ??
		(input.lock
			? async (run: AbandonedRun, remove: () => Promise<void>) => {
					if (!run.threadId) {
						await remove()
						return true
					}
					const release = await input.lock!({ threadId: run.threadId })
					if (!release) return false
					try {
						await remove()
					} finally {
						await release()
					}
					return true
				}
			: undefined)

	let deleted = 0

	await pMap(
		abandoned,
		async (run) => {
			const remove = async () => {
				await Promise.all(
					AGENT_RUN_WORKFLOWS.map((workflowName) =>
						input.workflows.deleteWorkflowRunById({
							runId: run.runId,
							workflowName
						})
					)
				)
			}

			if (withLock) {
				if (await withLock(run, remove)) deleted += 1
			} else {
				await remove()
				deleted += 1
			}
		},
		{ concurrency: input.concurrency ?? 5 }
	)

	return deleted
}

function toAbandonedRun(run: WorkflowRun): AbandonedRun {
	const memory = getSnapshotMemoryInfo(
		typeof run.snapshot === 'string'
			? parseSnapshot(run.snapshot)
			: run.snapshot
	)

	return {
		runId: run.runId,
		threadId: memory?.threadId,
		resourceId: memory?.resourceId ?? run.resourceId,
		suspendedAt: run.updatedAt
	}
}

function parseSnapshot(
	snapshot: string
): Parameters<typeof getSnapshotMemoryInfo>[0] {
	const parsed =
		safeJsonParse<Parameters<typeof getSnapshotMemoryInfo>[0]>(snapshot)

	return parsed.ok ? parsed.data : undefined
}

function toUiMessages(
	messages: MastraDBMessage[],
	options: ResumePointOptions
): UIMessage[] {
	return joinResumedAnswers(
		(toAISdkMessages(messages, { version: 'v7' }) as unknown as UIMessage[])
			.map(toUserFacingMessage)
			.filter((message) => message.parts.length > 0),
		options.isResumePoint ? { isResumePoint: options.isResumePoint } : {}
	)
}

async function findAnswers(
	memory: MastraMemory,
	threadId: string,
	messageIds: readonly string[]
): Promise<MastraDBMessage[]> {
	const { messages } = await (
		await memoryStore(memory)
	).listMessagesById({
		messageIds: [...messageIds]
	})

	return messages.filter(
		(message) => message.role === 'assistant' && message.threadId === threadId
	)
}

/** Mastra stores the run's trace id in the assistant message's content metadata. */
function readTraceId(message: MastraDBMessage): string | undefined {
	const traceId = message.content.metadata?.traceId

	return typeof traceId === 'string' ? traceId : undefined
}

async function listThumbs(mastra: Mastra, traceId: string, userId: string) {
	const store = must(
		await mastra.getStorage()?.getStore('observability'),
		() => new Error('The Mastra instance has no observability storage.')
	)

	const { feedback } = await store.listFeedback({
		filters: {
			traceId,
			feedbackUserId: userId,
			feedbackSource: USER_SOURCE,
			feedbackType: THUMBS
		},
		pagination: { page: 0, perPage: THUMBS_PER_READ },
		orderBy: { field: 'timestamp', direction: 'DESC' }
	})

	return feedback.flatMap((record) =>
		record.feedbackId
			? [
					{
						feedbackId: record.feedbackId,
						value: Number(record.value),
						comment: record.comment ?? undefined
					}
				]
			: []
	)
}

function requireMastra(mastra: Mastra | undefined): Mastra {
	return must(
		mastra,
		() => new Error('Rating answers needs the Mastra instance.')
	)
}

async function memoryStore(memory: MastraMemory): Promise<MemoryStorage> {
	return must(
		await memory.storage.getStore('memory'),
		() => new Error('The memory storage has no memory domain.')
	)
}
