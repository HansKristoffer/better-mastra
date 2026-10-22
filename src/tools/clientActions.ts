/**
 * Actions the client runs for the agent (open a screen, fill a form). The
 * client sends their definitions with the request; each becomes a Mastra tool
 * without `execute`, passed as the turn's `clientTools`, so its call streams
 * to the client, which answers with `addToolOutput`. The server never
 * interprets the name.
 */

import { createTool } from '@mastra/core/tools'
import type { JSONSchema7 } from 'json-schema'
import { z } from 'zod'
import { keyBy, mapValues } from 'hanzio'

export const clientToolDefSchema = z.object({
	name: z.string().min(1),
	description: z.string().min(1),
	/** The action's input as JSON Schema, so the model sees typed parameters. */
	jsonSchema: z.record(z.string(), z.unknown()),
	requiresApproval: z.boolean().optional()
})

export type ClientToolDef = z.infer<typeof clientToolDefSchema>

const PERMISSIVE_OBJECT_SCHEMA: JSONSchema7 = {
	type: 'object',
	properties: {},
	additionalProperties: true
}

export function buildClientActionTools(
	definitions: readonly ClientToolDef[]
): Record<string, ReturnType<typeof createTool>> {
	return mapValues(keyBy(definitions, 'name'), (definition) =>
		createTool({
			id: definition.name,
			description: definition.description,
			inputSchema:
				Object.keys(definition.jsonSchema).length > 0
					? (definition.jsonSchema as JSONSchema7)
					: PERMISSIVE_OBJECT_SCHEMA,
			requireApproval: definition.requiresApproval === true
		})
	)
}
