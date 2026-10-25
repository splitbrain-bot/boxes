/**
 * A fake MCP server and its fake authorization server for the tests of the
 * OAuth client. Both answer through one fetch function, without a network.
 */

import { createHash } from 'node:crypto';
import type { OAuthFetch, OAuthRequest } from './mcp-oauth.ts';

/** The settings of a fake. */
export interface FakeOAuthOptions {
  /** The URL of the MCP server. */
  mcpUrl?: string;
  /** The issuer of the authorization server. */
  issuer?: string;
  /** True when the 401 of the MCP server names the metadata and a scope. */
  challenge?: boolean;
  /** True when the authorization server has a registration endpoint. */
  dcr?: boolean;
  /** True when the authorization server sends `iss` in each authorization response. */
  issParameter?: boolean;
  /** The token endpoint auth methods that the metadata lists. */
  authMethods?: string[];
  /** The lifetime of an access token in seconds, or null for a token without an expiry. */
  expiresIn?: number | null;
  /** True when the token endpoint returns refresh tokens. */
  refreshTokens?: boolean;
}

/** One request to the fake. */
export interface FakeRequest {
  /** The method. */
  method: string;
  /** The URL. */
  url: string;
  /** The headers, with lowercase names. */
  headers: Record<string, string>;
  /** The form or JSON fields of the body. */
  fields: Record<string, string | string[]>;
}

/** A fake MCP server with its authorization server. */
export interface FakeOAuth {
  /** The fetch function that answers for both servers. */
  fetch: OAuthFetch;
  /** Each request, in order. */
  requests: FakeRequest[];
  /** The URL of the MCP server. */
  mcpUrl: string;
  /** The issuer. */
  issuer: string;
  /** The error that the token endpoint gives to each refresh, or null for a good refresh. */
  refreshError: string | null;
  /**
   * Follows an authorization URL as the browser and the user would.
   *
   * @param url The authorization URL.
   * @returns The parameters of the redirect.
   */
  authorize(url: string): URLSearchParams;
}

/**
 * Makes a fake MCP server with its authorization server.
 *
 * @param options The settings of the fake.
 * @returns The fake.
 */
export function fakeOAuth(options: FakeOAuthOptions = {}): FakeOAuth {
  const mcpUrl = options.mcpUrl ?? 'https://mcp.example.com/mcp';
  const issuer = options.issuer ?? 'https://auth.example.com/tenant';
  const resourceOrigin = new URL(mcpUrl).origin;
  const resourcePath = new URL(mcpUrl).pathname;
  const metadataUrl = `${resourceOrigin}/.well-known/oauth-protected-resource${resourcePath}`;
  const issuerUrl = new URL(issuer);
  const asMetadataUrl = `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname.replace(/\/$/, '')}`;
  const requests: FakeRequest[] = [];
  /** The PKCE challenge, the client and the redirect URI of each issued code. */
  const codes = new Map<string, { challenge: string; client: string; redirectUri: string }>();
  /** The refresh tokens that work, each once. */
  const refreshTokens = new Set<string>();
  let counter = 0;

  /**
   * Makes a JSON answer.
   *
   * @param status The status.
   * @param body The body.
   * @param headers More headers.
   * @returns The answer.
   */
  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

  /**
   * Makes a token answer.
   *
   * @returns The answer with a new access token and, when the fake returns them, a refresh token.
   */
  const tokens = (): Response => {
    counter += 1;
    const refresh = options.refreshTokens === false ? undefined : `rt-${counter}`;
    if (refresh) refreshTokens.add(refresh);
    const expiresIn = options.expiresIn === undefined ? 3600 : options.expiresIn;
    return json(200, {
      access_token: `at-${counter}`,
      token_type: 'Bearer',
      ...(expiresIn === null ? {} : { expires_in: expiresIn }),
      ...(refresh ? { refresh_token: refresh } : {}),
    });
  };

  const fake: FakeOAuth = {
    requests,
    mcpUrl,
    issuer,
    refreshError: null,
    fetch: async (url: string, init: OAuthRequest) => {
      const method = init.method ?? 'GET';
      const headers = Object.fromEntries(
        Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
      );
      const text = init.body === undefined ? '' : String(init.body);
      const fields: Record<string, string | string[]> =
        headers['content-type']?.includes('json') && text !== ''
          ? (JSON.parse(text) as Record<string, string | string[]>)
          : Object.fromEntries(new URLSearchParams(text));
      requests.push({ method, url, headers, fields });

      if (url === mcpUrl && method === 'POST') {
        const challenge: Record<string, string> =
          options.challenge === false
            ? {}
            : {
                'www-authenticate': `Bearer error="invalid_request", resource_metadata="${metadataUrl}", scope="read"`,
              };
        return json(401, { error: 'unauthorized' }, challenge);
      }
      if (url === metadataUrl) {
        return json(200, {
          resource: mcpUrl,
          authorization_servers: [issuer],
          scopes_supported: ['read', 'write'],
        });
      }
      if (url === asMetadataUrl) {
        return json(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          ...(options.dcr === false ? {} : { registration_endpoint: `${issuer}/register` }),
          scopes_supported: ['read', 'write', 'offline_access'],
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: options.authMethods ?? ['none'],
          authorization_response_iss_parameter_supported: options.issParameter ?? true,
        });
      }
      if (url === `${issuer}/register` && method === 'POST') {
        counter += 1;
        return json(201, {
          ...fields,
          client_id: `dcr-${counter}`,
        });
      }
      if (url === `${issuer}/token` && method === 'POST') {
        if (fields.resource !== mcpUrl) return json(400, { error: 'invalid_target' });
        if (fields.grant_type === 'authorization_code') {
          const code = codes.get(String(fields.code));
          codes.delete(String(fields.code));
          const verifier = createHash('sha256')
            .update(String(fields.code_verifier))
            .digest('base64url');
          if (!code || code.challenge !== verifier || code.redirectUri !== fields.redirect_uri) {
            return json(400, { error: 'invalid_grant' });
          }
          return tokens();
        }
        if (fields.grant_type === 'refresh_token') {
          if (fake.refreshError) return json(400, { error: fake.refreshError });
          if (!refreshTokens.delete(String(fields.refresh_token))) {
            return json(400, { error: 'invalid_grant' });
          }
          return tokens();
        }
      }
      return json(404, { error: 'not found' });
    },
    authorize: (url: string) => {
      const query = new URL(url).searchParams;
      counter += 1;
      const code = `code-${counter}`;
      codes.set(code, {
        challenge: query.get('code_challenge') ?? '',
        client: query.get('client_id') ?? '',
        redirectUri: query.get('redirect_uri') ?? '',
      });
      return new URLSearchParams({
        code,
        state: query.get('state') ?? '',
        ...(options.issParameter === false ? {} : { iss: issuer }),
      });
    },
  };
  return fake;
}
