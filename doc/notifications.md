# Push notifications

Boxes can notify browsers that a [thread](threads.md) needs a person, even when no dashboard tab is open. It uses Web
Push: the orchestrator posts an encrypted message to the push service of the browser's vendor, and the browser wakes the
dashboard's service worker to show a notification.

## Notification events

Notifications go out only when no browser is watching the thread. "Watching" means a connected dashboard client has the
thread open. When one watches, it answers permission requests directly and shows the turn as it happens, so no
notification is needed.

The orchestrator sends notifications for exactly two kinds of event. When it sends one, every subscribed browser
receives it.

**Approval needed** — title "Boxes: approval needed". Sent when the agent in a thread asks for a permission decision,
for example to run a command. A thread announces at most one approval per `PERMISSION_HOLD_MINUTES` window (default 120
minutes); further queued requests within the window stay silent.

**Waiting for you** — title "Boxes: waiting for you". Sent when a turn finishes. [ACP](acp.md) has no "turn finished"
signal, so the orchestrator reads the update stream: a thread counts as finished after `AGENT_SETTLE_SECONDS` (default
30 seconds) without agent output and without an open foreground tool call. The settle timer restarts when the agent
speaks again. If background work is still running in the thread, the body ends with "Something is still running."

The body names the box and the thread, for example `mybox · Fix the tests is waiting for a permission decision.` Thread
titles are cut to 80 characters so the payload fits one encrypted record. The notification never contains a command or
other output, because notifications are visible on lock screens.

A notification carries a tag built from the thread and the event kind. A second event of the same kind on the same
thread replaces the first notification instead of stacking below it. A tap opens the thread in an already open dashboard
window when one exists, and in a new window otherwise.

## Enabling notifications

1. Open the dashboard in the browser you want to notify. The page must be a secure context: HTTPS, or localhost.
2. Click **Notify me** in the header of the box list. The browser asks for the notification permission.
3. Grant the permission. The dashboard registers this browser with the orchestrator.

One subscription covers every box and thread of the deployment. Click the same toggle (now labelled **Notifying**) to
unsubscribe this browser again.

Special cases the toggle reports instead of subscribing:

- **Blocked — insecure**: the page is not HTTPS. Put Boxes behind a TLS reverse proxy.
- **Blocked — needs-install**: iOS Safari hides the Push API in a tab. Add Boxes to the Home Screen and open it from
  there.
- **Blocked — denied**: notifications are refused for this site. Only the browser's site settings can undo this.

## Technical internals

### Delivery

`orchestrator/src/notify.ts` builds the payload and `orchestrator/src/push.ts` delivers it, implemented on `node:crypto`
alone: RFC 8291 encrypts the payload for the subscriber, and an RFC 8292 (VAPID) assertion proves this deployment is the
sender. The message is marked high urgency with a TTL of 12 hours. The gateway never awaits a send: a thread waiting on
a person does not also wait on a push service, and every delivery failure is logged, not thrown.

### Subscribing

The dashboard serves a service worker at `/sw.js` and registers it on every page load. The toggle calls the Push API
with `userVisibleOnly: true` and the deployment's VAPID public key from `GET /api/push/key`, then posts the resulting
endpoint and keys to `POST /api/push/subscribe`. The orchestrator validates the endpoint — https, a hostname, not an
address literal or localhost — and stores one row per endpoint in its [database](storage.md). `DELETE
/api/push/subscribe` forgets one. Subscriptions belong to the deployment, not to a user: Boxes has no accounts.

### Receiving

The service worker's `push` handler shows the notification. Browsers revoke the subscription of a worker that shows
nothing, so it shows one even for an unparsable payload. The `notificationclick` handler focuses an open dashboard
window and navigates it to the thread's URL, or opens a new window.

### Housekeeping

- The VAPID keypair is generated on first use and stored as `vapid-keys.json` in `DATA_DIR`. Replacing the data volume
  generates a new keypair, which invalidates every subscription; the orchestrator drops subscriptions made under another
  key on the next send, and the dashboard re-subscribes itself when it detects the key has changed.
- A push service that answers 404 or 410 reports the subscription as gone, and the orchestrator deletes its row at once.
- On every page load the dashboard re-posts its existing subscription, because a push service may replace it at any time
  and Safari expires subscriptions on its own schedule. The service worker also re-subscribes on the browser's
  `pushsubscriptionchange` event.
- `PUSH_SUBJECT` (default `https://github.com/splitbrain/boxes`) is the operator contact carried in every VAPID
  assertion. A push service with a problem contacts this address. Set it to a `mailto:` or `https:` URL that reaches
  you.
