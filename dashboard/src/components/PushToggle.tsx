import { Bell, BellOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  disablePush,
  enablePush,
  usePush,
  type PushBlocker,
} from '../stores/push.ts';

/**
 * Why this browser cannot be notified, in terms of what the user would have to
 * change. The disabled toggle shows it as its tooltip, because the list header
 * has no room for a sentence.
 */
const BLOCKED: Record<PushBlocker, string> = {
  insecure: 'Notifications need HTTPS. Put Boxes behind a TLS reverse proxy.',
  'needs-install': 'Add Boxes to your Home Screen to enable notifications.',
  unsupported: 'This browser cannot receive push notifications.',
  denied: 'Notifications are blocked for this site in your browser settings.',
};

/**
 * Toggle that subscribes this browser to notifications about boxes that need
 * the user. One subscription covers every box.
 */
export function PushToggle() {
  const { supported, blocker, subscribed, busy, error } = usePush();

  if (!supported) {
    return blocker ? (
      <Button variant="ghost" size="sm" disabled title={BLOCKED[blocker]}>
        <BellOff />
        Blocked
      </Button>
    ) : null;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => void (subscribed ? disablePush() : enablePush())}
        aria-pressed={subscribed}
        title={
          subscribed
            ? 'Stop notifying this browser'
            : 'Notify this browser when a box needs you'
        }
      >
        {subscribed ? <Bell /> : <BellOff />}
        {subscribed ? 'Notifying' : 'Notify me'}
      </Button>
      {error ? (
        <span className="text-xs text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
