/** An error that carries the HTTP status the request fails with. */
export class HttpError extends Error {
  /**
   * @param statusCode The HTTP status code to answer with.
   * @param message The error message.
   */
  constructor(
    /** The HTTP status code to answer with. */
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
