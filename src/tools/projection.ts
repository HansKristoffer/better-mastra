/**
 * A tool result as plain JSON, the value the client receives and the thread
 * stores: a value with `toJSON` (a `Date`, a Prisma `Decimal`) becomes what
 * that returns, and fields named in `omit` (an account number) are removed at
 * any depth, so they never reach the thread, a span or the model. An absent
 * value becomes `null`.
 */
export function toJsonProjection(
	value: unknown,
	options: { readonly omit?: readonly string[] } = {}
): unknown {
	const omit = new Set(options.omit ?? [])
	const json = JSON.stringify(value, (key, field) =>
		omit.has(key) ? undefined : field
	)

	return json === undefined ? null : JSON.parse(json)
}

/** The type `toJsonProjection` returns for `T`, with the `TOmit` keys removed. */
export type JsonProjection<T, TOmit extends string = never> = T extends {
	toJSON(): infer TJson
}
	? TJson
	: T extends readonly (infer TItem)[]
		? readonly JsonProjection<TItem, TOmit>[]
		: T extends object
			? {
					readonly [TKey in keyof T as TKey extends TOmit
						? never
						: TKey]: JsonProjection<T[TKey], TOmit>
				}
			: T
