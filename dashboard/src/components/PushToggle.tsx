import { Bell, BellOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  disablePush,
  enablePush,
  usePush,
  type PushBlocker,
} from '../stores/push.ts';

/**
 * Why this browser cannot be notified, in the terms of the thing the user
 * would have to change.
 *
 * Each of these is a real deployment people hit: Boxes reached over plain
 * HTTP on a LAN address, an iPhone reading it in a Safari tab, a permission
 * turned down months ago and forgotten about.
 *
 * Shown as the tooltip of a spent toggle rather than as text next to it: the
 * list header has room for a button and not for a sentence, and none of these
 * is something to act on right now.
 */
const BLOCKED: Record<PushBlocker, string> = {
  insecure: 'Notifications need HTTPS. Put Boxes behind a TLS reverse proxy.',
  'needs-install': 'Add Boxes to your Home Screen to enable notifications.',
  unsupported: 'This browser cannot receive push notifications.',
  denied: 'Notifications are blocked for this site in your browser settings.',
};

/**
 * Subscribes this browser to notifications about sessions that want
 * something, and says why it cannot when it cannot.
 *
 * Deployment-wide rather than per session: a subscription is this browser's,
 * and every box notifies through it.
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
            : 'Notify this browser when a session needs you'
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
