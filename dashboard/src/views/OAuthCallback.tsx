import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { BackLink } from '@/components/BackLink';
import { Loading } from '@/components/Loading';
import { Notice } from '@/components/Notice';
import { useUp } from '@/hooks/use-up';
import { api } from '../api.ts';

/**
 * Page that the authorization server redirects to after the OAuth login of an
 * MCP server. It sends the parameters of the redirect to the API, and then
 * opens the set of the server or shows the error.
 */
export function OAuthCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  /** Goes back to the list of sets. */
  const up = useUp('/agents');
  const [error, setError] = useState<string | null>(null);
  /** True after the first send, because the API accepts each login once. */
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const value = (name: string): string | undefined => params.get(name) ?? undefined;
    void (async () => {
      try {
        const { setId } = await api.mcpOAuthCallback({
          state: value('state') ?? '',
          code: value('code'),
          iss: value('iss'),
          error: value('error'),
          errorDescription: value('error_description'),
        });
        navigate(`/agents/${setId}`, { replace: true });
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [params, navigate]);

  return (
    <div className="flex flex-col gap-4">
      <BackLink up={up} label="Agent configuration" />
      {error ? <Notice className="rounded-md border px-3 py-2">{error}</Notice> : <Loading />}
    </div>
  );
}
