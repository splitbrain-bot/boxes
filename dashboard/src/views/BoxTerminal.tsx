import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/Notice';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useBox } from '@/hooks/use-box';
import { useUp } from '@/hooks/use-up';
import { useViewportLock } from '@/hooks/use-viewport-lock';
import { TerminalSocket, type TerminalStatus } from '@/lib/terminal-socket';
import { terminalUrlFor } from '@/lib/ws-url';
import '@xterm/xterm/css/xterm.css';

/**
 * How many lines of what has scrolled past the terminal keeps.
 *
 * Enough to scroll back over the command on screen. The scrollback that
 * matters is tmux's, in the box, which survives this tab closing.
 */
const SCROLLBACK = 2000;

/**
 * The terminal's palette, read off the page's own.
 *
 * The scheme follows the system, so a second copy of the colours here would
 * drift from the one the rest of the page uses.
 */
function themeFromPage(): { background: string; foreground: string; cursor: string } {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    background: read('--background', '#14161a'),
    foreground: read('--foreground', '#e8eaf0'),
    cursor: read('--foreground', '#e8eaf0'),
  };
}

/** Why a closed terminal closed, in a line. */
function closedText(detail: string | undefined): string {
  return detail ? `The terminal closed: ${detail}` : 'The terminal closed.';
}

/**
 * A shell in the box's container, at `/boxes/:id/terminal`.
 *
 * Names the box rather than a conversation. Every terminal opened on one
 * box attaches to the same tmux box, so two tabs show the same shell.
 * The box is held running for as long as this page is open.
 *
 * Owns the whole viewport, because a full-screen program in the box needs
 * every row it can be given.
 */
export function BoxTerminal() {
  const { id = '' } = useParams();
  const { box } = useBox(id);
  const up = useUp('/');
  const name = box?.name ?? id;
  const token = box?.wsToken ?? null;

  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const [detail, setDetail] = useState<string | undefined>(undefined);
  /** Bumped to open a new connection, which is what the reconnect button does. */
  const [attempt, setAttempt] = useState(0);

  const host = useRef<HTMLDivElement>(null);

  // The address bar is hidden and the page does not scroll: the terminal
  // fills the viewport, and a phone keyboard must not push it off the screen.
  useViewportLock();
  useDocumentTitle(`Terminal · ${name}`);

  useEffect(() => {
    const element = host.current;
    // The token arrives with the box, one request after the first render.
    if (!element || !token) return;

    const term = new Terminal({
      scrollback: SCROLLBACK,
      fontSize: 13,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      theme: themeFromPage(),
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    fit.fit();

    const socket = new TerminalSocket(terminalUrlFor(id), token, {
      onData: (bytes) => term.write(bytes),
      onStatus: (next, why) => {
        setStatus(next);
        setDetail(why);
        // Before anything is typed, so the shell draws its first prompt at the
        // width it is being read at.
        if (next === 'ready') socket.resize(term.cols, term.rows);
      },
    });

    const typed = term.onData((data) => socket.send(data));

    // A full-screen program draws over the wrong area unless the pty is told
    // every time the rows change — a rotated phone, a keyboard coming up.
    const resized = new ResizeObserver(() => {
      fit.fit();
      socket.resize(term.cols, term.rows);
    });
    resized.observe(element);

    term.focus();

    return () => {
      resized.disconnect();
      typed.dispose();
      socket.close();
      term.dispose();
    };
  }, [id, token, attempt]);

  const reconnect = useCallback(() => {
    setStatus('connecting');
    setDetail(undefined);
    setAttempt((n) => n + 1);
  }, []);

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Button asChild variant="ghost" size="sm" className="shrink-0 px-2">
          <a href={up.href} onClick={up.onClick} aria-label="Back">
            <ArrowLeft className="size-4" />
          </a>
        </Button>
        <div className="flex min-w-16 flex-1 flex-col">
          <span className="truncate text-sm font-medium">Terminal</span>
          <span className="truncate text-xs text-muted-foreground">
            {name}
            {/* Starting a box the reaper took runs into seconds, so the wait
                says what it is waiting for. */}
            {status === 'connecting' ? ' · opening a shell in the box…' : ''}
          </span>
        </div>
        {status === 'closed' ? (
          <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={reconnect}>
            Reconnect
          </Button>
        ) : null}
      </header>

      {/* A working terminal is its own status, and one that is opening says so
          in the header. */}
      {status === 'closed' ? (
        <Notice className="shrink-0 border-b px-3 py-2" tone="warn">
          {closedText(detail)}
        </Notice>
      ) : null}

      {/* The page's own background, so the area under the last row matches the
          rows above it. */}
      <div ref={host} className="min-h-0 flex-1 overflow-hidden bg-background px-2 py-1" />
    </div>
  );
}
