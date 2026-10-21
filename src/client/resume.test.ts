import { describe, expect, test } from 'bun:test'

import { resumeOnAppActive, resumeOnNetworkRegain } from './resume'

describe('resume signals', () => {
	test('resume when the device gets its connection back, not on its first report', () => {
		let report: (state: { isConnected: boolean | null }) => void = () => {}
		let unsubscribed = false
		const resumed: string[] = []
		const stop = resumeOnNetworkRegain({
			addEventListener: (listener) => {
				report = listener
				return () => {
					unsubscribed = true
				}
			}
		})(() => resumed.push('resume'))

		report({ isConnected: true })
		report({ isConnected: false })
		report({ isConnected: null })
		report({ isConnected: true })
		report({ isConnected: true })
		stop()

		expect(resumed).toEqual(['resume'])
		expect(unsubscribed).toBe(true)
	})

	test('resume when the app comes back to the foreground', () => {
		let change: (state: string) => void = () => {}
		const resumed: string[] = []
		resumeOnAppActive({
			addEventListener: (_type, listener) => {
				change = listener
				return { remove: () => {} }
			}
		})(() => resumed.push('resume'))

		change('background')
		change('active')

		expect(resumed).toEqual(['resume'])
	})
})
