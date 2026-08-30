import { z } from 'zod';
import { resolveWsAuthToken } from './secret.ts';

/**
 * Environment parsing. Every setting the orchestrator reads comes from the
 * process env and is parsed once at boot, so a misconfigured deployment fails
 * at startup.
 *
 * Every setting has a working default, so the orchestrator starts with no
 * configuration at all.
 */

const durationMinutes = z.coerce.number().int().positive();

const schema = z.object({
  DATA_DIR: z.string().min(1).default('/data'),
  PORT: z.coerce.number().int().positive().default(3000),

  SESSION_IMAGE: z.string().min(1).default('boxes-session:latest'),
  SESSION_SUBNET_POOL: z.string().regex(/^\d+\.\d+\.\d+\.\d+\/\d+$/).default('10.200.0.0/16'),
  SESSION_MEM_LIMIT: z.string().regex(/^\d+[kmgKMG]?$/).default('4g'),
  SESSION_CPUS: z.coerce.number().positive().default(2),
  SESSION_PIDS_LIMIT: z.coerce.number().int().positive().default(512),

  IDLE_STOP_MINUTES: durationMinutes.default(30),

  /**
   * Validated against the bearer.<token> WebSocket subprotocol. Unset means
   * the orchestrator generates one and keeps it in the data volume.
   */
  WS_AUTH_TOKEN: z.string().default(''),

  PERMISSION_FALLBACK: z.enum(['hold', 'deny']).default('hold'),
  PERMISSION_HOLD_MINUTES: durationMinutes.default(120),
  NTFY_URL: z.string().url().or(z.literal('')).default(''),

  /** Container name of the egress proxy the orchestrator attaches. */
  EGRESS_PROXY_CONTAINER: z.string().min(1).default('boxes-egress-proxy'),
  EGRESS_PROXY_ALIAS: z.string().min(1).default('proxy'),
  EGRESS_PROXY_PORT: z.coerce.number().int().positive().default(3128),

  PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN: z.string().default(''),
  PROFILE_DEFAULT_GH_TOKEN: z.string().default(''),
  PROFILE_DEFAULT_GIT_NAME: z.string().default('boxes-bot'),
  PROFILE_DEFAULT_GIT_EMAIL: z.string().default('boxes-bot@users.noreply.github.com'),
});

export type Config = Readonly<z.infer<typeof schema>> & {
  /** Credentials by profile name. */
  readonly profiles: Readonly<Record<string, SessionProfile>>;
};

/** Credentials + identity handed to a session container at create time. */
export interface SessionProfile {
  claudeOauthToken: string;
  ghToken: string;
  gitName: string;
  gitEmail: string;
}

let cached: Config | null = null;

/**
 * An empty value means the setting was not provided.
 *
 * `FOO=` in an .env file, and a compose pass-through for a variable the host
 * does not set, both arrive as an empty string. Treating that as a value
 * rather than as an absence would fail the regex and enum fields at boot,
 * for a setting nobody actually set.
 */
function withoutEmpty(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
}

/** Parses an environment into a config, throwing on any invalid value. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(withoutEmpty(env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const base = parsed.data;
  return {
    ...base,
    WS_AUTH_TOKEN: resolveWsAuthToken(base.DATA_DIR, base.WS_AUTH_TOKEN),
    profiles: {
      DEFAULT: {
        claudeOauthToken: base.PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN,
        ghToken: base.PROFILE_DEFAULT_GH_TOKEN,
        gitName: base.PROFILE_DEFAULT_GIT_NAME,
        gitEmail: base.PROFILE_DEFAULT_GIT_EMAIL,
      },
    },
  };
}

/** The process-wide config, parsed on first call. */
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test seam: install a config without touching process.env. */
export function setConfigForTests(c: Config): void {
  cached = c;
}
