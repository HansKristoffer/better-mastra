import type { MemoryConfig } from '@mastra/core/memory'
import type { MastraCompositeStore } from '@mastra/core/storage'
import { Extractor, Memory } from '@mastra/memory'
import type { LanguageModel } from 'ai'
import { z } from 'zod'

type ModelInstance = Extract<LanguageModel, { specificationVersion: 'v4' }>

/**
 * What a list extractor stores: an object rather than a bare list, so an
 * empty list replaces the previous value where `null` keeps it.
 */
export const EXTRACTED_ITEMS_SCHEMA = z.object({ items: z.array(z.string()) })

/**
 * An observational-memory extractor that keeps a list of short sentences
 * under `thread.metadata.mastra.om.extracted[<kebab-case name>]`.
 */
export function listExtractor(input: {
	name: string
	instructions: string | (() => Promise<string>)
}) {
	return new Extractor({ ...input, schema: EXTRACTED_ITEMS_SCHEMA })
}

/**
 * Unobserved message tokens, by Mastra's own estimate, that make buffered
 * observations replace raw messages; Mastra's default is 30,000. The
 * estimate is about half a chat model's real count, and 15,000 cost 25% less
 * per turn over 64 measured turns with no loss of remembered facts.
 */
export const OBSERVATION_MESSAGE_TOKENS = 15_000

function toModelInstance(model: LanguageModel): ModelInstance {
	// Mastra would resolve a model string through its own router, past the
	// registry's provider settings.
	if (typeof model === 'string' || model.specificationVersion !== 'v4') {
		throw new Error('A memory model must be an AI SDK 7 model instance')
	}
	return model
}

/**
 * Mastra memory in thread scope: message history, no semantic recall or
 * working memory, and - with an `observer` - observational memory whose
 * Observer and Reflector never retry (the model makes one request per call)
 * and let the turn go on when they fail. `options` is merged over the preset.
 */
export function createMemory(input: {
	storage: MastraCompositeStore
	/** Turns observational memory on. */
	observer?: LanguageModel
	/** Defaults to the observer. */
	reflector?: LanguageModel
	observerMaxOutputTokens?: number
	reflectorMaxOutputTokens?: number
	observationMessageTokens?: number
	// biome-ignore lint/suspicious/noExplicitAny: extractors may use any schema
	extract?: Extractor<any>[]
	/** Retries of the Observer and the Reflector; Mastra defaults to 8. */
	maxRetries?: number
	options?: MemoryConfig
}) {
	const { observer, storage } = input
	const maxRetries = input.maxRetries ?? 0
	const outputCap = (tokens: number | undefined) =>
		tokens ? { modelSettings: { maxOutputTokens: tokens } } : {}

	return new Memory({
		storage,
		options: {
			semanticRecall: false,
			workingMemory: { enabled: false },
			...(observer
				? {
						observationalMemory: {
							activateAfterIdle: 'auto',
							temporalMarkers: true,
							retrieval: false,
							observation: {
								model: toModelInstance(observer),
								messageTokens:
									input.observationMessageTokens ?? OBSERVATION_MESSAGE_TOKENS,
								...outputCap(input.observerMaxOutputTokens),
								maxRetries,
								failurePolicy: 'continue',
								...(input.extract ? { extract: input.extract } : {})
							},
							reflection: {
								model: toModelInstance(input.reflector ?? observer),
								...outputCap(input.reflectorMaxOutputTokens),
								maxRetries,
								failurePolicy: 'continue'
							}
						}
					}
				: {}),
			...input.options
		}
	})
}
