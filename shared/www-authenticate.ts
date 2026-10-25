/** The parser of the Bearer challenge in a WWW-Authenticate header. */

/** The pattern of an HTTP token, as in a scheme or a parameter name. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+/;

/**
 * Reads the parameters of the Bearer challenge in a WWW-Authenticate header. The header can hold more challenges of
 * other schemes.
 *
 * @param header The value of the header, or undefined when the answer has none.
 * @returns The parameters with lowercase names, or null when the header holds no Bearer challenge.
 */
export function bearerChallenge(header: string | undefined): Record<string, string> | null {
  if (header === undefined) return null;
  let rest = header;
  let bearer: Record<string, string> | null = null;
  // The parameters of the current challenge go here, when it is the first Bearer challenge.
  let current: Record<string, string> | null = null;

  for (;;) {
    rest = rest.replace(/^[\s,]+/, '');
    const name = TOKEN.exec(rest)?.[0];
    if (!name) break;
    rest = rest.slice(name.length);
    const afterSpace = rest.replace(/^\s+/, '');
    if (!afterSpace.startsWith('=')) {
      current = name.toLowerCase() === 'bearer' && bearer === null ? {} : null;
      if (current) bearer = current;
      continue;
    }

    rest = afterSpace.slice(1).replace(/^\s+/, '');
    let value: string;
    const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
    if (quoted) {
      value = (quoted[1] ?? '').replace(/\\(.)/g, '$1');
      rest = rest.slice(quoted[0].length);
    } else {
      value = /^[^\s,]*/.exec(rest)?.[0] ?? '';
      rest = rest.slice(value.length);
    }
    if (current) current[name.toLowerCase()] = value;
  }
  return bearer;
}
