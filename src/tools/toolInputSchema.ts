/**
 * Tool input schemas as Mastra takes them (a Standard Schema with JSON Schema
 * attached): a zod input described with every date as an ISO string and
 * without the regular expressions zod writes for a string format, and any
 * schema with its hidden inputs removed. Validation checks the model's input
 * with the original schema but hands the raw input on, so a procedure parses
 * and transforms it once.
 */

import type { StandardSchemaWithJSON } from '@mastra/core/schema'
import type { Tool } from '@mastra/core/tools'
import {
	isRecord,
	mapValues,
	omit,
	typedSwitch,
	typedSwitchGroup
} from 'hanzio'
import { z } from 'zod'
import {
	compactJsonSchema,
	DATE_FORMATS,
	NAMED_FORMATS
} from '../protocol/jsonSchema.js'

export { compactJsonSchema }

// biome-ignore lint/suspicious/noExplicitAny: any Mastra tool, whatever its schemas.
type AnyTool = Tool<any, any, any, any, any, any, any>

/** Schemas whose caller explicitly asked for `{ stringChecks: 'full' }` are left untouched by automatic compaction. */
const FULL_STRING_CHECKS = new WeakSet<object>()
const COMPACTED_TOOLS = new WeakMap<AnyTool, AnyTool>()
const COMPACTED_SCHEMAS = new WeakMap<object, ToolInputSchema>()

type JsonSchema = Record<string, unknown>

interface ValidationIssue {
	readonly message: string
	readonly path?:
		ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined
}

type ValidationResult =
	| { readonly value: unknown; readonly issues?: undefined }
	| { readonly issues: readonly ValidationIssue[]; readonly value?: undefined }

/** A Standard Schema with JSON Schema attached, the form Mastra accepts as a tool input. */
export type ToolInputSchema = StandardSchemaWithJSON<unknown>

export interface ToolInputSchemaOptions {
	/** Caps every list, so one change stays one Undo. */
	readonly maxArrayItems?: number | undefined
	/**
	 * What the model is told about a string format. `compact`, the default,
	 * drops the `pattern` zod writes for a standard format (190 characters for
	 * a UUID, 330 for a datetime, on every field, on every request) and the
	 * `format` itself, except a date or time format, which is how the model
	 * knows what to write. `full` sends zod's JSON Schema as it is. Either way
	 * the input is validated with the zod schema.
	 */
	readonly stringChecks?: 'compact' | 'full' | undefined
}

/** An ISO datetime that ends in an offset such as `+02:00`, or in no zone at all, not `Z`. */
const NON_UTC_DATETIME = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-]\d{2}:?\d{2})?$/

/**
 * A zod object input as a tool input: `z.date()` offered as an ISO string and
 * coerced back before validation, string formats described compactly
 * (`stringChecks`), and with `maxArrayItems` every list capped. Throws for an
 * input that is not an object, a programming error.
 */
export function toolInputSchema(
	schema: z.ZodType,
	options: ToolInputSchemaOptions = {}
): ToolInputSchema {
	const jsonSchema = toToolJsonSchema(schema, options)

	if (jsonSchema.type !== 'object') {
		throw new Error('A tool must take an object input.')
	}

	const built = standardSchema(jsonSchema, (value) => {
		const input = coerceDateStrings(schema, value)
		const result = schema['~standard'].validate(input) as
			ValidationResult | Promise<ValidationResult>

		if (result instanceof Promise) {
			throw new Error('A tool input must validate synchronously.')
		}

		const issues = [
			...(result.issues ?? []),
			...findOverlongLists(input, options.maxArrayItems, [])
		]

		return issues.length > 0 ? { issues } : { value: input }
	})

	if (options.stringChecks === 'full') FULL_STRING_CHECKS.add(built)
	return built
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
	const inputCache = new Map<string, JsonSchema>()
	const outputCache = new Map<string, JsonSchema>()
	const own = schema['~standard']
	const cached = (
		cache: Map<string, JsonSchema>,
		produce: (
			jsonOptions: Parameters<typeof own.jsonSchema.input>[0]
		) => JsonSchema,
		jsonOptions: Parameters<typeof own.jsonSchema.input>[0]
	) => {
		const key = `${jsonOptions.target}\0${jsonOptions.libraryOptions ? JSON.stringify(jsonOptions.libraryOptions) : ''}`
		let entry = cache.get(key)
		if (!entry) {
			entry = withoutHiddenProperties(produce(jsonOptions), hiddenInputs)
			cache.set(key, entry)
		}
		return entry
	}

	const wrapped: ToolInputSchema = {
		'~standard': {
			version: 1,
			vendor: own.vendor,
			jsonSchema: {
				input: (jsonOptions) =>
					cached(inputCache, (opts) => own.jsonSchema.input(opts), jsonOptions),
				output: (jsonOptions) =>
					cached(
						outputCache,
						(opts) => own.jsonSchema.output(opts),
						jsonOptions
					)
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
					ValidationResult | Promise<ValidationResult>

				return (
					result instanceof Promise ? result.then(finish) : finish(result)
				) as ReturnType<typeof own.validate>
			}
		}
	}

	if (FULL_STRING_CHECKS.has(schema)) FULL_STRING_CHECKS.add(wrapped)
	return wrapped
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

	return typedSwitch(
		def,
		'type',
		{
			date: (date) =>
				typeof value === 'string' && !date.coerce ? new Date(value) : value,
			string: (string) =>
				typeof value === 'string' && refusesOffsets(string)
					? toUtcDatetime(value)
					: value,
			...typedSwitchGroup(
				def,
				'type',
				['optional', 'nullable', 'default', 'prefault', 'readonly'],
				(wrapper) =>
					value === undefined || value === null
						? value
						: coerceDateStrings(wrapper.innerType, value)
			),
			object: (object) =>
				isRecord(value)
					? mapValues(value, (field, key) => {
							const fieldSchema = object.shape[key]

							return fieldSchema ? coerceDateStrings(fieldSchema, field) : field
						})
					: value,
			array: (array) =>
				Array.isArray(value)
					? value.map((item) => coerceDateStrings(array.element, item))
					: value
		},
		() => value
	)
}

