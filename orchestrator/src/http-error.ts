/** An error that carries the HTTP status the request fails with. */
export class HttpError extends Error {
  constructor(
    /** The HTTP status code to answer with. */
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
