import { z } from 'zod';
import type { CredentialId } from '../../shared/types.ts';
import { DEFAULT_BOX_GID, DEFAULT_BOX_UID } from './workspaces.ts';

/**
 * Environment parsing. Every setting the orchestrator reads comes from the
 * process env and is parsed once at boot, so a misconfigured deployment fails
 * at startup.
 *
 * Every setting has a working default, so the orchestrator starts with no
 * configuration at all. Nothing here is a secret: the deployment's
 * credentials live in the database and are managed from the settings page,
 * and this file knows only which hosts each of them travels to.
 */

/** A positive whole number of minutes. */
const durationMinutes = z.coerce.number().int().positive();

/** A bare hostname of two labels or more: no scheme, no port, no path. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * An on/off setting, spelled the way a person would write one.
 *
 * An unrecognised value fails at boot with the rest of the configuration.
 */
const flag = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
  .transform((value) => ['true', '1', 'yes', 'on'].includes(value));

const schema = z.object({
  DATA_DIR: z.string().min(1).default('/data'),
  /**
   * Host-side path of DATA_DIR, which is what a box's workspace bind has
   * to name — the daemon resolves bind sources, not this process.
   *
   * Empty is the normal case: at boot the orchestrator inspects its own
   * container and takes the `Source` of the mount at DATA_DIR, which with the
   * shipped compose is `/var/lib/docker/volumes/boxes-data/_data`. Set this
   * only where that cannot work — a nested or rootless daemon, or a compose
   * file that mounts a real host directory for /data.
   */
  HOST_DATA_DIR: z.string().default(''),
  PORT: z.coerce.number().int().positive().default(3000),
  /**
   * Lowest severity written to stderr. `debug` carries every forwarded ACP
   * message, which is a lot of output for a busy deployment, so the default
   * is one step above it.
   */
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  BOX_IMAGE: z.string().min(1).default('ghcr.io/splitbrain/boxes/box:latest'),
  /**
   * uid and gid box containers run as, and so the owner of every file in
   * a workspace.
   *
   * The box image has to agree: it builds its `agent` user on these same
   * numbers through the AGENT_UID and AGENT_GID build args, and a box's
   * home is a named volume Docker ownership-initialises from the image, which
   * nothing outside the container can then chown. ensureBoxImage() reads
   * the image's own user back and says so when the two have drifted.
   *
   * Setting these to the uid the orchestrator itself runs as is what lets it
   * drop root: there is then nothing to give away.
   */
  BOX_UID: z.coerce.number().int().positive().default(DEFAULT_BOX_UID),
  BOX_GID: z.coerce.number().int().positive().default(DEFAULT_BOX_GID),
  /**
   * How often the box image is pulled again, so a moving tag such as
   * `:latest` keeps moving. A box adopts what has arrived when it is next
   * started; nothing running is disturbed.
   *
   * 0 turns the refresh off, which is what an image built on the host wants —
   * there is no registry to pull it from, and trying every hour would only
   * fill the log. The image is still pulled once when it is missing
   * altogether, because a box cannot be created without it.
   */
  BOX_IMAGE_PULL_MINUTES: z.coerce.number().int().nonnegative().default(60),
  /**
   * Whether a copy of the box image that a pull has superseded is removed
   * from this host.
   *
   * On, because an untagged image left behind is a gigabyte or two per
   * release that nothing else reclaims. Only images carrying the box
   * image's own label are touched, and only once no container is left running
   * on one.
   *
   * Off is for a host that keeps old images deliberately: to roll back to one
   * without the registry, or because something outside Boxes runs them.
   */
  BOX_IMAGE_PRUNE: flag.default('true'),
  BOX_SUBNET_POOL: z.string().regex(/^\d+\.\d+\.\d+\.\d+\/\d+$/).default('10.200.0.0/16'),
  /**
   * What one box may take. Both of these now cover *two* adapters: a box may
   * hold threads of either harness, and each one that has a thread runs its own
   * adapter process with its own agent under it.
   *
   * The numbers are unchanged, because they were generous for one and a second
   * adapter is a native binary that idles cheaply — but they have not been
   * measured against two busy agents in one box, and a deployment that meets
   * the ceiling raises them. A pids limit reached shows up as a tool call that
   * cannot fork; a memory limit reached shows up as the kernel killing
   * something in the box.
   */
  BOX_MEM_LIMIT: z.string().regex(/^\d+[kmgKMG]?$/).default('4g'),
  BOX_CPUS: z.coerce.number().positive().default(2),
  BOX_PIDS_LIMIT: z.coerce.number().int().positive().default(512),

  IDLE_STOP_MINUTES: durationMinutes.default(30),

  /**
   * How long an answer about what is running in a box stands before the box
   * is asked again, in seconds.
   *
   * One Docker API call per running box per window, and also what a
   * browser is shown, so it trades that cost against how long a finished
   * build still reads as running.
   */
  BACKGROUND_POLL_SECONDS: z.coerce.number().int().positive().default(20),

  /**
   * How long a thread has to say nothing before the agent counts as having
   * stopped, in seconds.
   *
   * The fallback, and for one of the two harnesses the whole answer.
   * `claude-agent-acp` marks the end of a processing cycle with a
   * `usage_update` carrying a cost, which is read instead; `codex-acp` sends
   * no `usage_update` with a cost at all, so every Codex thread falls to this
   * timer. That is what it is for: no stop reason arrives for a prompt held
   * open, and a turn the harness started on its own has no request to end. A
   * tool call the agent is waiting on suspends the question.
   */
  AGENT_QUIET_SECONDS: z.coerce.number().int().positive().default(3),

  /**
   * How long a thread has to stay quiet before anybody is told its turn has
   * finished, in seconds. Measured from the last thing the agent said, so it
   * includes AGENT_QUIET_SECONDS.
   *
   * Longer than the quiet threshold: a screen can be wrong for a moment and
   * correct itself, and a push notification cannot.
   */
  AGENT_SETTLE_SECONDS: z.coerce.number().int().positive().default(30),

  /**
   * Largest single attachment a prompt may carry into a workspace, in
   * mebibytes.
   *
   * The cap is on the upload rather than on the workspace: it bounds one
   * request the orchestrator buffers in memory before writing it out.
   */
  MAX_ATTACHMENT_MB: z.coerce.number().int().positive().default(25),

  PERMISSION_FALLBACK: z.enum(['hold', 'deny']).default('hold'),
  PERMISSION_HOLD_MINUTES: durationMinutes.default(120),

  /**
   * Who operates this deployment, for the VAPID assertion every Web Push
   * carries. A push service with a problem contacts this rather than
   * silently dropping the messages; RFC 8292 allows a mailto: or an https:
   * URL and nothing else.
   */
  PUSH_SUBJECT: z
    .string()
    .refine((v) => v.startsWith('mailto:') || v.startsWith('https://'), {
      message: 'must be a mailto: or https: URL',
    })
    .default('https://github.com/splitbrain/boxes'),

  /** Container name of the egress proxy the orchestrator attaches. */
  EGRESS_PROXY_CONTAINER: z.string().min(1).default('boxes-egress-proxy'),
  EGRESS_PROXY_ALIAS: z.string().min(1).default('proxy'),
  EGRESS_PROXY_PORT: z.coerce.number().int().positive().default(3128),
  /**
   * Port of the proxy's control channel, on the compose network. Nobody sets
   * this: the orchestrator is the only thing that speaks to it, and it is
   * unreachable from a box either way.
   */
  EGRESS_CONTROL_PORT: z.coerce.number().int().positive().default(3129),

  /**
   * Hosts boxes may reach, comma or whitespace separated. Exact names and
   * one-label wildcards: `github.com, *.githubusercontent.com`. Empty is off,
   * which leaves every public host reachable.
   */
  EGRESS_ALLOWED_HOSTS: z.string().default(''),

  /**
   * The GitLab the settings page's token is for, as a bare hostname with no
   * scheme and no path. `gitlab.com` unless a deployment runs its own.
   *
   * A self-managed instance has to be on a public address, because the proxy
   * refuses private ranges whatever the credential set says.
   */
  GITLAB_HOST: z
    .string()
    .regex(HOSTNAME, { message: 'must be a bare hostname such as gitlab.example.com' })
    .default('gitlab.com'),
});

