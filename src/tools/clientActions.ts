/**
 * Actions the client runs for the agent (open a screen, fill a form). The
 * client sends their definitions with the request; each becomes a Mastra tool
 * without `execute`, passed as the turn's `clientTools`, so its call streams
 * to the client, which answers with `addToolOutput`. The server never
 * interprets the name.
 */

import { createTool } from '@mastra/core/tools'
import type { JSONSchema7 } from 'json-schema'
import { keyBy, mapValues } from 'hanzio'

import { type ClientToolDef, clientToolDefSchema } from '../protocol/index.js'

export { type ClientToolDef, clientToolDefSchema }

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
