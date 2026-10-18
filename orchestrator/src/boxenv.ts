import type { CredentialId, CredentialMethod } from './credentials.ts';
import { HARNESSES } from './harness.ts';
import { HOME_DIR } from './runtime/runtime.ts';

/**
 * Where the box setup writes the system authorities together with the
 * deployment CA, and where the CA env vars point.
 */
const CA_PATH = `${HOME_DIR}/.boxes/ca-bundle.crt`;

/** What the environment of a box is built from. */
export interface BoxEnvInputs {
  /** The placeholder the egress proxy swaps for a stored credential. */
  placeholderFor: (credentialId: string) => string;
  /** The method a stored credential is used with, or null when none is stored. */
  methodFor: (credentialId: CredentialId) => CredentialMethod | null;
  /** The GitLab host the GitLab credential is for. */
  gitlabHost: string;
  /** The URL of the egress proxy, as a box reaches it. */
  proxyUrl: string;
  /** True when the deployment has a CA, which the box trusts. */
  hasCa: boolean;
  /** The placeholder of each API key a user added, by its variable name. */
  apiKeys: Readonly<Record<string, string>>;
}

/**
 * Variables the box image or the runtime sets, which an API key must not
 * replace.
 */
const IMAGE_ENV_NAMES = [
  'CODEX_PATH',
  'HOME',
  'HOSTNAME',
  'LANG',
  'NPM_CONFIG_PREFIX',
  'PATH',
  'SHELL',
  'TMPDIR',
  'USER',
];

/**
 * The full environment of a box, as a plain record. The runtime converts it
 * to its own format. Variables with an empty value are left out.
 *
 * It carries the credential placeholders, never a real credential.
 *
 * Every harness adds its variables, even one no thread in the box uses. Each
 * credential value is a placeholder that the egress proxy swaps for the real
 * secret. A credential that is not stored has none, and its variable is
 * dropped: the environment is fixed at container creation, so a credential
 * entered later reaches the box at its next restart.
 *
 * GH_TOKEN is for git and gh. GITLAB_TOKEN and GITLAB_HOST are the same for
 * git and glab. DEVTUNNELS_TOKEN is the GitHub token the Dev Tunnels API
 * takes, for the share-app skill. The API keys a user added come first, so a
 * variable of Boxes wins over one with the same name.
 */
export function boxEnv(inputs: BoxEnvInputs): Record<string, string> {
  const env: Record<string, string> = { ...inputs.apiKeys };
  for (const harness of Object.values(HARNESSES)) {
    const id = harness.credentialId;
    Object.assign(env, harness.env(inputs.placeholderFor(id), inputs.methodFor(id)));
  }
  env.GH_TOKEN = inputs.placeholderFor('github');
  env.GITLAB_TOKEN = inputs.placeholderFor('gitlab');
  env.GITLAB_HOST = inputs.gitlabHost;
  env.DEVTUNNELS_TOKEN = inputs.placeholderFor('devtunnels');

  env.TERM = 'dumb';
  // Every proxy-aware client honours these; anything else has no route
  // out, which is the intended failure mode.
  env.HTTP_PROXY = inputs.proxyUrl;
  env.HTTPS_PROXY = inputs.proxyUrl;
  env.http_proxy = inputs.proxyUrl;
  env.https_proxy = inputs.proxyUrl;
  env.NO_PROXY = 'localhost,127.0.0.1';
  env.no_proxy = 'localhost,127.0.0.1';

  if (inputs.hasCa) {
    // The box setup appends the CA to the system authorities in CA_PATH;
    // these are the variables that point node, gh, git, git-lfs, curl and
    // Codex at it. A tool honouring none of them fails TLS against the
    // intercepted hosts and nothing else.
    env.NODE_EXTRA_CA_CERTS = CA_PATH;
    env.SSL_CERT_FILE = CA_PATH;
    env.GIT_SSL_CAINFO = CA_PATH;
    env.CURL_CA_BUNDLE = CA_PATH;
    // Codex reads this one first and falls back to SSL_CERT_FILE. It is
    // unconfirmed whether the published Codex binary reads either.
    env.CODEX_CA_CERTIFICATE = CA_PATH;
  }

  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
}

/**
 * The variables an API key cannot be named by: those boxEnv sets for any
 * stored credential, and those the box image or the runtime sets.
 */
export function reservedEnvNames(): ReadonlySet<string> {
  const names = new Set(IMAGE_ENV_NAMES);
  // The Claude variable follows the method, so both methods are asked.
  for (const method of ['token', 'api_key'] as const) {
    const env = boxEnv({
      placeholderFor: () => 'set',
      methodFor: () => method,
      gitlabHost: 'set',
      proxyUrl: 'set',
      hasCa: true,
      apiKeys: {},
    });
    for (const name of Object.keys(env)) names.add(name);
  }
  return names;
}
