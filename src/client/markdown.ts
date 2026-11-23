/**
 * Thin, dependency-free security configuration for `markdown-it` on web
 * (React web or Vue): disables raw HTML and images (preventing prompt-injected
 * tracking pixels/exfiltration), validates link schemes (`isSafeUrl` /
 * `isWebUrl`), and opens external `http(s)` links with `rel="noopener noreferrer nofollow"`.
 */

import { isSafeUrl, isWebUrl } from './reveal.js'

/** Minimal structural type matching a `markdown-it` instance without depending on the package. */
export interface MarkdownItLike {
	readonly options?: { html?: boolean }
	disable(rules: string | readonly string[], ignoreInvalid?: boolean): unknown
	validateLink: (url: string) => boolean
	readonly renderer: {
		readonly rules: Record<
			string,
			| ((
					tokens: readonly MarkdownItTokenLike[],
					idx: number,
					options: unknown,
					env: unknown,
					self: {
						renderToken(
							tokens: readonly MarkdownItTokenLike[],
							idx: number,
							options: unknown
						): string
					}
			  ) => string)
			| undefined
		>
	}
}

export interface MarkdownItTokenLike {
	attrGet(name: string): string | null
	attrSet(name: string, value: string): void
}

export interface SafeMarkdownOptions {
	/** `'all'` (default: http/https/mailto/tel/relative) or `'web'` (`http(s)` only). */
	readonly safeLinks?: 'all' | 'web'
	/** Disables markdown image syntax to prevent prompt-injected tracking URLs. Default `true`. */
	readonly disableImages?: boolean
	/** Opens external `http(s)` links in a new tab with `noopener noreferrer nofollow`. Default `true`. */
	readonly openExternalInNewTab?: boolean
}

/**
 * Configures a `markdown-it` instance with safe defaults for AI assistant
 * answers and returns it.
 */
export function configureSafeMarkdownIt<T extends MarkdownItLike>(
	md: T,
	options: SafeMarkdownOptions = {}
): T {
	const checkUrl = options.safeLinks === 'web' ? isWebUrl : isSafeUrl

	if (md.options) {
		md.options.html = false
	}
	if (options.disableImages !== false) {
		md.disable('image', true)
	}
	md.validateLink = (url) => checkUrl(url)

	if (options.openExternalInNewTab !== false) {
		const defaultLinkOpen =
			md.renderer.rules.link_open ??
			((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts))

		md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
			const token = tokens[idx]
			const href = token?.attrGet('href') ?? ''
			if (token && isWebUrl(href)) {
				token.attrSet('target', '_blank')
				token.attrSet('rel', 'noopener noreferrer nofollow')
			}
			return defaultLinkOpen(tokens, idx, opts, env, self)
		}
	}

	return md
}
