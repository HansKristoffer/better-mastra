/**
 * Tool input schemas as Mastra takes them (a Standard Schema with JSON Schema
 * attached): a zod input described with every date as an ISO string, and any
 * schema with its hidden inputs removed. Validation checks the model's input
 * with the original schema but hands the raw input on, so a procedure parses
 * and transforms it once.
 */

import type { StandardSchemaWithJSON } from '@mastra/core/schema'
import { z } from 'zod'

type JsonSchema = Record<string, unknown>

interface ValidationIssue {
	readonly message: string
	readonly path?:
		| ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>
		| undefined
}

type ValidationResult =
	| { readonly value: unknown; readonly issues?: undefined }
	| { readonly issues: readonly ValidationIssue[]; readonly value?: undefined }

/** A Standard Schema with JSON Schema attached, the form Mastra accepts as a tool input. */
export type ToolInputSchema = StandardSchemaWithJSON<unknown>

/** An ISO datetime that ends in an offset such as `+02:00`, or in no zone at all, not `Z`. */
const NON_UTC_DATETIME = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-]\d{2}:?\d{2})?$/

/**
 * A zod object input as a tool input: `z.date()` offered as an ISO string and
 * coerced back before validation, and with `maxArrayItems` every list capped.
 * Throws for an input that is not an object, a programming error.
 */
export function toolInputSchema(
	schema: z.ZodType,
	options: { readonly maxArrayItems?: number | undefined } = {}
): ToolInputSchema {
	const jsonSchema = toToolJsonSchema(schema, options.maxArrayItems)

	if (jsonSchema.type !== 'object') {
		throw new Error('A tool must take an object input.')
	}

	return standardSchema(jsonSchema, (value) => {
		const input = coerceDateStrings(schema, value)
		const result = schema['~standard'].validate(input) as
			| ValidationResult
			| Promise<ValidationResult>

		if (result instanceof Promise) {
			throw new Error('A tool input must validate synchronously.')
		}

		const issues = [
			...(result.issues ?? []),
			...findOverlongLists(input, options.maxArrayItems, [])
		]

		return issues.length > 0 ? { issues } : { value: input }
	})
}

/**
 * The schema without the hidden inputs: the model neither sees nor sends
 * them. One the model sends is dropped, and an issue about one is left for
 * the tool, which receives the turn's value.
 */
export function withHiddenInputs(
	schema: ToolInputSchema,
	hiddenInputs: readonly string[],
	options: { readonly maxArrayItems?: number | undefined } = {}
): ToolInputSchema {
	const visible = (jsonSchema: JsonSchema) =>
		withoutHiddenProperties(jsonSchema, hiddenInputs)

	const own = schema['~standard']

	return {
		'~standard': {
			version: 1,
			vendor: own.vendor,
			jsonSchema: {
				input: (jsonOptions) => visible(own.jsonSchema.input(jsonOptions)),
				output: (jsonOptions) => visible(own.jsonSchema.output(jsonOptions))
			},
			validate: (value) => {
				const input = withoutKeys(value, hiddenInputs)
				const finish = (result: ValidationResult): ValidationResult => {
					const own = (result.issues ?? []).filter(
						(issue) => !isHiddenInputIssue(issue, hiddenInputs)
					)
					// A schema from `toolInputSchema` with the same cap already reported the list.
					const issues = [
						...own,
						...findOverlongLists(input, options.maxArrayItems, []).filter(
							(issue) => !own.some((reported) => isSameIssue(reported, issue))
						)
					]

					if (issues.length > 0) return { issues }

					return { value: result.issues ? input : result.value }
				}
				const result = own.validate(input) as
					| ValidationResult
					| Promise<ValidationResult>

				return (
					result instanceof Promise ? result.then(finish) : finish(result)
				) as ReturnType<typeof own.validate>
			}
		}
	}
}

/**
 * The input with each ISO string a `z.date()` field takes turned into a
 * `Date`, and a datetime with an offset or no zone turned into UTC where
 * `z.string().datetime()` refuses offsets. A `Date` stays as it is, so an
 * approved call that comes back from the run's snapshot as JSON passes again.
 */
export function coerceDateStrings(
	schema: z.core.$ZodType,
	value: unknown
): unknown {
	const def = (schema as z.core.$ZodTypes)._zod.def

	switch (def.type) {
		case 'date':
			return typeof value === 'string' && !def.coerce ? new Date(value) : value
		case 'string':
			return typeof value === 'string' && refusesOffsets(def)
				? toUtcDatetime(value)
				: value
		case 'optional':
		case 'nullable':
		case 'default':
		case 'prefault':
		case 'readonly':
			return value === undefined || value === null
				? value
				: coerceDateStrings(def.innerType, value)
		case 'object':
			return isPlainObject(value)
				? Object.fromEntries(
						Object.entries(value).map(([key, field]) => {
							const fieldSchema = def.shape[key]

							return [
								key,
								fieldSchema ? coerceDateStrings(fieldSchema, field) : field
							]
						})
					)
				: value
		case 'array':
			return Array.isArray(value)
				? value.map((item) => coerceDateStrings(def.element, item))
				: value
		default:
			return value
	}
}

