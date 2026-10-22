/** The harness registry. */

import type { HarnessId } from '../../shared/types.ts';
import type { CredentialId, CredentialMethod } from './credentials.ts';

/** The harness id, re-exported from the shared API shapes. */
export type { HarnessId };

/** Where a harness reads an agent set from, relative to the home. */
export interface AgentLayout {
  /** Home-relative path of the instructions file. */
  agentsMd: string;
  /** Home-relative directory a skill's `<name>/SKILL.md` goes under. */
  skills: string;
}

/** The values of one harness that the orchestrator needs. */
export interface Harness {
  /** The harness id. */
  id: HarnessId;
  /** What the dashboard calls it. */
  label: string;
  /** argv for the adapter, which the runtime starts as an exec in the box. */
  cmd: readonly string[];
  /** The token the adapter's own process is recognised by in the box's process table. */
  processToken: string;
  /**
   * Processes that sit under the adapter and are the harness itself rather
   * than work it is doing: the agent process and any long-lived helper.
   * Matched against the command line.
   */
  residentProcesses: readonly RegExp[];
  /**
   * True when the adapter starts the agent as its own child process. False
   * when the adapter is the agent, so its children are the commands of the
   * agent.
   */
  separateAgent: boolean;
  /** Mode a fresh thread is put in, when the adapter offers it. */
  defaultModeId: string;
  /** Mode a fork starts in. */
  forkModeId: string;
  /** Config option values a fresh thread starts with, by option id. */
  defaultConfig: Readonly<Record<string, string>>;
  /** `_meta` sent with session/new, session/load and session/fork, or undefined. */
  threadMeta: Readonly<Record<string, unknown>> | undefined;
  /**
   * The credential that a thread needs before it can run, or null for a
   * harness that runs on the API keys of the user.
   */
  credentialId: CredentialId | null;
  /**
   * Returns the container environment that this harness needs. The real secret never
   * enters a box, and the egress proxy swaps the placeholder for it on the way out.
   *
   * @param placeholder The value that stands for the credential in the box.
   * @param method How the stored credential was obtained, or null when none is stored.
   * @returns The variables by name.
   */
  env: (placeholder: string, method: CredentialMethod | null) => Record<string, string>;
  /** Where an agent set is installed, home-relative. */
  layout: AgentLayout;
  /** Tools that background their work whatever their input says. */
  alwaysBackground: ReadonlySet<string>;
}

/**
 * One record per harness the orchestrator can run in a box. A harness that
 * needs a new kind of value gets a new field, not a branch at the call site.
 */
