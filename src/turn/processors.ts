/**
 * The chat agent's processors, each reading the turn plan from the request
 * context: the tool-call budget stop before the first model call, the
 * per-request and last-step signals, and the one retry layer, which retries a
 * failed model call only while it has shown no answer text.
 */

import type { MastraDBMessage, MessageList } from '@mastra/core/agent'
import {
	defaultStabilityErrorProcessors,
	type ProcessAPIErrorArgs,
	type ProcessAPIErrorResult,
	type ProcessInputArgs,
	type ProcessInputStepArgs,
	type ProcessInputStepResult,
	type Processor,
	StreamErrorRetryProcessor
} from '@mastra/core/processors'

import { findTurnPlan } from './types.js'

/** The tripwire reason the app reads when a turn is stopped at the tool-call budget. */
export const TOOL_CALL_BUDGET_STOP_REASON = 'tool_call_budget'

/** Sent on the last step, because a tool call on the last step ends the turn with an empty reply. */
export const LAST_STEP_SIGNAL =
	'This is your last step in this turn. Answer the user now with what you have found, and do not call a tool.'

/**
 * Stops the run before any model call when one user turn has made more than
 * `toolCallsPerStep` times its step budget of tool calls, counted from the
 * trailing assistant message the request carries: a client that answers tool
 * calls resubmits once per round trip, and this is the backstop for one that
 * never stops. The app receives a `data-tripwire` part with the reason.
 */
export class ToolCallBudgetStop implements Processor<'tool-call-budget'> {
	readonly id = 'tool-call-budget'

	constructor(readonly toolCallsPerStep = 3) {}

	processInput({
		messageList,
		requestContext,
		abort
	}: ProcessInputArgs): MessageList {
		const plan = requestContext && findTurnPlan(requestContext)
		const toolCalls = toolCallsInTurn(messageList.get.input.db())

		if (plan && toolCalls > plan.maxSteps * this.toolCallsPerStep) {
			abort(TOOL_CALL_BUDGET_STOP_REASON)
		}

		return messageList
	}
}

/**
 * The plan's per-request signal as a transient signal on the first step, which
 * the model sees for the whole run and the thread never stores; on the last
 * step, the order to answer now and no tool to call.
 */
export class TurnSignals implements Processor<'turn-signals'> {
	readonly id = 'turn-signals'

	async processInputStep({
		stepNumber,
		requestContext,
		sendSignal
	}: ProcessInputStepArgs): Promise<ProcessInputStepResult | undefined> {
		const plan = requestContext && findTurnPlan(requestContext)

		if (!plan || !sendSignal) {
			return undefined
		}

		if (stepNumber === 0 && plan.signal) {
			await sendSignal({
				type: 'reactive',
				contents: plan.signal,
				transient: true
			})
		}

		if (stepNumber < plan.maxSteps - 1) {
			return undefined
		}

		await sendSignal({
			type: 'reactive',
			contents: LAST_STEP_SIGNAL,
			transient: true
		})

		return { toolChoice: 'none' }
	}
}

/**
 * Mastra's own stream error retry, in its place among the default error
 * processors, used only while the failing step has streamed no answer text.
 * The app cannot take back text it has shown, so a retry after that would show
 * the answer's start twice; the step fails with the fixed error sentence.
 */
export class RetryBeforeAnswerText
	implements Processor<'stream-error-retry-processor'>
{
	readonly id = 'stream-error-retry-processor'
	readonly #retry = defaultStreamErrorRetry()

	async processAPIError(
		args: ProcessAPIErrorArgs
	): Promise<ProcessAPIErrorResult | undefined> {
		if (hasStreamedAnswerText(args.messageList)) {
			return { retry: false }
		}

		return (await this.#retry.processAPIError(args)) ?? undefined
	}
}

function toolCallsInTurn(inputMessages: readonly MastraDBMessage[]): number {
	const trailing = inputMessages.at(-1)

	if (trailing?.role !== 'assistant') {
		return 0
	}

	return trailing.content.parts.filter(
		(part) => part.type === 'tool-invocation'
	).length
}

function hasStreamedAnswerText(messageList: MessageList): boolean {
	const parts = messageList.get.response.db().at(-1)?.content.parts ?? []
	// `map` + `lastIndexOf`: the build targets ES2022, which has no `findLastIndex`.
	const stepStart = parts
		.map((part) => part.type === 'step-start')
		.lastIndexOf(true)

	return parts
		.slice(stepStart + 1)
		.some((part) => part.type === 'text' && part.text.length > 0)
}

function defaultStreamErrorRetry(): StreamErrorRetryProcessor {
	const retry = defaultStabilityErrorProcessors().find(
		(processor): processor is StreamErrorRetryProcessor =>
			processor instanceof StreamErrorRetryProcessor
	)

	if (!retry) {
		throw new Error(
			"Mastra's default error processors no longer include its stream error retry."
		)
	}

	return retry
}
