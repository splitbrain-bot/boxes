/**
 * The harness registry. One record per agent harness the orchestrator can run
 * in a box, and the single place any harness-specific value is written down.
 *
 * Everything in here is a value, never behaviour: the modules that spawn an
 * adapter, mint a thread, materialize an agent set or read a box's process
 * table ask the registry what this harness wants and then do the one thing
 * they do. A harness that needs something none of the fields express wants a
 * new field, not a branch at the call site — the point of the table is that
 * adding a third harness is an entry rather than a search for every `if`.
 */

import type { HarnessId } from '../../shared/types.ts';
import type { CredentialId } from './credentials.ts';

/**
 * Re-exported, so a module that wants the registry wants one import.
 *
 * The id itself is declared in `shared/types.ts` because the dashboard reads
 * it off the health probe; everything about what a harness *is* stays here.
 */
export type { HarnessId };

export interface AgentLayout {
  /** Home-relative path of the instructions file. */
  agentsMd: string;
  /** Home-relative directory a skill's `<name>/SKILL.md` goes under. */
  skills: string;
  /** Home-relative directory a command's `<name>.md` goes in. */
  commands: string;
}

export interface Harness {
  id: HarnessId;
  /** What the dashboard calls it. */
  label: string;
  /** argv for the adapter, spawned as a docker exec in the box. */
  cmd: readonly string[];
  /**
   * The token the adapter's own process is recognised by in the box's
   * process table. `cmd[0]` for both, kept as its own field because the
   * reading and the spawn are different questions.
   */
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
  sessionMeta: Readonly<Record<string, unknown>> | undefined;
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

export const HARNESSES: Readonly<Record<HarnessId, Harness>> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    cmd: ['claude-agent-acp'],
    processToken: 'claude-agent-acp',
    // Read from the adapter's source, not yet confirmed against a real box's
    // process table (PLAN.md section 3, verify step 2): the adapter spawns the
    // Claude Code CLI as its agent and nothing else that outlives a turn. The
    // pattern matches the `claude` argv0 and not a workspace path that merely
    // contains the word.
    residentProcesses: [/(^|\/)claude(\s|$)/],
    defaultModeId: 'auto',
    forkModeId: 'plan',
    defaultConfig: { model: 'opus' },
    /**
     * What the adapter is asked for on the thinking side. `summarized` is what
     * makes the agent's reasoning readable: the default `omitted` streams
     * thinking blocks with a signature and no text, so the adapter has nothing
     * to put in an `agent_thought_chunk`. `enabled` with a budget rather than
     * `adaptive`, because a model that predates `adaptive` rejects it.
     */
    sessionMeta: {
      claudeCode: {
        options: {
          // A model named on every conversation, so that the adapter offers
          // it. The adapter lists the models the account's plan covers, and
          // Fable is billed against usage credits rather than the plan, so it
          // is left out unless a conversation names it. Naming it does not
          // select it: a fresh thread still starts on defaultConfig's model.
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
      commands: '.claude/commands',
    },
    alwaysBackground: new Set(['Monitor', 'Workflow']),
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    cmd: ['codex-acp'],
    processToken: 'codex-acp',
    // Same caveat as Claude's: read from `codex-acp`'s source, still to be
    // confirmed against a real box (PLAN.md section 3, verify step 2). The
    // adapter spawns the Codex binary as `codex app-server` and talks JSON-RPC
    // to it for the life of the exec; what else sits under that app-server —
    // a sandbox helper, an MCP server — is exactly what step 2 is for, and
    // anything long-lived it finds belongs in this list.
    residentProcesses: [/codex app-server/],
    /**
     * `agent-full-access` rather than the adapter's own `agent` default: the
     * other two modes run each command under bubblewrap, which needs
     * unprivileged user namespaces a box does not have. `unshare -U` and
     * `bwrap` are both refused in one, and Codex says so itself before it
     * runs anything.
     *
     * The capability rather than the kernel: a host that allows unprivileged
     * user namespaces still has boxes that cannot make one, because
     * `CapDrop: ['ALL']` takes `CAP_SYS_ADMIN` with everything else. That is
     * fixed in the container template and answers to no setting, so it is
     * every deployment's answer and not one host's.
     *
     * The container is the boundary here instead, which is what Codex's own
     * docs say to do when the sandbox cannot start.
     */
    defaultModeId: 'agent-full-access',
    /**
     * The same intent as a Claude fork starting in `plan`: every write asks
     * first. `read-only` is not a read-only sandbox — it is Codex's
     * `on-request` approval with a human reviewer — which is why it is the
     * fork's mode and not a safety boundary. If verify step 3 finds that the
     * sandboxed modes cannot run in the container at all, a fork starts in
     * `agent-full-access` instead and the dashboard says so.
     */
    forkModeId: 'read-only',
    /** Empty: a fresh Codex thread stays on the adapter's own default model. */
    defaultConfig: {},
    sessionMeta: undefined,
    credentialId: 'openai',
    /**
     * `CODEX_API_KEY` is read by the adapter, not by Codex itself: with
     * `DEFAULT_AUTH_REQUEST` naming the `api-key` method, `codex-acp` logs
     * itself in from the environment when a session call finds no account, and
     * Codex persists the key to `$CODEX_HOME/auth.json` from there.
     * `NO_BROWSER` hides the browser-based method, which would otherwise open
     * a browser inside the box.
     *
     * What a box has yet to confirm is that the login accepts a placeholder
     * without validating it against OpenAI first, and that the copy it leaves
     * in `auth.json` — on the persistent home, so it survives a stop — is
     * still the same placeholder on the next start. It is per deployment and
     * never changes, so a stale copy is the right copy. PLAN.md section 3,
     * verify step 5.
     *
     * `CODEX_CA_CERTIFICATE` is deliberately absent. Codex wants it to trust
     * the egress proxy's CA, but that is a fact about the deployment rather
     * than about the harness, so it is set in `sessionEnv` beside
     * `SSL_CERT_FILE` and the other CA variables.
     */
    env: (placeholder: string) => ({
      CODEX_API_KEY: placeholder,
      CODEX_HOME: '/home/agent/.codex',
      NO_BROWSER: '1',
      INITIAL_AGENT_MODE: 'agent-full-access',
      DEFAULT_AUTH_REQUEST: '{"methodId":"api-key"}',
    }),
    /**
     * Codex reads its own instructions from `$CODEX_HOME/AGENTS.md` and its
     * slash commands from `$CODEX_HOME/prompts`, while skills come from the
     * harness-neutral `~/.agents/skills`.
     */
    layout: {
      agentsMd: '.codex/AGENTS.md',
      skills: '.agents/skills',
      commands: '.codex/prompts',
    },
    /** Codex has no tool that backgrounds itself regardless of its input. */
    alwaysBackground: new Set<string>(),
  },
};

/** Every harness id, in the order the dashboard offers them. */
export const HARNESS_IDS: readonly HarnessId[] = Object.keys(HARNESSES) as HarnessId[];

/**
 * The harness a request that names none gets.
 *
 * Claude, because it is what every existing thread runs and what every client
 * from before harnesses existed means. It is a default for callers rather than
 * a preference: nothing inside the orchestrator branches on it.
 */
export const DEFAULT_HARNESS: HarnessId = 'claude';

/**
 * The harness a stored id names.
 *
 * Throws rather than falling back, because every caller has taken the id from
 * a database row or a request body and an id that names no harness means one
 * of those is wrong: a thread would otherwise silently run on the wrong agent.
 */
export function harness(id: string): Harness {
  // Own properties only: `constructor` and `toString` are on every object and
  // name no harness.
  if (!Object.hasOwn(HARNESSES, id)) throw new Error(`Unknown harness: ${id}`);
  return HARNESSES[id as HarnessId];
}
