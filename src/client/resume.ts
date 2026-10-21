/**
 * The moments an app may have missed part of a running answer, as resume
 * signals for `createChatSession({ resumeOn })`. The React Native ones take
 * `AppState` and NetInfo as arguments, so the client imports neither.
 */

import type { ResumeSignal } from './session.js'

/** The subset of React Native's `AppState` the signal listens to. */
export interface AppStateLike {
	addEventListener(
		type: 'change',
		listener: (state: string) => void
	): { remove(): void }
}

/** The subset of `@react-native-community/netinfo` the signal listens to. */
export interface NetInfoLike {
	addEventListener(
		listener: (state: { readonly isConnected: boolean | null }) => void
	): () => void
}

/** The browser globals the web signals listen on; the client builds without the DOM types. */
interface BrowserEvents {
	readonly document: {
		readonly visibilityState: string
		addEventListener(type: string, listener: () => void): void
		removeEventListener(type: string, listener: () => void): void
	}
	addEventListener(type: string, listener: () => void): void
	removeEventListener(type: string, listener: () => void): void
}

const browser = () => globalThis as unknown as BrowserEvents

/** The browser tab came back into view. */
export const resumeOnVisible: ResumeSignal = (resume) => {
	const { document } = browser()
	const listener = () => {
		if (document.visibilityState === 'visible') resume()
	}

	document.addEventListener('visibilitychange', listener)

	return () => document.removeEventListener('visibilitychange', listener)
}

/** The browser is online again. */
export const resumeOnOnline: ResumeSignal = (resume) => {
	const window = browser()

	window.addEventListener('online', resume)

	return () => window.removeEventListener('online', resume)
}

/** The app came back to the foreground. */
export function resumeOnAppActive(appState: AppStateLike): ResumeSignal {
	return (resume) => {
		const subscription = appState.addEventListener('change', (state) => {
			if (state === 'active') resume()
		})

		return () => subscription.remove()
	}
}

/** The device has a connection again after losing it; NetInfo's first report is not a regain. */
export function resumeOnNetworkRegain(netInfo: NetInfoLike): ResumeSignal {
	return (resume) => {
		let wasConnected: boolean | undefined

		return netInfo.addEventListener(({ isConnected }) => {
			if (isConnected === null) return

			if (isConnected && wasConnected === false) resume()

			wasConnected = isConnected
		})
	}
}
