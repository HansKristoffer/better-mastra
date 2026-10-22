import {
	generateObject as aiGenerateObject,
	generateText as aiGenerateText,
	type LanguageModelUsage,
	type ModelMessage,
	NoObjectGeneratedError
} from 'ai'
import type { z } from 'zod'
import { anthropicSafeZodSchema } from '../models/anthropic-safe-schema.js'
import {
	type AiBillingError,
	toAiBillingError
} from '../models/billing-error.js'
import type { ReasoningEffort } from '../models/effort.js'
import {
	BatchUnanswered,
	isBatchingModelCalls
} from '../models/openrouter-batch.js'
import type { LlmRegistry, ResolvedLlm } from '../models/registry.js'
import type { ModelBudget } from './budget.js'
import {
	readStreamTextUsage,
	type RunUsage,
	type StreamTextUsage
} from './stream.js'
import { timeoutSignal } from 'hanzio'

/** One metered model run, handed to the app's sink with the caller's context. */
export type UsageRecord<TContext> = StreamTextUsage & {
	context: TContext
	modelId: string
	route: string
	/** Null when unknown, never zero. */
	costUsd: number | null
	/** Priced from the pricing table rather than reported by the provider. */
	costEstimated: boolean
	/** Round trips to the provider (steps); null when the steps were lost. */
	providerCalls: number | null
	finishReason: string | null
	/** Wall time of a generate call, retries included; absent for streams. */
	durationMs?: number
	/** Answered by the route's batch endpoint, at its batch price. */
	batched: boolean
	/** The version of the instructions and tools the run used, so a change that breaks the cache shows in the numbers. */
	promptVersion?: string
	/** Anything else the caller wants on the row. */
	metadata?: Record<string, unknown>
}

/** Where usage goes (a database row, an analytics event). Its errors are swallowed. */
export type UsageSink<TContext> = (
	record: UsageRecord<TContext>
) => void | Promise<void>

type CallModel = {
	model: ResolvedLlm['model']
	providerOptions?: NonNullable<ResolvedLlm['providerOptions']>
}

type GenerateResult = {
	usage: LanguageModelUsage
	finishReason?: string
	/** `generateText` has steps; a `generateObject` result is its one step. */
	steps?: readonly unknown[]
}

/**
 * A model through OpenRouter sometimes wraps the object in a code fence or
 * prose, which the SDK reports as "could not parse the response". The
 * outermost JSON object is the answer.
 */
async function repairObjectText({ text }: { text: string }) {
	const start = text.indexOf('{')
	const end = text.lastIndexOf('}')
	return start >= 0 && end > start ? text.slice(start, end + 1) : null
}

/** "No object generated" alone cannot tell a cut-off answer from an empty one. */
const NO_OBJECT_TEXT_PREVIEW_CHARS = 120

function withNoObjectDetails(error: unknown) {
	if (NoObjectGeneratedError.isInstance(error)) {
		const textPreview = JSON.stringify(
			error.text?.slice(0, NO_OBJECT_TEXT_PREVIEW_CHARS) ?? ''
		)
		const details = [
			`finishReason=${error.finishReason ?? 'unknown'}`,
			`text=${error.text?.length ?? 0} chars ${textPreview}`,
			`outputTokens=${error.usage?.outputTokens ?? 'unknown'}`,
			`reasoningTokens=${error.usage?.outputTokenDetails?.reasoningTokens ?? 'unknown'}`
		]
		error.message = `${error.message} (${details.join(', ')})`
	}
	return error
}

/** The provider ended the stream early: a partial object, finish reason `other`, no usage. */
function isCutOffAnswer(error: unknown) {
	return (
		NoObjectGeneratedError.isInstance(error) &&
		error.finishReason === 'other' &&
		!error.usage?.outputTokens
	)
}

/** The caller's signal, bounded by `timeoutMs` when set. Each attempt gets the full budget. */
function callSignal(signal: AbortSignal | undefined, timeoutMs?: number) {
	if (!timeoutMs) return signal
	return timeoutSignal(timeoutMs, signal)
}

