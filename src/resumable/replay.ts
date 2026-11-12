/**
 * What a replay needs before a turn that goes on with an earlier answer. A
 * reconnecting client builds the answer again from the replay alone, starting
 * empty at its `start`. A turn that continues an answer (an approved change,
 * an applied change plan, a client action's result) streams only what it adds,
 * so its first chunk can be the result of a tool call the replay never
 * started, which the client cannot apply. These are the chunks that rebuild
 * the answer as it was when the request arrived; `ResumableStreams.start`
 * puts them after the replay's `start`, for reconnecting readers only.
 */

import type { UIMessage, UIMessageChunk } from 'ai'

type Part = UIMessage['parts'][number]

/** A tool part of either kind: `tool-<name>` or `dynamic-tool`. */
interface ToolPartLike {
	readonly type: string
	readonly toolCallId: string
	readonly toolName?: string
	readonly state: string
	readonly input?: unknown
	readonly output?: unknown
	readonly errorText?: string
	readonly preliminary?: boolean
	readonly providerExecuted?: boolean
	readonly title?: string
	readonly approval?: {
		readonly id: string
		readonly approved?: boolean
		readonly reason?: string
	}
}

const STATIC_TOOL_PREFIX = 'tool-'

/**
 * The chunks that rebuild the assistant message a request continues: the last
 * message of its body, when that is the assistant's. Empty for a request that
 * ends with the user's message, whose replay is the whole answer already.
 */
export function replayPrefixOf(
	messages: readonly UIMessage[]
): UIMessageChunk[] {
	const continued = messages.at(-1)

	if (continued?.role !== 'assistant') return []

	return continued.parts.flatMap((part, index) => chunksOf(part, index))
}

function chunksOf(part: Part, index: number): UIMessageChunk[] {
	if (isToolPart(part)) return toolChunks(part)

	// The ids only pair a part's own chunks; they never meet the turn's.
	const id = `replay-${index}`

	switch (part.type) {
		case 'text':
			return [
				{ type: 'text-start', id },
				{ type: 'text-delta', id, delta: part.text },
				{ type: 'text-end', id }
			]
		case 'reasoning':
			return [
				{ type: 'reasoning-start', id },
				{ type: 'reasoning-delta', id, delta: part.text },
				{ type: 'reasoning-end', id }
			]
		case 'step-start':
			return [{ type: 'start-step' }]
		case 'file':
		case 'source-url':
		case 'source-document':
			return [part as UIMessageChunk]
		default:
			// A data part is its own chunk; a part of a kind not known here is left out.
			return part.type.startsWith('data-') ? [part as UIMessageChunk] : []
	}
}

/**
 * A tool call as far as it had come. Only a call still waiting for its result
 * is sent as `tool-input-available`, the chunk a client carries a client
 * action out on: a call that has its result must not run a second time.
 */
function toolChunks(part: ToolPartLike): UIMessageChunk[] {
	const { toolCallId } = part
	const call = {
		toolCallId,
		toolName: toolNameOf(part),
		...(part.type === 'dynamic-tool' && { dynamic: true }),
		...(part.providerExecuted !== undefined && {
			providerExecuted: part.providerExecuted
		}),
		...(part.title !== undefined && { title: part.title })
	}

	if (part.state === 'input-available') {
		return [{ type: 'tool-input-available', ...call, input: part.input }]
	}

	const chunks: UIMessageChunk[] = [{ type: 'tool-input-start', ...call }]

	if (part.input !== undefined) {
		chunks.push({
			type: 'tool-input-delta',
			toolCallId,
			inputTextDelta: JSON.stringify(part.input)
		})
	}

	if (part.approval) {
		const { id: approvalId, approved, reason } = part.approval

		chunks.push({ type: 'tool-approval-request', approvalId, toolCallId })

		if (approved !== undefined) {
			chunks.push({
				type: 'tool-approval-response',
				approvalId,
				approved,
				...(reason !== undefined && { reason })
			})
		}
	}

	if (part.state === 'output-available') {
		chunks.push({
			type: 'tool-output-available',
			toolCallId,
			output: part.output,
			...(part.preliminary !== undefined && { preliminary: part.preliminary })
		})
	} else if (part.state === 'output-error') {
		chunks.push({
			type: 'tool-output-error',
			toolCallId,
			errorText: part.errorText ?? ''
		})
	} else if (part.state === 'output-denied') {
		chunks.push({ type: 'tool-output-denied', toolCallId })
	}

	return chunks
}

function isToolPart(part: { readonly type: string }): part is ToolPartLike {
	return (
		part.type === 'dynamic-tool' || part.type.startsWith(STATIC_TOOL_PREFIX)
	)
}

function toolNameOf(part: ToolPartLike): string {
	return part.type === 'dynamic-tool'
		? (part.toolName ?? '')
		: part.type.slice(STATIC_TOOL_PREFIX.length)
}
