/**
 * An error whose message the model may read as it is: input the tool cannot
 * act on, a missing permission. With `maskErrors`, every other error a tool
 * throws reaches the model as one fixed sentence.
 */
export class ToolRefusal extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'ToolRefusal'
	}
}
