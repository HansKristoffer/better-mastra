import { type JSONSchema7, type Schema, zodSchema } from 'ai'
import type { z } from 'zod'
import { mapValues, typedEntries } from 'hanzio'

const NUMBER_BOUNDS = [
	'minimum',
	'maximum',
	'exclusiveMinimum',
	'exclusiveMaximum'
] as const

type JsonSchemaType = 'integer' | 'number' | 'array' | 'object'

/** Keys Anthropic rejects on structured-output JSON Schema, keyed by `type`. */
const STRIP = {
	integer: NUMBER_BOUNDS,
	number: NUMBER_BOUNDS,
	array: ['minItems', 'maxItems'],
	// z.record() emits propertyNames; Anthropic rejects it (e.g. session result metadata).
	object: ['propertyNames', 'minProperties', 'maxProperties']
} as const satisfies Record<JsonSchemaType, readonly string[]>

/**
 * Strip JSON Schema constraints Anthropic rejects. Zod still validates the
 * parsed object - only the schema sent to the model is loosened.
 */
function stripUnsupported(value: unknown): unknown {
	if (value === null || typeof value !== 'object') return value
	if (Array.isArray(value)) return value.map(stripUnsupported)

	const node: Record<string, unknown> = mapValues(value, stripUnsupported)

	const type = node.type
	for (const [kind, keys] of typedEntries(STRIP)) {
		const match = type === kind || (Array.isArray(type) && type.includes(kind))
		if (!match) continue
		for (const key of keys) delete node[key]
	}

	return node
}

/** Keep Zod validation; strip unsupported JSON Schema before the model call. */
export function anthropicSafeZodSchema<SCHEMA extends z.ZodTypeAny>(
	schema: SCHEMA
): Schema<z.infer<SCHEMA>> {
	const wrapped = zodSchema(schema)
	return {
		...wrapped,
		jsonSchema: stripUnsupported(wrapped.jsonSchema) as JSONSchema7
	} as Schema<z.infer<SCHEMA>>
}
