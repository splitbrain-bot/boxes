import { cn } from '@/lib/utils';

/**
 * The banner shown while the deployment holds no Claude token.
 *
 * Sessions still start and the dashboard still works; only an agent turn
 * fails, which is not visible until somebody sends a prompt. Saying so up
 * front is the whole point of the banner.
 */
export function TokenWarning({ className }: { className?: string }) {
  return (
    <div className={cn('border-warn/40 bg-warn/10 text-sm', className)}>
      No Claude token is set, so an agent turn cannot run. Set{' '}
      <code className="font-mono">PROFILE_DEFAULT_CLAUDE_CODE_OAUTH_TOKEN</code> and restart
      Boxes, or log in inside a session.
    </div>
  );
}
