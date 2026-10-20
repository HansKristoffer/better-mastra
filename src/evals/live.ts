/**
 * Live scoring: judge a share of real turns with the offline rubric, so the
 * numbers a dashboard trends are the ones a PR's eval table shows. Run it in
 * a background job, never on the turn. For scoring inside the agent itself,
 * Mastra's scorer entries take `sampling: { type: 'ratio', rate }`.
 */
import { isTextUIPart, isToolUIPart, type UIMessage } from 'ai'
import { toEvalToolCall } from './run.js'

/** Whether to score a finished turn: a `share` of them, never in an excluded scope (your own test org). */
export function shouldScore(input: {
	share: number
	scope?: string
	exclude?: readonly string[]
	random?: number
}) {
	if (input.scope !== undefined && input.exclude?.includes(input.scope))
		return false
	return (input.random ?? Math.random()) < input.share
}

function text(message: UIMessage) {
	return message.parts
		.flatMap((part) => (isTextUIPart(part) ? [part.text] : []))
		.join('')
		.trim()
}

/** The thread's newest turn: the last user message and everything the assistant did after it. */
export function newestTurn(messages: readonly UIMessage[]) {
	const userIndex = messages.map((message) => message.role).lastIndexOf('user')
	const user = messages[userIndex]
	if (!user) return null
	const answer = messages
		.slice(userIndex + 1)
		.filter((message) => message.role === 'assistant')
	const tools = answer.flatMap((message) => message.parts).filter(isToolUIPart)
	const toolCalls = tools.map((part) => toEvalToolCall(part as never))
	return {
		assistantMessageId: answer.at(-1)?.id ?? null,
		userText: text(user),
		replyText: answer.map(text).join('\n').trim(),
		toolCalls,
		heldForApproval: toolCalls
			.filter((call) => call.state === 'approval-requested')
			.map((call) => call.name),
		error: null
	}
}
