import { describe, expect, it } from 'vitest';
import { bearerChallenge } from '../../shared/www-authenticate.ts';

describe('bearerChallenge', () => {
  it('reads the parameters of the Bearer challenge, quoted or not', () => {
    expect(
      bearerChallenge(
        'Bearer error="insufficient_scope", scope="files:read files:write", ' +
          'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
      ),
    ).toEqual({
      error: 'insufficient_scope',
      scope: 'files:read files:write',
      resource_metadata: 'https://mcp.example.com/.well-known/oauth-protected-resource',
    });
    expect(bearerChallenge('bearer Error=invalid_token')).toEqual({ error: 'invalid_token' });
    expect(bearerChallenge('Bearer')).toEqual({});
  });

  it('skips the challenges of other schemes, and a quoted value keeps its escaped quote', () => {
    expect(
      bearerChallenge(
        'Basic realm="a, b", Bearer realm="x\\"y", error="invalid_token", DPoP algs="ES256"',
      ),
    ).toEqual({ realm: 'x"y', error: 'invalid_token' });
  });

  it('gives null without a Bearer challenge', () => {
    expect(bearerChallenge(undefined)).toBeNull();
    expect(bearerChallenge('Basic realm="x"')).toBeNull();
    expect(bearerChallenge('')).toBeNull();
  });
});
