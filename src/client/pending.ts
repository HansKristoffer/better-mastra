/**
 * The changes waiting for the user in a thread, and how a loaded thread shows
 * them again: a waiting approval on its tool part, a suspended run as the
 * tool's suspended part, both as the live stream showed them, so their cards
 * redraw and can still be answered after a restart.
 */

import { getToolName, isToolUIPart, type UIMessage } from 'ai'

// TYPES

/** A change waiting for the user in the thread, as the server lists it (Mastra's `listSuspendedRuns`). */
export type PendingChange =
	| {
			readonly kind: 'approval'
			readonly runId: string
			readonly toolCallId: string
			readonly toolName: string
			/** The approval id the app answers with `answerApproval`. */
			readonly approvalId: string
			/** What the tool is about to be called with: confirming a change you cannot see is not consent. */
			readonly input?: unknown
	  }
	| {
			readonly kind: 'suspended'
			readonly runId: string
			readonly toolCallId: string
			readonly toolName: string
			/** The tool's `suspendPayload`: what its card shows while it waits. */
			readonly payload: unknown
	  }

type MessagePart = UIMessage['parts'][number]

type ToolPart = Extract<MessagePart, { readonly toolCallId: string }>

// CONSTANTS

/** The part `@mastra/ai-sdk` streams, and stores, for a tool that suspended its run. */
export const SUSPENDED_PART_TYPE = 'data-tool-call-suspended'

/** `@mastra/ai-sdk` names an approval `<runId>::<toolCallId>`, and reads its answer back by that id. */
export const APPROVAL_ID_SEPARATOR = '::'

// FUNCTIONS

/**
 * The suspended run a message part shows while it waits; undefined for every
 * other part, and for a run the stream already marked `resumed`.
 */
export function readSuspendedRun(
	part: MessagePart
): Extract<PendingChange, { kind: 'suspended' }> | undefined {
	if (part.type !== SUSPENDED_PART_TYPE || !('data' in part)) {
		return undefined
	}

	const data = part.data as Record<string, unknown> | null

	if (
		typeof data !== 'object' ||
		data === null ||
		typeof data.runId !== 'string' ||
		typeof data.toolCallId !== 'string' ||
		typeof data.toolName !== 'string' ||
		data.resumed === true
	) {
		return undefined
	}

	return {
		kind: 'suspended',
		runId: data.runId,
		toolCallId: data.toolCallId,
		toolName: data.toolName,
		payload: data.suspendPayload
	}
}

/**
 * The changes a message leaves waiting for the user, as the turn reducer's
 * `changes-waiting` event takes them: each approval it asks for and each run
 * it shows suspended.
 */
export function readWaitingChanges(message: UIMessage): PendingChange[] {
	return message.parts.flatMap((part): PendingChange[] => {
		const run = readSuspendedRun(part)

		if (run !== undefined) {
			return [run]
		}

		return isToolUIPart(part) && part.state === 'approval-requested'
			? toWaitingApproval(part)
			: []
	})
}

/**
 * The stored messages with each pending change put back as the live stream
 * showed it: a waiting approval on its tool part with its approval id, a
 * suspended run as the tool's suspended part. Cards then redraw, and can be
 * answered, after a restart. A tool call that waited once but is not pending
 * any more is left as stored.
 */
export function rebuildPendingApprovals(
	messages: readonly UIMessage[],
	pendingChanges: readonly PendingChange[]
): UIMessage[] {
	return messages.map((message) =>
		message.role === 'assistant'
			? { ...message, parts: restoreParts(message.parts, pendingChanges) }
			: message
	)
}

/**
 * The tool calls stored messages show waiting that the pending changes do not
 * list: the server cleaned them up, or a deploy broke them. Their cards say
 * so instead of waiting for ever.
 */
export function expiredChanges(
	messages: readonly UIMessage[],
	pendingChanges: readonly PendingChange[]
): ReadonlyMap<string, 'expired'> {
	const listed = new Set(pendingChanges.map((change) => change.toolCallId))

	return new Map(
		messages
			.flatMap((message) => message.parts.flatMap(waitingCallIdOf))
			.filter((toolCallId) => !listed.has(toolCallId))
			.map((toolCallId) => [toolCallId, 'expired'] as const)
	)
}

function waitingCallIdOf(part: MessagePart): string[] {
	const run = readSuspendedRun(part)

	if (run !== undefined) {
		return [run.toolCallId]
	}

	return isToolUIPart(part) &&
		!part.providerExecuted &&
		(part.state === 'input-available' || part.state === 'approval-requested')
		? [part.toolCallId]
		: []
}

function toWaitingApproval(
	part: Extract<ToolPart, { readonly state: 'approval-requested' }>
): PendingChange[] {
	const approvalId = part.approval.id
	const separator = approvalId.lastIndexOf(APPROVAL_ID_SEPARATOR)

	return [
		{
			kind: 'approval',
			runId: separator > 0 ? approvalId.slice(0, separator) : approvalId,
			toolCallId: part.toolCallId,
			toolName: getToolName(part),
			approvalId,
			input: part.input
		}
	]
}

function restoreParts(
	parts: readonly MessagePart[],
	pendingChanges: readonly PendingChange[]
): MessagePart[] {
	return parts.flatMap((part): MessagePart[] => {
		if (part.type === SUSPENDED_PART_TYPE) {
			// Put back right after its tool part, in the live shape.
			return isPendingRunPart(part, pendingChanges) ? [] : [part]
		}

		if (!isToolUIPart(part) || !isWaitingToolPart(part)) {
			return [part]
		}

		const pending = pendingChanges.find((change) =>
			isPendingChangeOf(change, part)
		)

		return pending === undefined ? [part] : restorePart(part, pending)
	})
}

function restorePart(part: ToolPart, pending: PendingChange): MessagePart[] {
	switch (pending.kind) {
		case 'approval':
			return [
				{
					...part,
					state: 'approval-requested',
					approval: { id: pending.approvalId }
				} as MessagePart
			]
		case 'suspended':
			return [part, toSuspendedPart(pending)]
	}
}

/** The part as `@mastra/ai-sdk` streams it while the run waits. */
function toSuspendedPart(
	pending: Extract<PendingChange, { kind: 'suspended' }>
): MessagePart {
	return {
		type: SUSPENDED_PART_TYPE,
		id: pending.toolCallId,
		data: {
			state: SUSPENDED_PART_TYPE,
			runId: pending.runId,
			toolCallId: pending.toolCallId,
			toolName: pending.toolName,
			suspendPayload: pending.payload
		}
	} as MessagePart
}

/** A tool call the run has not finished: waiting for its input, an approval or a resume. */
function isWaitingToolPart(part: ToolPart): boolean {
	return part.state === 'input-available' || part.state === 'approval-requested'
}

function isPendingChangeOf(change: PendingChange, part: ToolPart): boolean {
	if (change.toolCallId !== part.toolCallId) {
		return false
	}

	switch (change.kind) {
		case 'approval':
			return (
				part.approval === undefined || part.approval.id === change.approvalId
			)
		case 'suspended':
			return getToolName(part) === change.toolName
	}
}

function isPendingRunPart(
	part: MessagePart,
	pendingChanges: readonly PendingChange[]
): boolean {
	const data = 'data' in part ? (part.data as { toolCallId?: unknown }) : {}

	return pendingChanges.some(
		(change) =>
			change.kind === 'suspended' && change.toolCallId === data?.toolCallId
	)
}