type CallOptions<TContext> = {
	/** A registry id, `route/model@effort`. */
	model: string
	system?: string
	abortSignal?: AbortSignal
	/**
	 * Output cap. Set it on any call whose answer can be long: a provider
	 * default that cuts the JSON short surfaces here as a parse error.
	 */
	maxOutputTokens?: number
	/**
	 * How much the model may think. Leave unset on Anthropic models, where an
	 * effort switches extended thinking on.
	 */
	reasoning?: ReasoningEffort
	/** Set `0` where the output feeds the next call's prompt. */
	temperature?: number
	/** Bounds each direct attempt; a batch wait has none (the batch window bounds it). */
	timeoutMs?: number
	/** Passed to the sink with the record: who pays, which feature. */
	usage: TContext
} & RecordExtras

type RecordExtras = {
	promptVersion?: string | undefined
	metadata?: Record<string, unknown> | undefined
}

function extras({ promptVersion, metadata }: RecordExtras) {
	return {
		...(promptVersion ? { promptVersion } : {}),
		...(metadata ? { metadata } : {})
	}
}

/**
 * `generateText`, `generateObject` and stream metering that report every run
 * to `sink` with its tokens and cost, read the way the model's route reports
 * it. Inside `withLlmMode('batch')` batchable calls go through the route's
 * batch endpoint first and direct when the batch does not answer. A 402 is
 * rethrown as `AiBillingError` after `onBillingError`, so a job can fail
 * visibly instead of finishing with work pending.
 */