function standardSchema(
	jsonSchema: JsonSchema,
	validate: (value: unknown) => ValidationResult
): ToolInputSchema {
	return {
		'~standard': {
			version: 1,
			vendor: 'better-mastra',
			validate: validate as ToolInputSchema['~standard']['validate'],
			jsonSchema: { input: () => jsonSchema, output: () => jsonSchema }
		}
	}
}

// Zod's own export rejects `z.date()`. Model tools send JSON, so a date is an
// ISO string, and a union branch that is a `Date` object is dropped because
// the model can only send its string branch.
function toToolJsonSchema(
	schema: z.ZodType,
	maxArrayItems: number | undefined
): JsonSchema {
	const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema, {
		io: 'input',
		target: 'draft-7',
		unrepresentable: 'any',
		override: ({ zodSchema, jsonSchema: node }) => {
			const def = zodSchema._zod.def

			if (def.type === 'date') {
				node.type = 'string'
				node.format = 'date-time'
			}

			if (def.type === 'array' && maxArrayItems !== undefined) {
				const ownMax =
					typeof node.maxItems === 'number' ? node.maxItems : maxArrayItems

				node.maxItems = Math.min(ownMax, maxArrayItems)
			}

			if (def.type === 'union') {
				const isDateBranch = (index: number) =>
					def.options[index]?._zod.def.type === 'date'

				// Zod writes a union as `anyOf`, or as `oneOf` when it is exclusive.
				for (const keyword of ['anyOf', 'oneOf'] as const) {
					const branches = node[keyword]

					if (Array.isArray(branches)) {
						node[keyword] = branches.filter(
							(_branch, index) => !isDateBranch(index)
						)
					}
				}
			}
		}
	})

	return jsonSchema
}

function withoutHiddenProperties(
	jsonSchema: JsonSchema,
	hiddenInputs: readonly string[]
): JsonSchema {
	const { required, ...rest } = jsonSchema
	const properties = { ...(jsonSchema.properties as JsonSchema | undefined) }

	for (const name of hiddenInputs) {
		delete properties[name]
	}

	const visibleRequired = ((required as string[] | undefined) ?? []).filter(
		(name) => !hiddenInputs.includes(name)
	)

	return {
		...rest,
		properties,
		...(visibleRequired.length > 0 && { required: visibleRequired })
	}
}

/** A list longer than a write may hold, so every change fits one Undo request. */
function findOverlongLists(
	value: unknown,
	maxArrayItems: number | undefined,
	path: readonly PropertyKey[]
): readonly ValidationIssue[] {
	if (maxArrayItems === undefined) return []

	if (Array.isArray(value)) {
		const own: readonly ValidationIssue[] =
			value.length > maxArrayItems
				? [{ message: `At most ${maxArrayItems} items in one change.`, path }]
				: []

		return [
			...own,
			...value.flatMap((item, index) =>
				findOverlongLists(item, maxArrayItems, [...path, index])
			)
		]
	}

	if (isPlainObject(value)) {
		return Object.entries(value).flatMap(([key, item]) =>
			findOverlongLists(item, maxArrayItems, [...path, key])
		)
	}

	return []
}

function isHiddenInputIssue(
	issue: ValidationIssue,
	hiddenInputs: readonly string[]
): boolean {
	const first = issue.path?.[0]
	const key = typeof first === 'object' ? first.key : first

	return typeof key === 'string' && hiddenInputs.includes(key)
}

function withoutKeys(value: unknown, keys: readonly string[]): unknown {
	return isPlainObject(value)
		? Object.fromEntries(
				Object.entries(value).filter(([key]) => !keys.includes(key))
			)
		: value
}

function refusesOffsets(def: z.core.$ZodStringDef): boolean {
	return (def.checks ?? []).some((check) => {
		const checkDef = check._zod.def as {
			readonly format?: string
			readonly offset?: boolean
		}

		return checkDef.format === 'datetime' && !checkDef.offset
	})
}

function toUtcDatetime(value: string): string {
	const date = new Date(value)
	const isNonUtcDatetime =
		NON_UTC_DATETIME.test(value) && !Number.isNaN(date.getTime())

	return isNonUtcDatetime ? date.toISOString() : value
}

function isPlainObject(
	value: unknown
): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSameIssue(
	left: { readonly message: string; readonly path?: unknown },
	right: { readonly message: string; readonly path?: unknown }
): boolean {
	return (
		left.message === right.message &&
		JSON.stringify(left.path ?? []) === JSON.stringify(right.path ?? [])
	)
}
