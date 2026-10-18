/**
 * Structured JSON logger that writes to stderr. It redacts the fields of every
 * line. It does not redact the message text.
 */

/** Field names whose values are always replaced. */
const SECRET_KEY = /(token|key|secret|password|authorization|cookie)/i;

/** Values that look like credentials regardless of the key they sit under. */
const SECRET_VALUE = /\b(sk-ant-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,})\b/g;

/**
 * Returns a copy of a value with credentials replaced by a marker. Recurses
 * into arrays and objects up to a fixed depth.
 *
 * @param value The value to copy.
 * @param depth The depth of the value in the original, 0 at the top.
 * @returns The redacted copy.
 */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[deep]';
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[redacted]');
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

/** Severity of a log line. */
export type Level = 'debug' | 'info' | 'warn' | 'error';

/** Numeric severities, so levels can be compared against the threshold. */
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Lowest severity that is written. It starts at info, so lines logged before
 * setLogLevel runs are still written.
 */
let threshold = LEVELS.info;

/**
 * Sets the lowest severity that is written. The entry point calls it with LOG_LEVEL.
 *
 * @param level The lowest severity to write.
 */
export function setLogLevel(level: Level): void {
  threshold = LEVELS[level];
}

/**
 * Checks if a line at a level is written. A caller uses it to skip
 * an expensive log line that nothing reads.
 *
 * @param level The severity of the line.
 * @returns True when the line is written.
 */
export function wants(level: Level): boolean {
  return LEVELS[level] >= threshold;
}

/**
 * Writes one redacted JSON line, unless the level is below the threshold.
 *
 * @param level The severity of the line.
 * @param msg The message.
 * @param fields The fields of the line.
 */
function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  };
  // stderr only, so stdout stays clean for callers that pipe the process.
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

/**
 * Builds the four level methods.
 *
 * @param tag The fields that each method adds to every line.
 * @returns The method of each level.
 */
function levels(
  tag?: Record<string, unknown>,
): Record<Level, (msg: string, fields?: Record<string, unknown>) => void> {
  const at =
    (level: Level) =>
    (msg: string, fields?: Record<string, unknown>): void =>
      emit(level, msg, tag ? { ...tag, ...fields } : fields);
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** A logger, tagged or not. */
export type Logger = ReturnType<typeof levels>;

/** Process-wide logger. */
export const log = {
  ...levels(),
  wants,
  /**
   * Returns a child logger that stamps every line with a box id.
   *
   * @param id The box id.
   * @returns The child logger.
   */
  box: (id: string): Logger => levels({ box: id }),
  /**
   * Returns a child logger that stamps every line with the given fields. One box runs
   * an adapter per harness, so a box id alone cannot say which process a line
   * came from.
   *
   * @param fields The fields to add to every line.
   * @returns The child logger.
   */
  tagged: (fields: Record<string, unknown>): Logger => levels(fields),
};
