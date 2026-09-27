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
 * How many scrolled-off lines the terminal keeps. The tmux scrollback in the
 * box outlives this tab.
 */
const SCROLLBACK = 2000;

/**
 * Reads the terminal's colours from the page's CSS variables, which follow the
 * system scheme.
 *
 * @returns The xterm theme.
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

/**
 * Formats the notice for a closed terminal.
 *
 * @param detail The close reason, if any.
 * @returns One line for the notice.
 */
function closedText(detail: string | undefined): string {
  return detail ? `The terminal closed: ${detail}` : 'The terminal closed.';
}

/**
 * Page with a shell in the box's container, at `/boxes/:id/terminal`.
 *
 * Every terminal on one box attaches to the same tmux session, so two tabs
 * show the same shell. The box keeps running while this page is open.
 */
export function BoxTerminal() {
  const { id = '' } = useParams();
  const { box } = useBox(id);
  const up = useUp('/');
  const name = box?.name ?? id;
  const token = box?.wsToken ?? null;

  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const [detail, setDetail] = useState<string | undefined>(undefined);
  /** Counter that the reconnect button bumps to open a new connection. */
  const [attempt, setAttempt] = useState(0);

  const host = useRef<HTMLDivElement>(null);

  // Locks the page, so a phone keyboard cannot push the terminal off the screen.
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
        // Sent before any input, so the first prompt has the right width.
        if (next === 'ready') socket.resize(term.cols, term.rows);
      },
    });

    const typed = term.onData((data) => socket.send(data));

    // A full-screen program needs the pty size after every change, such as a
    // rotated phone or an opened keyboard.
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
            {/* Starting a box that the reaper stopped takes seconds. */}
            {status === 'connecting' ? ' · opening a shell in the box…' : ''}
          </span>
        </div>
        {status === 'closed' ? (
          <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={reconnect}>
            Reconnect
          </Button>
        ) : null}
      </header>

      {status === 'closed' ? (
        <Notice className="shrink-0 border-b px-3 py-2" tone="warn">
          {closedText(detail)}
        </Notice>
      ) : null}

      {/* The page background matches the terminal's below the last row. */}
      <div ref={host} className="min-h-0 flex-1 overflow-hidden bg-background px-2 py-1" />
    </div>
  );
}
