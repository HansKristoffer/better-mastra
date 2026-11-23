/**
 * Actions the client runs for the agent (open a screen, fill a form). The
 * client sends their definitions with the request; each becomes a Mastra tool
 * without `execute`, passed as the turn's `clientTools`, so its call streams
 * to the client, which answers with `addToolOutput`. The server never
 * interprets the name.
 *
 * When a user navigates across pages with different actions, mounting one tool
 * per action changes the `tools` list and busts the provider's prompt cache.
 * `createClientActionDispatcherTool` + `formatClientActionsSignal` avoid that:
 * the agent keeps one fixed `run_page_action` tool, and the current page's
 * available actions travel in `plan.signal` after the cached prefix.
 */

import { createTool } from '@mastra/core/tools'
import type { JSONSchema7 } from 'json-schema'
import { keyBy, mapValues } from 'hanzio'

import {
	CLIENT_ACTION_DISPATCHER_TOOL,
	type ClientToolDef,
	clientToolDefSchema
} from '../protocol/index.js'
import { compactJsonSchema } from './toolInputSchema.js'

export {
	CLIENT_ACTION_DISPATCHER_TOOL,
	type ClientToolDef,
	clientToolDefSchema
}

const PERMISSIVE_OBJECT_SCHEMA: JSONSchema7 = {
	type: 'object',
	properties: {},
	additionalProperties: true
}

const DISPATCHER_INPUT_SCHEMA: JSONSchema7 = {
	type: 'object',
	properties: {
		action: {
			type: 'string',
			description: 'Name of the page action listed in the current page signal.'
		},
		input: {
			type: 'object',
			additionalProperties: true,
			description: 'Arguments matching the chosen action schema.'
		}
	},
	required: ['action'],
	additionalProperties: false
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
					? (compactJsonSchema(definition.jsonSchema) as JSONSchema7)
					: PERMISSIVE_OBJECT_SCHEMA,
			requireApproval: definition.requiresApproval === true
		})
	)
}

/**
 * One fixed client tool (`run_page_action`) whose schema never changes across
 * pages, so navigating pages keeps the prompt cache warm. Pair with
 * `formatClientActionsSignal(clientActions)` in `plan.signal`, and enable
 * `clientActionDispatcher` on the client session (on by default for
 * `CLIENT_ACTION_DISPATCHER_TOOL`).
 */
export function createClientActionDispatcherTool(
	options: {
		readonly name?: string
		readonly description?: string
		readonly requireApproval?: boolean
	} = {}
): ReturnType<typeof createTool> {
	return createTool({
		id: options.name ?? CLIENT_ACTION_DISPATCHER_TOOL,
		description:
			options.description ??
			'Run one of the page actions listed in the current page context.',
		inputSchema: DISPATCHER_INPUT_SCHEMA,
		requireApproval: options.requireApproval === true
	})
}

/**
 * Formats the page's currently mounted client actions as a compact signal block
 * to append to `plan.signal` (after the cached prefix). Empty string when no
 * actions are mounted.
 */
export function formatClientActionsSignal(
	definitions: readonly ClientToolDef[],
	toolName = CLIENT_ACTION_DISPATCHER_TOOL
): string {
	if (definitions.length === 0) return ''

	const lines = definitions.map((definition) => {
		const schema = compactJsonSchema(definition.jsonSchema)
		const props = schema.properties as Record<string, unknown> | undefined
		const hasProps = props && Object.keys(props).length > 0
		const approval = definition.requiresApproval ? ' [requires approval]' : ''
		const schemaText = hasProps ? ` input=${JSON.stringify(schema)}` : ''

		return `- ${definition.name}${approval}: ${definition.description}${schemaText}`
	})

	return `Available page actions (call via ${toolName}):\n${lines.join('\n')}`
}
