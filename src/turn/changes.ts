/**
 * The changes waiting for the user in one thread, and what a chat request does
 * with them: resume a suspended tool call, answer approvals, or move on from
 * them with a new message. A run id or approval id comes from the client and
 * Mastra loads a suspended run by its id alone, so a request may answer only
 * what waits in the caller's own thread. A new message declines what waits
 * before it runs.
 */

import type { Agent, AgentRun, AgentRunToolCall } from '@mastra/core/agent'
import type { RequestContext } from '@mastra/core/request-context'
import { isToolUIPart, type UIMessage } from 'ai'
import { sortBy, typedSwitch } from 'hanzio'

import type { ChatResume, ThreadKey } from './types.js'

/** A change waiting for the user, found with `listSuspendedRuns`. */
export type PendingChange =
	| {
			readonly kind: 'approval'
			readonly runId: string
			readonly toolCallId: string
			readonly toolName: string
			/** The id the client answers with `addToolApprovalResponse`. */
			readonly approvalId: string
	  }
	| {
			/** A tool that suspended its run, with what it suspended with. */
			readonly kind: 'suspended'
			readonly runId: string
			readonly toolCallId: string
			readonly toolName: string
			readonly payload: unknown
	  }

/** How the request relates to the changes waiting in the thread. */
export type TurnChanges =
	/** The user answered a suspended tool call: the run resumes with their data. */
	| { readonly kind: 'resume'; readonly resume: ChatResume }
	/** The trailing message answers waiting approvals; Mastra resumes their runs from it. */
	| { readonly kind: 'approvalAnswers' }
	/** A new user message: everything waiting is declined first. */
	| { readonly kind: 'newMessage'; readonly waiting: readonly PendingChange[] }
	/** A client tool's result, or a request with nothing waiting to answer. */
	| { readonly kind: 'continuation' }
	/** The request answers something that does not wait in the caller's thread. */
	| { readonly kind: 'expired' }

/** `@mastra/ai-sdk` names an approval `<runId>::<toolCallId>` and reads its answer back by that id. */
export const APPROVAL_ID_SEPARATOR = '::'

/** What the model reads in place of a declined approval's result when the user wrote a new message instead. */
export const MOVED_ON_REASON =
	'The user did not answer this and wrote a new message instead, so nothing was changed. Do not make this change unless the user asks again.'

/** The approvals and suspended tool calls waiting in one thread, oldest first. */
export async function listPendingChanges(
	agent: Agent,
	key: ThreadKey
): Promise<readonly PendingChange[]> {
	const { runs } = await agent.listSuspendedRuns({
		threadId: key.threadId,
		resourceId: key.resourceId
	})

	return sortBy(runs, (run) => run.suspendedAt.getTime()).flatMap((run) =>
		run.toolCalls.flatMap((call) => toPendingChange(run, call))
	)
}

/**
 * Classifies the request against the changes waiting in the caller's thread. A
 * resume must name a waiting suspended run, and every answered approval a
 * waiting approval with the same tool call; anything else has expired.
 */
export function classifyTurnChanges(
	request: {
		readonly messages: readonly UIMessage[]
		readonly resume: ChatResume | undefined
	},
	pending: readonly PendingChange[]
): TurnChanges {
	const { resume } = request

	if (resume !== undefined) {
		const isWaiting = pending.some(
			(change) =>
				change.kind === 'suspended' &&
				change.runId === resume.runId &&
				(resume.toolCallId === undefined ||
					change.toolCallId === resume.toolCallId)
		)

		return isWaiting ? { kind: 'resume', resume } : { kind: 'expired' }
	}

	const answers = answeredApprovals(request.messages)

	if (answers.length > 0) {
		return answers.every((answer) => isWaitingApproval(answer, pending))
			? { kind: 'approvalAnswers' }
			: { kind: 'expired' }
	}

	return request.messages.at(-1)?.role === 'user'
		? { kind: 'newMessage', waiting: pending }
		: { kind: 'continuation' }
}

/**
 * Declines every waiting approval with the moved-on reason and resumes every
 * suspended tool call with `movedOnData`, one after another, each with this
 * turn's request context, so nothing waits when the new message runs. A
 * change that stopped waiting meanwhile is reported and left.
 */
export async function moveOnFromWaitingChanges(
	waiting: readonly PendingChange[],
	run: {
		readonly agent: Agent
		readonly memory: { readonly thread: string; readonly resource: string }
		readonly requestContext: RequestContext
		readonly signal: AbortSignal
		readonly movedOnData?: (change: PendingChange) => Record<string, unknown>
		readonly onError?: (error: unknown, change: PendingChange) => void
	}
): Promise<void> {
	// One step: Mastra stores the call with its reason or result and stops,
	// before the model writes an answer the user would never see.
	const options = {
		memory: run.memory,
		requestContext: run.requestContext,
		abortSignal: run.signal,
		maxSteps: 1
	}

	for (const change of waiting) {
		try {
			const output = await typedSwitch(change, 'kind', {
				approval: (approval) =>
					run.agent.declineToolCall({
						...options,
						runId: approval.runId,
						toolCallId: approval.toolCallId,
						reason: MOVED_ON_REASON
					}),
				suspended: (suspended) =>
					run.agent.resumeStream(
						run.movedOnData?.(suspended) ?? { kind: 'movedOn' },
						{
							...options,
							runId: suspended.runId,
							toolCallId: suspended.toolCallId
						}
					)
			})

			await output.consumeStream()
		} catch (error) {
			run.onError?.(error, change)
		}
	}
}

function toPendingChange(
	run: AgentRun,
	call: AgentRunToolCall
): PendingChange[] {
	const { toolCallId, toolName } = call

	if (toolCallId === undefined || toolName === undefined) {
		return []
	}

	return call.requiresApproval
		? [
				{
					kind: 'approval',
					runId: run.runId,
					toolCallId,
					toolName,
					approvalId: `${run.runId}${APPROVAL_ID_SEPARATOR}${toolCallId}`
				}
			]
		: [
				{
					kind: 'suspended',
					runId: run.runId,
					toolCallId,
					toolName,
					payload: call.suspendPayload
				}
			]
}

/** Every approval the messages answer, as `@mastra/ai-sdk` reads them: from every assistant message. */
function answeredApprovals(
	messages: readonly UIMessage[]
): readonly { readonly approvalId: string; readonly toolCallId: string }[] {
	return messages.flatMap((message) =>
		message.role === 'assistant'
			? message.parts.flatMap((part) =>
					isToolUIPart(part) && part.state === 'approval-responded'
						? [{ approvalId: part.approval.id, toolCallId: part.toolCallId }]
						: []
				)
			: []
	)
}

function isWaitingApproval(
	answer: { readonly approvalId: string; readonly toolCallId: string },
	pending: readonly PendingChange[]
): boolean {
	return pending.some(
		(change) =>
			change.kind === 'approval' &&
			change.approvalId === answer.approvalId &&
			change.toolCallId === answer.toolCallId
	)
}
