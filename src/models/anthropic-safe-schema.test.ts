import { describe, expect, test } from 'bun:test'
import type { JSONSchema7 } from 'ai'
import { z } from 'zod'
import { anthropicSafeZodSchema } from './anthropic-safe-schema'

describe('anthropicSafeZodSchema', () => {
	test('removes safe-integer bounds added by z.number().int()', () => {
		const schema = anthropicSafeZodSchema(
			z.object({
				score: z.number().int().nullable()
			})
		)

		expect(schema.jsonSchema).toEqual({
			$schema: 'http://json-schema.org/draft-07/schema#',
			type: 'object',
			properties: {
				score: {
					anyOf: [{ type: 'integer' }, { type: 'null' }]
				}
			},
			required: ['score'],
			additionalProperties: false
		})
	})

	test('removes explicit min/max on integer fields', () => {
		const schema = anthropicSafeZodSchema(
			z.object({
				seats: z.number().int().min(1).max(9).nullable()
			})
		)

		const jsonSchema = schema.jsonSchema as JSONSchema7

		expect(jsonSchema.properties?.seats).toEqual({
			anyOf: [{ type: 'integer' }, { type: 'null' }]
		})
	})

	test('removes min/max on number fields', () => {
		const schema = anthropicSafeZodSchema(
			z.object({
				confidence: z.number().min(0).max(1)
			})
		)

		const jsonSchema = schema.jsonSchema as JSONSchema7

		expect(jsonSchema.properties?.confidence).toEqual({
			type: 'number'
		})
	})

	test('removes minItems/maxItems on array fields', () => {
		const schema = anthropicSafeZodSchema(
			z.object({
				highlights: z.array(z.string().min(3).max(120)).max(6),
				faq: z
					.array(z.object({ question: z.string() }))
					.min(1)
					.max(8)
			})
		)

		const jsonSchema = schema.jsonSchema as JSONSchema7

		expect(jsonSchema.properties?.highlights).toEqual({
			type: 'array',
			items: {
				type: 'string',
				minLength: 3,
				maxLength: 120
			}
		})
		expect(jsonSchema.properties?.faq).toEqual({
			type: 'array',
			items: {
				type: 'object',
				properties: {
					question: { type: 'string' }
				},
				required: ['question'],
				additionalProperties: false
			}
		})
	})

	test('removes propertyNames from z.record() object fields', () => {
		const schema = anthropicSafeZodSchema(
			z.object({
				metadata: z.record(z.string(), z.unknown()).default({})
			})
		)

		const jsonSchema = schema.jsonSchema as JSONSchema7
		const metadata = jsonSchema.properties?.metadata as JSONSchema7

		expect(metadata?.type).toBe('object')
		expect(metadata).not.toHaveProperty('propertyNames')
	})
})