export type Config = Readonly<z.infer<typeof schema>> & {
  /** The parsed allowlist. Empty means the allowlist is off. */
  readonly egressAllowedHosts: readonly string[];
  /**
   * Every credential this deployment can translate, and where each one
   * travels. A box holds a placeholder for each entry; the proxy swaps in the
   * ones the store holds a secret for.
   */
  readonly credentialSet: readonly CredentialSpec[];
};

/**
 * One credential the proxy can translate, and everything the deployment knows
 * about it that is not the secret itself.
 *
 * The host lists and header names are fixed here rather than configured:
 * they are facts about the services rather than preferences. The one
 * exception is which GitLab a deployment uses, which GITLAB_HOST names.
 */
export interface CredentialSpec {
  /** Which stored credential this is: the key of the row that holds its secret. */
  id: CredentialId;
  /** Hosts intercepted so the credential can be swapped in. */
  hosts: readonly string[];
  /** Headers the credential may travel in, lowercased. */
  headers: readonly string[];
  /**
   * Hosts this credential's tools need reachable but never send it to, so a
   * narrow allowlist cannot break them. Not intercepted.
   */
  alsoAllow: readonly string[];
  /**
   * Prefix a generated placeholder carries, so that a client checking the
   * shape of its token accepts it and fails at the API rather than at startup.
   */
  placeholderPrefix: string;
}

