/**
 * The one error that carries an HTTP status.
 *
 * Every layer that can refuse a request throws this: the session lifecycle,
 * the review surface, the agent store. They used to have a class each — three
 * identical definitions, and an error handler that had to know all three — so
 * one refusal shape is both less code and one fewer thing to remember when a
 * fourth layer is added.
 */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
