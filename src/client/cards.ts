/**
 * The card registry: which card a tool part draws, with its output checked
 * against the card's schema when it is drawn, never trusted. A thread stored
 * before a schema changed still opens: its card falls back to the generic
 * row. Lookups the model makes on its way to an answer are steps, which a
 * client folds into one activity list.
 */

import { getToolName } from 'ai'
import type { z } from 'zod'

import type { ToolPart } from './messages.js'

// TYPES

/** The output schema of each typed card, by kind. */
export type CardSchemas = Readonly<Record<string, z.ZodType>>

/** Which card a tool draws: a typed card, the generic row, or nothing. */
export type CardKindOf<S extends CardSchemas> =
	| (keyof S & string)
	| 'generic'
	| 'silent'

/** What a client draws for one tool part. */
export type Card<S extends CardSchemas> =
	| {
			readonly [K in keyof S & string]:
				| {
						readonly kind: K
						readonly state: 'done'
						readonly data: z.output<S[K]>
						readonly part: ToolPart
				  }
				/** The call has no result yet: a card that shows its input can draw it. */
				| {
						readonly kind: K
						readonly state: 'running'
						readonly part: ToolPart
				  }
	  }[keyof S & string]
	| {
			readonly kind: 'generic'
			readonly toolName: string
			readonly part: ToolPart
	  }
	| { readonly kind: 'silent'; readonly part: ToolPart }

export interface CardRegistryOptions<S extends CardSchemas> {
	/** The output schema each typed card reads. */
	readonly schemas: S
	/** The card a tool draws, by its wire name; undefined for a tool the client does not know, which draws the generic row. */
	readonly toolCard: (toolName: string) => CardKindOf<S> | undefined
	/** The card-ready data inside a tool's output, such as the `projection` of a result envelope. The output as it is when left out. */
	readonly select?: (output: unknown, toolName: string) => unknown
	/** Kinds that are steps, folded into the turn's activity list; `generic` is a step unless listed false. */
	readonly steps?: Partial<Record<CardKindOf<S>, boolean>>
}

export interface CardRegistry<S extends CardSchemas> {
	readonly resolve: (part: ToolPart) => Card<S>
	readonly isStep: (card: Card<S>) => boolean
	/**
	 * Neighbouring tool parts in order, each run of adjacent steps folded into
	 * one `steps` group, even a run of one, so a run keeps its key as it grows.
	 * Silent tools draw nothing and never split a run.
	 */
	readonly fold: (parts: readonly ToolPart[]) => FoldedCards<S>
}

export type FoldedCards<S extends CardSchemas> = readonly (
	| { readonly kind: 'card'; readonly key: string; readonly card: Card<S> }
	| {
			readonly kind: 'steps'
			readonly key: string
			readonly cards: readonly Card<S>[]
	  }
)[]

// FUNCTIONS

export function createCardRegistry<const S extends CardSchemas>(
	options: CardRegistryOptions<S>
): CardRegistry<S> {
	const select = options.select ?? ((output: unknown) => output)

	const resolve = (part: ToolPart): Card<S> => {
		const toolName = getToolName(part)
		const kind = options.toolCard(toolName)

		if (kind === 'silent') {
			return { kind: 'silent', part }
		}

		const schema =
			kind === undefined || kind === 'generic'
				? undefined
				: options.schemas[kind]

		if (kind === undefined || schema === undefined) {
			return { kind: 'generic', toolName, part }
		}

		if (part.state === 'output-error' || part.state === 'output-denied') {
			return { kind: 'generic', toolName, part }
		}

		if (part.state !== 'output-available') {
			return { kind, state: 'running', part } as Card<S>
		}

		const parsed = schema.safeParse(select(part.output, toolName))

		// The schema of `kind` parsed the data, so it is that card's data.
		return parsed.success
			? ({ kind, state: 'done', data: parsed.data, part } as Card<S>)
			: { kind: 'generic', toolName, part }
	}

	const isStep = (card: Card<S>): boolean =>
		(options.steps?.[card.kind] as boolean | undefined) ??
		card.kind === 'generic'

	return {
		resolve,
		isStep,
		fold: (parts) => {
			const folded: (
				| { kind: 'card'; key: string; card: Card<S> }
				| { kind: 'steps'; key: string; cards: Card<S>[] }
			)[] = []

			for (const part of parts) {
				const card = resolve(part)

				if (card.kind === 'silent') {
					continue
				}

				const previous = folded.at(-1)

				if (!isStep(card)) {
					folded.push({ kind: 'card', key: part.toolCallId, card })
				} else if (previous?.kind === 'steps') {
					previous.cards.push(card)
				} else {
					folded.push({ kind: 'steps', key: part.toolCallId, cards: [card] })
				}
			}

			return folded
		}
	}
}