export function withUsage<TContext>(input: {
	llms: LlmRegistry
	sink: UsageSink<TContext>
	/** Admission for direct provider calls (`createModelBudget`). */
	budget?: ModelBudget
	onBillingError?: (error: AiBillingError, context: TContext) => void
}) {
	const { llms, sink, budget } = input

	function report(
		record: Omit<UsageRecord<TContext>, 'costUsd' | 'costEstimated'>,
		steps: PromiseLike<readonly unknown[]> | readonly unknown[] | null
	) {
		void llms
			.cost({
				modelId: record.modelId,
				steps,
				usage: {
					inputTokens: record.inputTokens,
					outputTokens: record.outputTokens,
					cachedInputTokens: record.cacheReadTokens,
					cacheWriteTokens: record.cacheWriteTokens
				}
			})
			.then((cost) =>
				sink({ ...record, costUsd: cost.usd, costEstimated: cost.estimated })
			)
			.catch(() => undefined)
	}

	function reportGenerate(
		context: TContext,
		modelId: string,
		result: GenerateResult,
		durationMs: number,
		batched: boolean,
		recordExtras: RecordExtras
	) {
		const usage = readStreamTextUsage(result.usage)
		if (!usage) return
		const steps = result.steps ?? [result]
		report(
			{
				...usage,
				context,
				modelId,
				route: llms.parseModelId(modelId).route,
				providerCalls: steps.length,
				finishReason: result.finishReason ?? null,
				durationMs: Math.round(durationMs),
				batched,
				...extras(recordExtras)
			},
			steps
		)
	}

	function rethrowAiFailure(error: unknown, context: TContext): never {
		const billing = toAiBillingError(error)
		if (!billing) throw error
		input.onBillingError?.(billing, context)
		throw billing
	}

	async function generate<T>(call: {
		model: string
		reasoning: ReasoningEffort | undefined
		signal: AbortSignal | undefined
		timeoutMs: number | undefined
		batchable: boolean
		retry?: boolean
		run: (llm: CallModel, signal: AbortSignal | undefined) => Promise<T>
	}) {
		const resolve = { reasoning: call.reasoning }
		const llmArgs = (
			llm: Omit<ResolvedLlm, 'modelId' | 'route'>
		): CallModel => ({
			model: llm.model,
			...(llm.providerOptions ? { providerOptions: llm.providerOptions } : {})
		})

		const batchLlm =
			call.batchable && isBatchingModelCalls()
				? llms.resolveBatchLlm(call.model, resolve)
				: null
		if (batchLlm) {
			try {
				const result = await call.run(llmArgs(batchLlm), call.signal)
				return { result, batched: true }
			} catch (error) {
				if (!(error instanceof BatchUnanswered)) throw error
			}
		}

		const direct = () =>
			call.run(
				llmArgs(llms.resolveLlm(call.model, resolve)),
				callSignal(call.signal, call.timeoutMs)
			)
		const result = budget
			? await budget.runProviderCall(direct, {
					provider: llms.parseModelId(call.model).route,
					signal: call.signal,
					retry: call.retry ?? false
				})
			: await direct()
		return { result, batched: false }
	}

	/** `generateObject` with an Anthropic-safe schema, JSON repair and one retry of a cut-off answer. */
	async function generateObject<SCHEMA extends z.ZodTypeAny>(
		options: CallOptions<TContext> & { schema: SCHEMA; prompt: string }
	) {
		const {
			usage: context,
			schema,
			model,
			reasoning,
			timeoutMs,
			maxOutputTokens,
			promptVersion,
			metadata,
			...rest
		} = options
		const call = (retry = false) =>
			generate({
				model,
				reasoning,
				signal: rest.abortSignal,
				timeoutMs,
				batchable: true,
				retry,
				run: (llm, abortSignal) =>
					aiGenerateObject({
						...rest,
						...(abortSignal ? { abortSignal } : {}),
						...(maxOutputTokens ? { maxOutputTokens } : {}),
						...llm,
						schema: anthropicSafeZodSchema(schema),
						experimental_repairText: repairObjectText
					})
			})
		const startedAt = performance.now()
		const { result, batched } = await call()
			.catch((error: unknown) =>
				isCutOffAnswer(error) ? call(true) : Promise.reject(error)
			)
			.catch((error: unknown) =>
				rethrowAiFailure(withNoObjectDetails(error), context)
			)
		reportGenerate(
			context,
			model,
			result,
			performance.now() - startedAt,
			batched,
			{ promptVersion, metadata }
		)
		return result
	}

	/** `generateText`; multimodal input goes through `messages` and is never batched. */
	async function generateText(
		options: CallOptions<TContext> &
			(
				| { prompt: string; messages?: undefined }
				| { prompt?: undefined; messages: ModelMessage[] }
			)
	) {
		const {
			usage: context,
			model,
			prompt,
			messages,
			reasoning,
			timeoutMs,
			maxOutputTokens,
			promptVersion,
			metadata,
			...rest
		} = options
		const startedAt = performance.now()
		const { result, batched } = await generate({
			model,
			reasoning,
			signal: rest.abortSignal,
			timeoutMs,
			// Images ride along as data URLs, which a batch refuses.
			batchable: messages === undefined,
			run: (llm, abortSignal) =>
				aiGenerateText({
					...rest,
					...(abortSignal ? { abortSignal } : {}),
					...(maxOutputTokens ? { maxOutputTokens } : {}),
					...llm,
					...(messages !== undefined ? { messages } : { prompt: prompt ?? '' })
				})
		}).catch((error: unknown) => rethrowAiFailure(error, context))
		reportGenerate(
			context,
			model,
			result,
			performance.now() - startedAt,
			batched,
			{ promptVersion, metadata }
		)
		return result
	}

	/**
	 * Meters a `streamText` or Mastra agent stream once it finishes; never
	 * blocks the turn. An aborted run rejects `totalUsage`: nothing to meter.
	 */
	function meterStream(
		stream: {
			totalUsage: PromiseLike<RunUsage | undefined>
			steps?: PromiseLike<readonly unknown[]>
		},
		call: { model: string; usage: TContext } & RecordExtras
	) {
		void Promise.resolve(stream.totalUsage)
			.then(async (totalUsage) => {
				const usage = readStreamTextUsage(totalUsage)
				if (!usage) return
				const steps = stream.steps ? await settledSteps(stream.steps) : null
				report(
					{
						...usage,
						context: call.usage,
						modelId: call.model,
						route: llms.parseModelId(call.model).route,
						providerCalls: steps?.length ?? null,
						finishReason: null,
						batched: false,
						...extras(call)
					},
					steps
				)
			})
			.catch(() => undefined)
	}

	return { generateObject, generateText, meterStream }
}

/** Null rather than throwing: the tokens are known, and losing the row would cost money. */
async function settledSteps(steps: PromiseLike<readonly unknown[]>) {
	try {
		return await steps
	} catch {
		return null
	}
}
