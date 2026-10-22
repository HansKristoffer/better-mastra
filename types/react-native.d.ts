// The slice of `react-native`'s types `src/react/markdown` and
// `react-native-markdown-display` use. The real types declare React Native's
// globals (`setTimeout` returning a number, its own `fetch` and `AbortSignal`),
// which would replace Node's and Bun's for the whole library. tsconfig `paths`
// points here for this package's own build only; the emitted declarations
// still import `react-native`, so consumers get its real types.
import type { Component, ComponentType, ReactNode } from 'react'

export type TextStyle = { color?: string; [key: string]: unknown }
export type ViewStyle = Record<string, unknown>
export type StyleProp<T> =
	T | readonly StyleProp<T>[] | false | null | undefined

export declare namespace StyleSheet {
	type NamedStyles<T> = { [P in keyof T]: object }
	function flatten<T>(style: StyleProp<T>): T | undefined
}

export declare class View extends Component<{ children?: ReactNode }> {}
export declare const Text: ComponentType<{
	style?: StyleProp<TextStyle>
	children?: ReactNode
}>
