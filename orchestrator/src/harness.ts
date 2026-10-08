/** The harness registry. */

import type { HarnessId } from '../../shared/types.ts';
import type { CredentialId } from './credentials.ts';

/** The harness id, re-exported from the shared API shapes. */
export type { HarnessId };

/** Where a harness reads an agent set from, relative to the home. */
export interface AgentLayout {
  /** Home-relative path of the instructions file. */
  agentsMd: string;
  /** Home-relative directory a skill's `<name>/SKILL.md` goes under. */
  skills: string;
}

/** Every harness-specific value the orchestrator needs. Values only, no behaviour. */
export interface Harness {
  /** The harness id. */
  id: HarnessId;
  /** What the dashboard calls it. */
  label: string;
  /** argv for the adapter, spawned as a docker exec in the box. */
  cmd: readonly string[];
  /** The token the adapter's own process is recognised by in the box's process table. */
  processToken: string;
  /**
   * Processes that sit under the adapter and are the harness itself rather
   * than work it is doing: the agent process and any long-lived helper.
   * Matched against the command line.
   */
  residentProcesses: readonly RegExp[];
  /** Mode a fresh thread is put in, when the adapter offers it. */
  defaultModeId: string;
  /** Mode a fork starts in instead. */
  forkModeId: string;
  /** Config option values a fresh thread starts with, by option id. */
  defaultConfig: Readonly<Record<string, string>>;
  /** `_meta` sent with session/new, session/load and session/fork, or undefined. */
  threadMeta: Readonly<Record<string, unknown>> | undefined;
  /** Which credential must be present before a thread can run. */
  credentialId: CredentialId;
  /**
   * Container environment this harness needs. `placeholder` is what the box
   * holds in place of the credential: the real secret never enters a box, and
   * the egress proxy swaps the placeholder for it on the way out.
   */
  env: (placeholder: string) => Record<string, string>;
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
    // The adapter spawns the Claude Code CLI as its agent, and nothing else
    // of its own outlives a turn. The pattern matches the `claude` argv0, not
    // a path that contains the word.
    residentProcesses: [/(^|\/)claude(\s|$)/],
    defaultModeId: 'auto',
    forkModeId: 'plan',
    defaultConfig: { model: 'opus' },
    /**
     * `summarized` makes the reasoning readable: the default `omitted` streams
     * thinking blocks without text. `enabled` with a budget rather than
     * `adaptive`, because older models reject `adaptive`.
     */
    threadMeta: {
      claudeCode: {
        options: {
          // Named so the adapter offers Fable, which is billed against usage
          // credits and is not in the plan's list. It does not select it: a
          // fresh thread still starts on defaultConfig's model.
          model: 'fable',
          thinking: { type: 'enabled', budgetTokens: 10_000, display: 'summarized' },
        },
      },
    },
    credentialId: 'claude',
    env: (placeholder: string) => ({
      CLAUDE_CODE_OAUTH_TOKEN: placeholder,
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
    // The adapter spawns Codex as `codex app-server` for the life of the exec.
    // Not yet checked in a real box: other long-lived helpers under it belong
    // here too.
    residentProcesses: [/codex app-server/],
    /**
     * `agent-full-access` rather than the adapter's `agent` default. The other
     * modes run each command under bubblewrap, which needs a user namespace.
     * A box cannot create one on any host, because `CapDrop: ['ALL']` removes
     * `CAP_SYS_ADMIN`. The container is the boundary instead.
     */
    defaultModeId: 'agent-full-access',
    /**
     * Like a Claude fork in `plan`, every write asks first. `read-only` is
     * Codex's `on-request` approval with a human reviewer, not a sandbox. In
     * a box Codex runs it without the bubblewrap sandbox.
     */
    forkModeId: 'read-only',
    /** Empty: a fresh Codex thread stays on the adapter's own default model. */
    defaultConfig: {},
    threadMeta: undefined,
    credentialId: 'openai',
    /**
     * The adapter reads `CODEX_API_KEY`: with `DEFAULT_AUTH_REQUEST` naming the
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
};

/** Every harness id, in the order the dashboard offers them. */
export const HARNESS_IDS: readonly HarnessId[] = Object.keys(HARNESSES) as HarnessId[];

/**
 * The harness a request that names none gets. Claude, because every client
 * that names no harness expects it.
 */
export const DEFAULT_HARNESS: HarnessId = 'claude';

/**
 * The harness a stored id names. Throws for an unknown id rather than fall
 * back, so a thread never runs on the wrong agent.
 */
export function harness(id: string): Harness {
  // Own properties only, so `constructor` or `toString` names no harness.
  if (!Object.hasOwn(HARNESSES, id)) throw new Error(`Unknown harness: ${id}`);
  return HARNESSES[id as HarnessId];
}