/**
 * Wraps any Standard Schema with JSON Schema (Zod, oRPC `createMastraTool`,
 * `toolInputSchema`, `jsonSchemaInput`) so its emitted JSON Schema is compacted
 * and memoized while keeping its original validator untouched. Respects an
 * explicit `{ stringChecks: 'full' }` opt-out.
 */
export function compactToolInputSchema(
	schema: ToolInputSchema,
	options: { readonly stringChecks?: 'compact' | 'full' | undefined } = {}
): ToolInputSchema {
	if (options.stringChecks === 'full' || FULL_STRING_CHECKS.has(schema)) {
		return schema
	}
	const cached = COMPACTED_SCHEMAS.get(schema)
	if (cached) return cached

	const own = schema['~standard']
	if (!own?.jsonSchema) return schema

	const inputCache = new Map<string, JsonSchema>()
	const outputCache = new Map<string, JsonSchema>()
	const read = (
		cache: Map<string, JsonSchema>,
		fn: (jsonOptions: Parameters<typeof own.jsonSchema.input>[0]) => JsonSchema,
		jsonOptions: Parameters<typeof own.jsonSchema.input>[0]
	) => {
		const key = `${jsonOptions.target}\0${jsonOptions.libraryOptions ? JSON.stringify(jsonOptions.libraryOptions) : ''}`
		let entry = cache.get(key)
		if (!entry) {
			entry = compactJsonSchema(fn(jsonOptions))
			cache.set(key, entry)
		}
		return entry
	}

	const wrapped: ToolInputSchema = {
		'~standard': {
			version: 1,
			vendor: own.vendor,
			validate: (value) => own.validate(value),
			jsonSchema: {
				input: (jsonOptions) =>
					read(inputCache, (opts) => own.jsonSchema.input(opts), jsonOptions),
				output: (jsonOptions) =>
					read(outputCache, (opts) => own.jsonSchema.output(opts), jsonOptions)
			}
		}
	}
	COMPACTED_SCHEMAS.set(schema, wrapped)
	return wrapped
}

/**
 * Returns a memoized copy of any Mastra tool with a compacted JSON input schema
 * (works on `orpc-fn` `createMastraTool`, Zod schemas, and raw JSON schemas)
 * while leaving execution and runtime validation untouched.
 */
export function compactTool<T extends AnyTool>(tool: T): T {
	if (!tool.inputSchema) return tool
	if (FULL_STRING_CHECKS.has(tool.inputSchema as object)) return tool

	let copy = COMPACTED_TOOLS.get(tool)
	if (copy) return copy as T

	const inputSchema = tool.inputSchema as unknown
	let compacted: unknown
	if (
		isRecord(inputSchema) &&
		isRecord(inputSchema['~standard']) &&
		isRecord(inputSchema['~standard'].jsonSchema)
	) {
		compacted = compactToolInputSchema(
			inputSchema as unknown as ToolInputSchema
		)
	} else if (isRecord(inputSchema) && typeof inputSchema.type === 'string') {
		compacted = compactJsonSchema(inputSchema)
	} else {
		return tool
	}

	if (compacted === tool.inputSchema) return tool
	copy = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool, {
		inputSchema: compacted
	}) as AnyTool
	COMPACTED_TOOLS.set(tool, copy)
	return copy as T
}

/**
 * A JSON Schema as a tool input, such as an MCP tool's `inputSchema`. Compacted
 * by default (`stringChecks: 'compact'`); pass `{ stringChecks: 'full' }` to
 * keep every format and pattern as given. It does not validate: the service
 * behind the tool checks its own input.
 */
export function jsonSchemaInput(
	schema: Readonly<Record<string, unknown>>,
	options: { readonly stringChecks?: 'compact' | 'full' | undefined } = {}
): ToolInputSchema {
	const built = standardSchema(compactJsonSchema(schema, options), (value) => ({
		value
	}))
	if (options.stringChecks === 'full') FULL_STRING_CHECKS.add(built)
	return built
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
	{ maxArrayItems, stringChecks = 'compact' }: ToolInputSchemaOptions
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

			if (
				stringChecks === 'compact' &&
				typeof node.format === 'string' &&
				NAMED_FORMATS.includes(node.format)
			) {
				delete node.pattern

				if (!DATE_FORMATS.includes(node.format)) delete node.format
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
	const properties = omit(
		{ ...(jsonSchema.properties as JsonSchema | undefined) },
		hiddenInputs
	)

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

	if (isRecord(value)) {
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
	return isRecord(value) ? omit(value, keys) : value
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

function isSameIssue(
	left: { readonly message: string; readonly path?: unknown },
	right: { readonly message: string; readonly path?: unknown }
): boolean {
	return (
		left.message === right.message &&
		JSON.stringify(left.path ?? []) === JSON.stringify(right.path ?? [])
	)
}