/**
 * The credentials whose hosts are fixed. A deployment translates the ones the
 * credential store holds a secret for; the rest stay ordinary passthrough
 * hosts.
 *
 * This stays configuration-free even though the secrets have left the
 * environment: which hosts a credential is sent to, and which header it
 * arrives in, are facts about the services rather than preferences.
 */
const FIXED_CREDENTIALS: readonly CredentialSpec[] = [
  {
    id: 'claude',
    hosts: ['api.anthropic.com'],
    headers: ['authorization', 'x-api-key'],
    // The token endpoints an OAuth credential may be refreshed at. Reachable
    // but never intercepted: a refresh is the orchestrator's own business and
    // carries its own credential rather than a box's placeholder.
    alsoAllow: ['console.anthropic.com', 'platform.claude.com', 'claude.ai'],
    placeholderPrefix: 'sk-ant-oat01-',
  },
  {
    id: 'openai',
    // The API-key endpoint alone. `chatgpt.com` carries the other kind of
    // OpenAI credential — a subscription — and the two reject each other's
    // material, so leaving it unintercepted is what lets a deployment key and
    // a person's subscription coexist in one box.
    hosts: ['api.openai.com'],
    headers: ['authorization'],
    // Where Codex logs in and refreshes, and the subscription endpoint it may
    // be talking to instead. Reachable so a narrow allowlist cannot break
    // either, never intercepted. `files.openai.com` and `ab.chatgpt.com` —
    // attachments and Codex's own telemetry — are a deployment's own choice
    // and are deliberately not implied here.
    alsoAllow: ['auth.openai.com', 'chatgpt.com'],
    placeholderPrefix: 'sk-',
  },
  {
    id: 'github',
    hosts: ['github.com', 'api.github.com', '*.githubusercontent.com'],
    // git sends the token as the password of an HTTP Basic pair and gh sends
    // it directly; both arrive in this one header.
    headers: ['authorization'],
    alsoAllow: ['codeload.github.com'],
    placeholderPrefix: 'ghp_',
  },
];

/**
 * The GitLab credential, whose host is the one part of the set a deployment
 * chooses: GITLAB_HOST, which is gitlab.com unless it runs its own instance.
 *
 * git sends the token as the password of an HTTP Basic pair. glab sends a
 * personal access token in PRIVATE-TOKEN, which is the header GitLab
 * documents for one, and an OAuth token as a bearer; both headers are read so
 * that every shape is either swapped or refused.
 */
function gitlabCredential(host: string): CredentialSpec {
  return {
    id: 'gitlab',
    hosts: [host],
    headers: ['authorization', 'private-token'],
    alsoAllow: [],
    placeholderPrefix: 'glpat-',
  };
}

/** Every credential this deployment can translate, in settings-page order. */
function credentialSetFor(gitlabHost: string): readonly CredentialSpec[] {
  return [...FIXED_CREDENTIALS, gitlabCredential(gitlabHost)];
}

/** Splits a comma or whitespace separated host list into patterns. */
function parseHostList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h !== ''),
    ),
  ];
}

/** The config parsed at first use, or null before then. */
let cached: Config | null = null;

/**
 * Drops the empty entries of an environment, so an empty value reads as a
 * setting nobody provided.
 *
 * `FOO=` in an .env file, and a compose pass-through for a variable the host
 * does not set, both arrive as an empty string, which would fail the regex
 * and enum fields at boot.
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
  const allowedHosts = parseHostList(base.EGRESS_ALLOWED_HOSTS);
  for (const pattern of allowedHosts) {
    if (pattern === '*') {
      throw new Error(
        'Invalid configuration:\n  EGRESS_ALLOWED_HOSTS: a bare * would allow every host; ' +
          'leave the setting empty to turn the allowlist off',
      );
    }
    if (pattern.includes('*') && !pattern.startsWith('*.')) {
      throw new Error(
        `Invalid configuration:\n  EGRESS_ALLOWED_HOSTS: ${pattern} may only use a leading *. wildcard`,
      );
    }
  }

  return {
    ...base,
    egressAllowedHosts: allowedHosts,
    credentialSet: credentialSetFor(base.GITLAB_HOST),
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
