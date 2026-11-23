/**
 * Pure JSON Schema compaction shared by server tools (`better-mastra/tools`)
 * and client actions (`better-mastra/client`) without pulling in Mastra.
 */

import { isRecord } from 'hanzio'

export type JsonSchemaObject = Record<string, unknown>

/** The formats that tell the model what string to write. */
export const DATE_FORMATS: readonly string[] = [
	'date-time',
	'date',
	'time',
	'duration'
]

/**
 * Standard formats whose `pattern` only repeats the format's name as a
 * regular expression (190 chars for UUID, 330 for datetime). Author-written
 * patterns (`.regex()`, `.startsWith()`) and custom id patterns stay.
 */
export const NAMED_FORMATS: readonly string[] = [
	...DATE_FORMATS,
	'uuid',
	'email',
	'uri',
	'ipv4',
	'ipv6'
]

/**
 * Strips `$schema` and, unless `stringChecks` is `'full'`, removes verbose
 * `pattern` regexes for named string formats and non-date `format` names
 * across the entire schema tree.
 */
export function compactJsonSchema(
	schema: Readonly<JsonSchemaObject>,
	options: { readonly stringChecks?: 'compact' | 'full' | undefined } = {}
): JsonSchemaObject {
	const { $schema: _, ...withoutMeta } = schema
	if (options.stringChecks === 'full') return withoutMeta
	return compactSchemaNode(withoutMeta)
}

function compactSchemaNode(node: Readonly<JsonSchemaObject>): JsonSchemaObject {
	const next: JsonSchemaObject = {}

	for (const [key, value] of Object.entries(node)) {
		if (key === '$schema') continue

		if (
			(key === 'properties' ||
				key === '$defs' ||
				key === 'definitions' ||
				key === 'dependentSchemas' ||
				key === 'patternProperties') &&
			isRecord(value)
		) {
			const mapped: JsonSchemaObject = {}
			for (const [propKey, propVal] of Object.entries(value)) {
				mapped[propKey] = isRecord(propVal)
					? compactSchemaNode(propVal)
					: propVal
			}
			next[key] = mapped
			continue
		}

		if (
			(key === 'anyOf' ||
				key === 'oneOf' ||
				key === 'allOf' ||
				key === 'prefixItems') &&
			Array.isArray(value)
		) {
			next[key] = value.map((item) =>
				isRecord(item) ? compactSchemaNode(item) : item
			)
			continue
		}

		if (
			(key === 'items' ||
				key === 'additionalProperties' ||
				key === 'not' ||
				key === 'if' ||
				key === 'then' ||
				key === 'else') &&
			isRecord(value)
		) {
			next[key] = compactSchemaNode(value)
			continue
		}

		next[key] = value
	}

	if (typeof next.format === 'string' && NAMED_FORMATS.includes(next.format)) {
		delete next.pattern
		if (!DATE_FORMATS.includes(next.format)) delete next.format
	}

	return next
}
