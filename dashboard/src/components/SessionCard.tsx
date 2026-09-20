import {
  FileSearch,
  GitBranch,
  HardDrive,
  Info,
  Plus,
  Square,
  SquareTerminal,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { SessionSummary, ThreadSummary } from '../../../shared/types.ts';
import { DOT, StatusBadge, type BadgeKind } from './StatusBadge';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { NewThreadDialog } from '@/components/NewThreadDialog';
import { Card } from '@/components/ui/card';
import { api } from '../api.ts';
import { STILL_RUNNING } from '@/lib/activity';
import { harnessLabel } from '@/lib/harness';
import { shortAge, shortSize } from '@/lib/rough';
import { threadName } from '@/lib/threads';
import { refresh, useSessions } from '../stores/sessions.ts';
import { cn } from '@/lib/utils';

/**
 * Builds the badges for a session: waiting approvals, a running turn, the
 * session's own state, and how many browsers are watching.
 *
 * The turn and approval counts are the session's, derived from every thread
 * it owns, so a box with one busy thread reads as busy. Which thread that is
 * is the rows' job, below.
 */
export function sessionBadges(s: SessionSummary): Array<{ kind: BadgeKind; label: string }> {
  const badges: Array<{ kind: BadgeKind; label: string }> = [];
  if (s.pendingCount > 0) {
    badges.push({
      kind: 'waiting',
      label: s.pendingCount === 1 ? 'waiting for approval' : `${s.pendingCount} approvals waiting`,
    });
  }
  // What the agent is doing, rather than whether a request is open upstream:
  // a prompt held open for a background subagent is not a running turn to
  // anybody reading this list.
  if (s.speaking) badges.push({ kind: 'turn', label: 'running turn' });
  if (s.backgroundBusy) badges.push({ kind: 'task', label: STILL_RUNNING });
  if (s.status === 'error') badges.push({ kind: 'error', label: 'error' });
  else if (s.dockerState === 'running') badges.push({ kind: 'running', label: 'up' });
  else badges.push({ kind: 'idle', label: s.status });
  if (s.attachedCount > 0) {
    badges.push({
      kind: 'idle',
      label: s.attachedCount === 1 ? '1 viewer' : `${s.attachedCount} viewers`,
    });
  }
  return badges;
}

/**
 * One session in the list, with its conversations under it. Tapping the card
 * opens whichever one is current; tapping a thread opens that one.
 *
 * The thread rows are plain links, because opening a thread is now a plain
 * navigation: the connection names its own thread, so nothing has to be
 * switched first. Opening one still makes it the session's default, but as a
 * fire-and-forget POST that neither blocks the navigation nor disturbs
 * anybody — no live connection is pinned to the default.
 *
 * Ops live behind the info corner, and the two sit side by side rather than
 * nested, because an anchor inside an anchor is invalid markup. Where the
 * details view goes back to is not something this link has to say: it goes
 * back, and the entry it goes back to is this list.
 */
export function SessionCard({ session }: { session: SessionSummary }) {
  const navigate = useNavigate();
  /** Held while a thread call is in flight, so a double tap cannot fork twice. */
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Whether the new-thread dialog is up. */
  const [starting, setStarting] = useState(false);
  /** Whether the box-wide kill is waiting to be confirmed. */
  const [stopping, setStopping] = useState(false);
  // What each thread's agent is called. Off the health probe the list is
  // polling anyway rather than a call of its own: a row needs the label and
  // nothing else about the harness, and the dialog is what needs the rest.
  const { harnesses } = useSessions();

  /**
   * Runs one thread call and opens the thread it made. Answers whether it
   * got there, so a caller with a dialog up knows whether to take it down.
   *
   * `replace` spends the current history entry on the thread instead of
   * pushing over it. It is what the dialog wants: opening one pushes an entry
   * at this same URL for the back button to pop (see ui/dialog), and the
   * thread it starts belongs in that entry rather than on top of it —
   * otherwise back from the new thread lands on the list twice.
   */
  async function open(
    work: () => Promise<ThreadSummary>,
    replace = false,
  ): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const created = await work();
      // The card's own thread list comes from the poll, so a change made here
      // is visible on the way back rather than a reload later.
      void refresh();
      await navigate(`/sessions/${session.id}/threads/${created.id}`, { replace });
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Kills everything running in the box and asks the list what it looks like
   * afterwards.
   *
   * Nothing is guessed at here: what the button offers comes from the
   * orchestrator's reading of the box, and so does whether it is still
   * offered a moment later. A signal takes a couple of seconds to become an
   * absence in the process table, and until it does the box is still busy.
   */
  async function stopEverything(): Promise<void> {
    setStopping(false);
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.stopBoxWork(session.id);
      void refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const current = session.threads.find((t) => t.id === session.currentThreadId);
  /**
   * Whether this box holds work that no conversation in it claims.
   *
   * The bars are per thread and come from the adapters, which know only about
   * the tasks they themselves announced: after a respawn an adapter knows
   * nothing about the shells the one before it left running, and the only
   * thing that still sees them is the orchestrator's reading of the process
   * table. That is the gap this offer fills — the box says it is busy, no
   * thread says what with, and nothing else in the dashboard can stop it.
   */
  const orphaned = session.backgroundBusy && !session.threads.some((t) => t.backgroundBusy);
  // What the thread ages are measured from. Read at render rather than kept on
  // a timer: the list is polled every five seconds and every answer re-renders
  // this card, which is a finer clock than an indicator in whole minutes and
  // hours needs. A tab in the background stops polling, and the age it shows
  // is as stale as everything else on the card until it comes back.
  const now = Date.now();

  return (
    <Card className="relative gap-0 overflow-hidden py-0 transition-colors hover:border-ring">
      <Link
        to={`/sessions/${session.id}`}
        className="flex flex-col gap-1 px-4 pt-4 pb-3 no-underline"
      >
        <div className="flex items-baseline gap-2 pr-9">
          <span className="truncate font-medium">{session.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{session.id}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {sessionBadges(session).map((b) => (
            <StatusBadge key={b.label} kind={b.kind} label={b.label} />
          ))}
          {/* How much disk the box has taken — its workspace and its home
              together. Not a badge: it is a measurement rather than a state,
              and giving it a pill of its own would put it in the row that
              says what the session is doing. Absent until the orchestrator
              has measured one — a zero would be a claim about a box nobody
              has looked at yet. */}
          {session.diskBytes === null ? null : (
            <span
              className="inline-flex items-center gap-1 text-xs text-muted-foreground"
              title="Workspace and home on disk"
            >
              <HardDrive className="size-3" aria-hidden />
              {shortSize(session.diskBytes)}
            </span>
          )}
        </div>
      </Link>
      <Link
        to={`/sessions/${session.id}/info`}
        aria-label={`Details and controls for ${session.name}`}
        className="absolute top-3 right-3 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <Info className="size-4" />
      </Link>

      <div className="flex flex-col border-t px-2 py-2">
        {session.threads.map((thread) => {
          const dot = threadDot(thread);
          return (
            <Link
              key={thread.id}
              to={`/sessions/${session.id}/threads/${thread.id}`}
              // Selecting is a side effect of opening, not a step before it:
              // the navigation does not wait for it, and nothing breaks if it
              // never lands.
              onClick={() => void api.selectThread(session.id, thread.id).catch(() => {})}
              aria-current={thread.id === session.currentThreadId ? 'true' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm no-underline hover:bg-accent',
                thread.id === session.currentThreadId ? 'font-medium' : 'text-muted-foreground',
              )}
            >
              {/* Which thread this is is said by the weight of the row and by
                  aria-current; the bullet is what it is doing. */}
              <span
                role="img"
                aria-label={dot.label}
                title={dot.label}
                className={cn('size-1.5 shrink-0 rounded-full', DOT[dot.kind])}
              />
              {/* A conversation the reader has marked finished with is struck
                  through, and that is the whole of the difference: it is
                  still here, still opens, still runs. */}
              <span className={cn('min-w-0 flex-1 truncate', thread.done && 'line-through')}>
                {threadName(thread)}
              </span>
              {/* Which agent is on the other end of this conversation, which
                  is what its mode and its model mean — and, in a box holding
                  a thread of each, the difference between two rows that
                  otherwise look alike. Quiet: it is a fact about the thread
                  rather than a state of it. */}
              {harnessLabel(harnesses, thread.harness) ? (
                <span className="shrink-0 text-xs opacity-70">
                  {harnessLabel(harnesses, thread.harness)}
                </span>
              ) : null}
              {/* How long since this conversation last did anything, which is
                  what picks the one you were in out of a box with six. Rough,
                  and rounded down: the question is this morning or last week,
                  and the exact moment is on the details view. */}
              <time
                dateTime={new Date(thread.lastActiveAt).toISOString()}
                title={`Last active ${new Date(thread.lastActiveAt).toLocaleString()}`}
                className="shrink-0 tabular-nums opacity-70"
              >
                {shortAge(now - thread.lastActiveAt)}
              </time>
            </Link>
          );
        })}

        <div className="flex gap-1 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => setStarting(true)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
          >
            <Plus className="size-3.5" />
            New thread
          </button>
          {/* Reviewing works whether or not the box is running: the files are
              a directory the orchestrator reads, so a stopped session — the
              natural moment, once the agent is done — needs no start. */}
          <Link
            to={`/sessions/${session.id}/review`}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground no-underline hover:bg-accent hover:text-accent-foreground"
          >
            <FileSearch className="size-3.5" />
            Review
          </Link>
          {/* The box seen directly, rather than through the agent. Names no
              thread: a terminal belongs to the box, and every one opened on
              it is the same shell. */}
          <Link
            to={`/sessions/${session.id}/terminal`}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground no-underline hover:bg-accent hover:text-accent-foreground"
          >
            <SquareTerminal className="size-3.5" />
            Terminal
          </Link>
          {/* Forking needs a thread to fork and that thread's own adapter to
              have advertised the capability, which is unstable in the ACP
              schema and may be absent — and a box may hold threads of two
              harnesses, each answering for itself. */}
          {current?.canFork ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void open(() => api.createThread(session.id, { from: current.id }))}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
            >
              <GitBranch className="size-3.5" />
              Fork
            </button>
          ) : null}
          {/* Only for work nobody claims: while a thread has a task of its
              own, its own bar is where that gets stopped, by name and with
              the adapter rather than with a signal. */}
          {orphaned ? (
            <button
              type="button"
              disabled={busy}
              aria-label="Stop everything running in this box"
              onClick={() => setStopping(true)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
            >
              <Square className="size-3.5" />
              Stop everything
            </button>
          ) : null}
        </div>

        {error ? (
          <div className="px-2 pt-1 text-xs text-danger" role="alert">
            {error}
          </div>
        ) : null}

        {stopping ? (
          <ConfirmDialog
            title="Stop everything running in this box?"
            description={
              'Kills every command still running in it, whoever started it, and anything ' +
              'those commands started. Half-done work stays half-done, and nothing will ' +
              'report back. The box itself keeps running.'
            }
            confirmLabel="Stop"
            danger
            busy={busy}
            onConfirm={() => void stopEverything()}
            onCancel={() => setStopping(false)}
          />
        ) : null}

        {/* Asked before it is started, because the agent a thread runs is
            fixed for the life of its transcript. Forking asks nothing: it
            stays on its source's harness with its source's settings. */}
        {starting ? (
          <NewThreadDialog
            busy={busy}
            onCancel={() => setStarting(false)}
            // Left up while the thread is being made, and taken down only if
            // it could not be: closing it first would pop its history entry
            // from under the navigation that is still in flight, and the pop
            // would land after the push and undo it.
            onCreate={(options) => {
              void open(
                () => api.createThread(session.id, options ? { options } : {}),
                true,
              ).then((opened) => {
                if (!opened) setStarting(false);
              });
            }}
          />
        ) : null}
      </div>
    </Card>
  );
}

/**
 * The bullet on a thread's row: what that conversation is doing, in one dot,
 * and the whole of what a row says about it.
 *
 * Which thread is the session's default is not among them: the row says that
 * twice already, in its weight and in `aria-current`. Being up is a
 * precondition of every state here.
 *
 * The order is what outranks what, and it is the reader's order rather than
 * the machine's: a question stops everything, talking is next, and work still
 * running is the quiet one worth seeing, because it is the thread holding the
 * box awake. Labelled as well as coloured, because a dot with no label says
 * nothing to a screen reader.
 */
function threadDot(thread: ThreadSummary): { kind: BadgeKind; label: string } {
  if (thread.pendingCount > 0) return { kind: 'waiting', label: 'waiting for approval' };
  if (thread.speaking) return { kind: 'turn', label: 'running a turn' };
  if (thread.backgroundBusy) return { kind: 'task', label: 'something still running' };
  return { kind: 'idle', label: 'idle' };
}

