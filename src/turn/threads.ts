/**
 * Framework-free handlers for the chat's threads over Mastra memory: list,
 * read a page, delete, rate an answer, and the retention sweep. Every handler
 * takes the caller's scope and answers only threads of the scope's memory
 * resource. Ratings are thumbs feedback on the answer's trace in Mastra's
 * observability, beside its cost and metrics, never in the thread's metadata,
 * which observational memory rewrites from an earlier read.
 */

import { toAISdkMessages } from '@mastra/ai-sdk/ui'
import type { Agent } from '@mastra/core/agent'
import type { Mastra } from '@mastra/core/mastra'
import type {
	MastraDBMessage,
	MastraMemory,
	StorageThreadType
} from '@mastra/core/memory'
import type { MemoryStorage, WorkflowsStorage } from '@mastra/core/storage'
import { isToolUIPart, type UIMessage } from 'ai'

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

export interface ThreadHandlersOptions<TScope> {
	readonly memory: MastraMemory
	/** The memory resource of the caller; `deriveThreadKey(scope).resourceId`. */
	resourceId(scope: TScope): string
	/** The user id ratings are stored for. */
	userId(scope: TScope): string
	/** Whether a stored thread of the resource is still the caller's (a membership that ended). Default: yes. */
	belongsTo?(thread: StorageThreadType, scope: TScope): boolean
	/** The Mastra instance with observability storage, for ratings. */
	readonly mastra?: Mastra
	/** The chat agent, for the thread's pending changes and their snapshots. */
	readonly agent?: Agent
	/** Runs a delete under the thread lock; null when a turn holds it. */
	lock?(key: ThreadKey): Promise<(() => Promise<void>) | null>
}

