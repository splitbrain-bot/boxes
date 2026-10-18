/**
 * Store for the Web Push registration of this browser. The registration lets
 * the browser show notifications while Boxes is closed.
 */

import { useSyncExternalStore } from 'react';
import { api } from '../api.ts';

/** The reason why this browser cannot subscribe. */
export type PushBlocker =
  /** The page is not a secure context, so service workers are unavailable. */
  | 'insecure'
  /**
   * The Push API is missing while the page runs in a tab, as on iOS Safari
   * before the page is added to the Home Screen.
   */
  | 'needs-install'
  /** The browser has no service workers or no Push API. */
  | 'unsupported'
  /** The user refused notifications. Only the site settings can undo the refusal. */
  | 'denied';

/** The state that the toggle renders. */
export interface PushState {
  /** True when this browser could subscribe if asked. */
  supported: boolean;
  /** The reason why this browser cannot subscribe, or null. */
  blocker: PushBlocker | null;
  /** True once this browser is registered with the orchestrator. */
  subscribed: boolean;
  /** True while a subscribe or unsubscribe is in flight. */
  busy: boolean;
  /** The error message of the last attempt, or null. */
  error: string | null;
}

/** The current state. */
let state: PushState = {
  supported: false,
  blocker: 'unsupported',
  subscribed: false,
  busy: false,
  error: null,
};
/** The callbacks to run on every state change. */
const listeners = new Set<() => void>();

/**
 * Merges `next` into the state and notifies every subscriber.
 *
 * @param next The fields to change.
 */
function set(next: Partial<PushState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

/**
 * Adds a subscriber.
 *
 * @param listener The callback to run on every state change.
 * @returns The function that removes the subscriber.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Reads the registration state, re-rendering on every change.
 *
 * @returns The current state.
 */
export function usePush(): PushState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/**
 * Checks if this browser runs the page as an installed app.
 *
 * @returns True for an installed app.
 */
function installed(): boolean {
  const legacy = (navigator as { standalone?: boolean }).standalone;
  return legacy === true || window.matchMedia('(display-mode: standalone)').matches;
}

/**
 * Finds the blocker that stops this browser from subscribing.
 *
 * @returns The blocker, or null when the browser can subscribe.
 */
function blockerOf(): PushBlocker | null {
  if (!window.isSecureContext) return 'insecure';
  if (!('serviceWorker' in navigator)) return 'unsupported';
  if (!('PushManager' in window) || !('Notification' in window)) {
    // iOS hides the Push API until the page is added to the Home Screen.
    return installed() ? 'unsupported' : 'needs-install';
  }
  if (Notification.permission === 'denied') return 'denied';
  return null;
}

/**
 * Encodes bytes as unpadded base64url, the form of the deployment's key.
 *
 * @param bytes The bytes to encode.
 * @returns The base64url text.
 */
function b64url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Checks if a subscription uses the key the deployment holds now.
 *
 * A deployment with a replaced data volume generates a new keypair. The push
 * service then rejects every subscription made with the old key, and the
 * browser never learns about it.
 *
 * @param subscription The push subscription of the browser.
 * @param publicKey The public key of the deployment, as base64url.
 * @returns True when the subscription uses the key.
 */
function matchesDeployment(subscription: PushSubscription, publicKey: string): boolean {
  const key = subscription.options.applicationServerKey;
  return key ? b64url(key) === publicKey : false;
}

/**
 * Registers the service worker. A repeated call gets the same registration.
 *
 * @returns The registration.
 */
async function worker(): Promise<ServiceWorkerRegistration> {
  // The scope is the whole origin, so sw.js lives at the root.
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

/**
 * Registers the service worker, even when a blocker stops push.
 *
 * Some browsers offer to install the app only once a worker is registered.
 * An iPhone in a tab has to install the app before it can subscribe.
 *
 * Resolves either way, because nothing on the page depends on the outcome.
 */
export async function installWorker(): Promise<void> {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
  await worker().catch(() => undefined);
}

/**
 * Brings the store up to date and re-registers a browser that is already
 * subscribed.
 *
 * A push service may replace a subscription at any time. The orchestrator learns the new subscription from
 * this call or from the service worker. It keys subscriptions by endpoint, so
 * posting the same subscription twice keeps one row.
 */
export async function refreshPush(): Promise<void> {
  const blocker = blockerOf();
  if (blocker) {
    set({ supported: false, blocker, subscribed: false });
    return;
  }
  set({ supported: true, blocker: null });

  try {
    const registration = await worker();
    let existing = await registration.pushManager.getSubscription();
    if (!existing) {
      set({ subscribed: false });
      return;
    }

    const { publicKey } = await api.pushKey();
    if (!matchesDeployment(existing, publicKey)) {
      // Permission is already granted, so re-subscribing needs no user gesture.
      await api.unsubscribePush(existing.endpoint).catch(() => {});
      await existing.unsubscribe();
      existing = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: publicKey,
      });
    }

    await api.subscribePush({
      ...(existing.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }),
      label: navigator.userAgent.slice(0, 100),
    });
    set({ subscribed: true, error: null });
  } catch (err) {
    set({ subscribed: false, error: (err as Error).message });
  }
}

/**
 * Asks for permission and subscribes this browser.
 *
 * Only a click may call it. Some browsers refuse a permission request without
 * a user gesture, and others penalize the origin.
 */
export async function enablePush(): Promise<void> {
  if (state.busy) return;
  set({ busy: true, error: null });
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'denied') {
      // Only the site settings can undo the refusal, so the toggle stops offering push.
      set({ supported: false, blocker: 'denied' });
      return;
    }
    if (permission !== 'granted') {
      // Dismissed, not refused. The toggle stays, so the user can retry.
      return;
    }

    const registration = await worker();
    // Subscribing needs an active worker.
    await navigator.serviceWorker.ready;
    const { publicKey } = await api.pushKey();
    // Reuses the existing subscription only if it matches the current key.
    const existing = await registration.pushManager.getSubscription();
    if (existing && !matchesDeployment(existing, publicKey)) await existing.unsubscribe();
    const subscription =
      existing && matchesDeployment(existing, publicKey)
        ? existing
        : await registration.pushManager.subscribe({
            // Chrome requires every push to show a notification.
            userVisibleOnly: true,
            applicationServerKey: publicKey,
          });

    await api.subscribePush({
      ...(subscription.toJSON() as {
        endpoint: string;
        keys: { p256dh: string; auth: string };
      }),
      label: navigator.userAgent.slice(0, 100),
    });
    set({ subscribed: true, supported: true, blocker: null });
  } catch (err) {
    set({ error: (err as Error).message });
  } finally {
    set({ busy: false });
  }
}

/**
 * Unsubscribes this browser, in the orchestrator and in the browser.
 *
 * The function tells the orchestrator first. Otherwise, the orchestrator keeps
 * pushing to the dropped subscription until the push service reports that the
 * subscription is gone.
 */
export async function disablePush(): Promise<void> {
  if (state.busy) return;
  set({ busy: true, error: null });
  try {
    const registration = await worker();
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await api.unsubscribePush(subscription.endpoint).catch(() => {});
      await subscription.unsubscribe();
    }
    set({ subscribed: false });
  } catch (err) {
    set({ error: (err as Error).message });
  } finally {
    set({ busy: false });
  }
}
