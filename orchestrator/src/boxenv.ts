import type { CredentialId, CredentialMethod } from './credentials.ts';
import { HOME_DIR } from './docker.ts';
import { HARNESSES } from './harness.ts';

/**
 * Where the entrypoint writes the system authorities together with the
 * deployment CA, and where the CA env vars point.
 */
const CA_PATH = `${HOME_DIR}/.boxes/ca-bundle.crt`;

/** What the environment of a box is built from. */
export interface BoxEnvInputs {
  /** The placeholder the egress proxy swaps for a stored credential. */
  placeholderFor: (credentialId: string) => string;
  /** The method a stored credential is used with, or null when none is stored. */
  methodFor: (credentialId: CredentialId) => CredentialMethod | null;
  /** The git identity from the settings. */
  identity: { gitName: string; gitEmail: string };
  /** The GitLab host the GitLab credential is for. */
  gitlabHost: string;
  /** The URL of the egress proxy, as a box reaches it. */
  proxyUrl: string;
  /**
   * PEM of the deployment CA this box trusts. It is set even before any
   * credential exists, as the box keeps it for its whole life.
   */
  caCertificate: string;
}

/**
 * The full environment of a box, as a plain record. The runtime converts it
 * to its own format. Variables with an empty value are left out.
 *
 * It carries the credential placeholders, never a real credential. The CA
 * travels here as a PEM, so it needs no file on the host.
 *
 * Every harness adds its variables, even one no thread in the box uses. Each
 * credential value is a placeholder that the egress proxy swaps for the real
 * secret. A credential that is not stored has none, and its variable is
 * dropped: the environment is fixed at container creation, so a credential
 * entered later reaches the box at its next restart.
 *
 * GH_TOKEN is for git and gh. GITLAB_TOKEN and GITLAB_HOST are the same for
 * git and glab. DEVTUNNELS_TOKEN is the GitHub token the Dev Tunnels API
 * takes, for the share-app skill.
 */
export function boxEnv(inputs: BoxEnvInputs): Record<string, string> {
  const env: Record<string, string> = {};
  for (const harness of Object.values(HARNESSES)) {
    const id = harness.credentialId;
    Object.assign(env, harness.env(inputs.placeholderFor(id), inputs.methodFor(id)));
  }
  env['GH_TOKEN'] = inputs.placeholderFor('github');
  env['GITLAB_TOKEN'] = inputs.placeholderFor('gitlab');
  env['GITLAB_HOST'] = inputs.gitlabHost;
  env['DEVTUNNELS_TOKEN'] = inputs.placeholderFor('devtunnels');
  env['GIT_NAME'] = inputs.identity.gitName;
  env['GIT_EMAIL'] = inputs.identity.gitEmail;

  env['TERM'] = 'dumb';
  // Every proxy-aware client honours these; anything else has no route
  // out, which is the intended failure mode.
  env['HTTP_PROXY'] = inputs.proxyUrl;
  env['HTTPS_PROXY'] = inputs.proxyUrl;
  env['http_proxy'] = inputs.proxyUrl;
  env['https_proxy'] = inputs.proxyUrl;
  env['NO_PROXY'] = 'localhost,127.0.0.1';
  env['no_proxy'] = 'localhost,127.0.0.1';

  if (inputs.caCertificate !== '') {
    // The entrypoint appends the PEM to the system authorities in CA_PATH;
    // these are the variables that point node, gh, git, git-lfs, curl and
    // Codex at it. A tool honouring none of them fails TLS against the
    // intercepted hosts and nothing else.
    env['BOXES_PROXY_CA'] = inputs.caCertificate;
    env['NODE_EXTRA_CA_CERTS'] = CA_PATH;
    env['SSL_CERT_FILE'] = CA_PATH;
    env['GIT_SSL_CAINFO'] = CA_PATH;
    env['CURL_CA_BUNDLE'] = CA_PATH;
    // Codex reads this one first and falls back to SSL_CERT_FILE. It is
    // unconfirmed whether the published Codex binary reads either.
    env['CODEX_CA_CERTIFICATE'] = CA_PATH;
  }

  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
}