const USER_SOURCE = 'user'
const THUMBS = 'thumbs'
const RATING_VALUES = { up: 1, down: -1 } as const
/** More thumbs than one user leaves on one answer, even when two ratings race. */
const THUMBS_PER_READ = 100
/** The workflows an agent run is stored as: its loop and its execution, under one run id. */
const AGENT_RUN_WORKFLOWS = ['agentic-loop', 'executionWorkflow'] as const

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
			const visible = oldest
				? await memory.recall({
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
				: { messages: [] as MastraDBMessage[] }
			const messages = toUiMessages(visible.messages)
			const [ratings, pendingChanges] = await Promise.all([
				readRatings(scope, messages, visible.messages),
				options.agent ? listPendingChanges(options.agent, key) : []
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
				await deleteThreadEverywhere(memory, key, options.agent)
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
			const traceId = answer && readTraceId(answer)

			if (!traceId) return false

			const mastra = requireMastra(options.mastra)
			const userId = options.userId(scope)
			const earlier = await listThumbs(mastra, traceId, userId)
			const store = await mastra.getStorage()?.getStore('observability')

			if (earlier.length > 0 && store) {
				await store.deleteFeedback({
					feedbackIds: earlier.map((thumbs) => thumbs.feedbackId)
				})
			}

			if (!mastra.observability.addFeedback) {
				throw new Error('The Mastra observability cannot record feedback.')
			}

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
		messages: readonly UIMessage[],
		stored: readonly MastraDBMessage[]
	): Promise<Readonly<Record<string, AnswerRating>>> {
		if (!options.mastra) return {}

		const mastra = options.mastra
		const answerIds = new Set(
			messages.flatMap((message) =>
				message.role === 'assistant' ? [message.id] : []
			)
		)
		const ratings = await Promise.all(
			stored.map(async (message) => {
				const traceId = readTraceId(message)

				if (!answerIds.has(message.id) || !traceId) return undefined

				const [newest] = await listThumbs(
					mastra,
					traceId,
					options.userId(scope)
				)
				const rating =
					newest?.value === RATING_VALUES.up
						? 'up'
						: newest?.value === RATING_VALUES.down
							? 'down'
							: undefined

				return (
					rating && ([message.id, { rating, reason: newest?.comment }] as const)
				)
			})
		)

		return Object.fromEntries(ratings.filter((entry) => entry !== undefined))
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
	await (await memoryStore(memory)).clearObservationalMemory(
		key.threadId,
		key.resourceId
	)

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
	// Expired threads that stay (filtered out or failing) sit ahead of the rest.
	// ponytail: the page grows with them; a cursor if a store keeps many.
	let kept = 0

	for (;;) {
		const { threads } = await input.memory.listThreads({
			page: 0,
			perPage: kept + batchSize,
			orderBy: { field: 'updatedAt', direction: 'ASC' }
		})
		const expired = threads.filter(
			(thread) => thread.updatedAt < input.olderThan
		)
		let deletedThisRound = 0

		for (const thread of expired.slice(kept)) {
			if (!(input.filter?.(thread) ?? true)) {
				kept += 1
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
				kept += 1
				input.onError?.(error, thread.id)
			}
		}

		deleted += deletedThisRound

		// Done when the page held a live thread, or the page was all leftovers.
		if (expired.length < threads.length || expired.length <= kept) break
	}

	return { deleted, failed }
}

/**
 * Deletes the snapshots of agent runs still suspended since before
 * `olderThan`, so an approval nobody answered can no longer be resumed.
 * Returns how many runs were deleted.
 */
export async function sweepAbandonedRuns(input: {
	readonly workflows: WorkflowsStorage
	readonly olderThan: Date
	readonly pageSize?: number
}): Promise<number> {
	const perPage = input.pageSize ?? 100
	const runIds: string[] = []

	for (let page = 0; ; page++) {
		const { runs } = await input.workflows.listWorkflowRuns({
			workflowName: AGENT_RUN_WORKFLOWS[0],
			status: 'suspended',
			toDate: input.olderThan,
			perPage,
			page
		})

		runIds.push(
			...runs
				.filter((run) => run.updatedAt <= input.olderThan)
				.map((run) => run.runId)
		)

		if (runs.length < perPage) break
	}

	for (const runId of runIds) {
		for (const workflowName of AGENT_RUN_WORKFLOWS) {
			await input.workflows.deleteWorkflowRunById({ runId, workflowName })
		}
	}

	return runIds.length
}

function toUiMessages(messages: MastraDBMessage[]): UIMessage[] {
	return mergeResumedAnswers(
		(toAISdkMessages(messages, { version: 'v7' }) as unknown as UIMessage[])
			.map(toUserFacingMessage)
			.filter((message) => message.parts.length > 0)
	)
}

/**
 * Mastra stores the text a run wrote after resuming from a client tool's
 * result as a new assistant message, while the client streamed it into the
 * message that holds the call. Joining the two keeps the message the client
 * knows, and its id.
 */
function mergeResumedAnswers(messages: readonly UIMessage[]): UIMessage[] {
	return messages.reduce<UIMessage[]>((merged, message) => {
		const previous = merged.at(-1)
		const last = previous?.parts.at(-1)
		const continuesPrevious =
			message.role === 'assistant' &&
			previous?.role === 'assistant' &&
			last !== undefined &&
			isToolUIPart(last) &&
			(last.state === 'output-available' || last.state === 'output-error')

		if (previous && continuesPrevious) {
			merged[merged.length - 1] = {
				...previous,
				parts: [...previous.parts, ...message.parts]
			}
		} else {
			merged.push(message)
		}

		return merged
	}, [])
}

async function findAnswers(
	memory: MastraMemory,
	threadId: string,
	messageIds: readonly string[]
): Promise<MastraDBMessage[]> {
	const { messages } = await (await memoryStore(memory)).listMessagesById({
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
	const store = await mastra.getStorage()?.getStore('observability')

	if (!store) {
		throw new Error('The Mastra instance has no observability storage.')
	}

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
	if (!mastra) {
		throw new Error('Rating answers needs the Mastra instance.')
	}

	return mastra
}

async function memoryStore(memory: MastraMemory): Promise<MemoryStorage> {
	const store = await memory.storage.getStore('memory')

	if (!store) throw new Error('The memory storage has no memory domain.')

	return store
}