export const HARNESSES: Readonly<Record<HarnessId, Harness>> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    cmd: ['claude-agent-acp'],
    processToken: 'claude-agent-acp',
    // The adapter spawns the Claude Code CLI as its agent. The pattern matches a
    // path that ends in `claude`, and not a path such as `claude-agent-acp` that
    // only contains the word.
    residentProcesses: [/(^|\/)claude(\s|$)/],
    separateAgent: true,
    defaultModeId: 'auto',
    forkModeId: 'plan',
    defaultConfig: { model: 'opus' },
    /**
     * `summarized` makes the reasoning readable, because the default `omitted`
     * streams thinking blocks without text. The type is `enabled` with a
     * budget, because older models reject `adaptive`.
     */
    threadMeta: {
      claudeCode: {
        options: {
          // Named so that the adapter offers Fable. The orchestrator sets the
          // model from defaultConfig after session/new, so a fresh thread runs on
          // that model.
          model: 'fable',
          thinking: { type: 'enabled', budgetTokens: 10_000, display: 'summarized' },
        },
      },
    },
    credentialId: 'claude',
    /**
     * Claude Code sends `ANTHROPIC_API_KEY` as `x-api-key` and
     * `CLAUDE_CODE_OAUTH_TOKEN` as a bearer token, so the variable follows
     * the kind of the stored secret. Only one is set, as the API key would
     * win over the token.
     */
    env: (placeholder: string, method: CredentialMethod | null) => ({
      [method === 'api_key' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN']: placeholder,
      CLAUDE_CONFIG_DIR: '/home/agent/.claude',
    }),
    layout: {
      agentsMd: '.claude/CLAUDE.md',
      skills: '.claude/skills',
    },
    alwaysBackground: new Set(['Monitor', 'Workflow']),
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    cmd: ['codex-acp'],
    processToken: 'codex-acp',
    // The adapter spawns `$CODEX_PATH app-server` for the life of the exec. The box
    // image points CODEX_PATH to the npm launcher of Codex, and the command lines of
    // the launcher and of the native binary that it starts both hold `codex app-server`.
    residentProcesses: [/codex app-server/],
    separateAgent: true,
    /**
     * `agent-full-access` replaces the `agent` default of the adapter. The
     * other modes run each command in the sandbox of Codex, which uses bubblewrap
     * and needs a user namespace. A process in a box cannot create one, because
     * every runtime drops all capabilities, `CAP_SYS_ADMIN` included, and the
     * default seccomp profile refuses a user namespace without it. The
     * container is the boundary instead.
     */
    defaultModeId: 'agent-full-access',
    /**
     * The adapter mode with the `on-request` approval of Codex and a human
     * reviewer. It sets the `workspace-write` sandbox without network, and
     * Codex asks before it edits files outside the workspace or uses the internet.
     */
    forkModeId: 'read-only',
    /** Empty, so a fresh Codex thread stays on the default model of the adapter. */
    defaultConfig: {},
    threadMeta: undefined,
    credentialId: 'openai',
    /**
     * The adapter reads `CODEX_API_KEY`. With `DEFAULT_AUTH_REQUEST` naming the
     * `api-key` method, `codex-acp` logs in from the environment when a
     * `session/*` call finds no account. Codex then saves the key to
     * `$CODEX_HOME/auth.json` on the home. The placeholder never changes, so
     * that copy stays valid. `NO_BROWSER` hides the browser login method.
     *
     * `CODEX_CA_CERTIFICATE` is set with the other CA variables in `boxEnv`.
     */
    env: (placeholder: string) => ({
      CODEX_API_KEY: placeholder,
      CODEX_HOME: '/home/agent/.codex',
      NO_BROWSER: '1',
      INITIAL_AGENT_MODE: 'agent-full-access',
      DEFAULT_AUTH_REQUEST: '{"methodId":"api-key"}',
    }),
    /** Skills go in the harness-neutral `~/.agents/skills`. */
    layout: {
      agentsMd: '.codex/AGENTS.md',
      skills: '.agents/skills',
    },
    /** Codex has no tool that backgrounds itself regardless of its input. */
    alwaysBackground: new Set<string>(),
  },
  opencode: {
    id: 'opencode',
    label: 'opencode',
    cmd: ['opencode', 'acp'],
    processToken: 'opencode acp',
    /** opencode runs as one process and starts no long-lived helper. */
    residentProcesses: [],
    /** `opencode acp` is the agent, and it starts the shells of its tools directly. */
    separateAgent: false,
    /**
     * `build` allows all tools. It asks only before it reads `.env` files,
     * before it uses paths outside the workspace, and when the agent repeats
     * the same tool call many times.
     */
    defaultModeId: 'build',
    /** `plan` does not edit files. */
    forkModeId: 'plan',
    /** Empty, so opencode selects the model of a fresh thread. */
    defaultConfig: {},
    threadMeta: undefined,
    /**
     * The API keys of the user go into each box with their own names, and
     * opencode reads the key of each provider from these names.
     */
    credentialId: null,
    /**
     * Turns off the self-update and the download of language servers. opencode
     * also stops reading the Claude Code instructions and skills, because the
     * agent set has its own copy for opencode.
     */
    env: () => ({
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
    }),
    /** Skills go in the harness-neutral `~/.agents/skills`, the same folder as for Codex. */
    layout: {
      agentsMd: '.config/opencode/AGENTS.md',
      skills: '.agents/skills',
    },
    /** opencode has no tool that backgrounds itself regardless of its input. */
    alwaysBackground: new Set<string>(),
  },
};

/** Every harness id, in the order the dashboard offers them. */
export const HARNESS_IDS: readonly HarnessId[] = Object.keys(HARNESSES) as HarnessId[];

/**
 * The harness a request that names none gets. Claude, because every client
 * that names no harness expects it.
 */
export const DEFAULT_HARNESS: HarnessId = 'claude';

/**
 * Returns the harness a stored id names. It throws for an unknown id, so a thread
 * never runs on the wrong agent.
 *
 * @param id The harness id.
 * @returns The harness.
 * @throws Error when no harness has the id.
 */
export function harness(id: string): Harness {
  // Own properties only, so `constructor` or `toString` names no harness.
  if (!Object.hasOwn(HARNESSES, id)) throw new Error(`Unknown harness: ${id}`);
  return HARNESSES[id as HarnessId];
}
