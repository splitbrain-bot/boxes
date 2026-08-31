import type { HighlighterCore, ThemedToken } from 'shiki/core';

/**
 * Client-side syntax highlighting for the review's code pane.
 *
 * The API ships plain text and the browser tokenizes it. That keeps render
 * markup off the wire, keeps the orchestrator out of the presentation
 * business, and — the reason it is not just a preference — makes every line an
 * addressable, tappable row rather than a fragment of one HTML blob.
 *
 * Everything here is lazily imported: the engine, the two themes and each
 * grammar. The thread view must not carry any of it, so nothing in this module
 * is reachable from a static import chain outside the review route.
 */

/** How the two themes' colours reach the DOM; see globals.css. */
const THEMES = { light: 'github-light-default', dark: 'github-dark-default' } as const;

/**
 * One line, as the pane renders it: a run of coloured spans.
 *
 * `color` is a CSS declaration list rather than a colour, because Shiki's dual
 * theme emits both themes at once as `--shiki-light` and `--shiki-dark` custom
 * properties. One tokenize pass then covers light and dark, and switching
 * theme needs no re-tokenize at all.
 */
export interface Token {
  content: string;
  style: Record<string, string>;
}

/** The grammars worth loading, by the language name the API reports. */
const GRAMMARS: Record<string, () => Promise<unknown>> = {
  typescript: () => import('@shikijs/langs/typescript'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  html: () => import('@shikijs/langs/html'),
  markdown: () => import('@shikijs/langs/markdown'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  ini: () => import('@shikijs/langs/ini'),
  bash: () => import('@shikijs/langs/bash'),
  docker: () => import('@shikijs/langs/docker'),
  makefile: () => import('@shikijs/langs/make'),
  go: () => import('@shikijs/langs/go'),
  python: () => import('@shikijs/langs/python'),
  rust: () => import('@shikijs/langs/rust'),
  java: () => import('@shikijs/langs/java'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  ruby: () => import('@shikijs/langs/ruby'),
  php: () => import('@shikijs/langs/php'),
  swift: () => import('@shikijs/langs/swift'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  lua: () => import('@shikijs/langs/lua'),
  perl: () => import('@shikijs/langs/perl'),
  r: () => import('@shikijs/langs/r'),
  scala: () => import('@shikijs/langs/scala'),
  dart: () => import('@shikijs/langs/dart'),
  vue: () => import('@shikijs/langs/vue'),
  svelte: () => import('@shikijs/langs/svelte'),
  sql: () => import('@shikijs/langs/sql'),
  xml: () => import('@shikijs/langs/xml'),
  diff: () => import('@shikijs/langs/diff'),
};

/** Whether a language has a grammar to load at all. */
export function canHighlight(language: string): boolean {
  return language in GRAMMARS;
}

let core: Promise<HighlighterCore> | null = null;

/**
 * The shared highlighter, created on first use.
 *
 * The JavaScript regex engine rather than the oniguruma one: it needs no wasm
 * fetch, which is a whole extra request on a phone. `forgiving` skips a pattern
 * it cannot compile instead of throwing, which is the right trade for
 * decoration — a grammar the engine only partly supports still colours most of
 * the file.
 */
async function highlighter(): Promise<HighlighterCore> {
  if (!core) {
    core = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
      ]);
      return createHighlighterCore({
        themes: [
          import('@shikijs/themes/github-light-default'),
          import('@shikijs/themes/github-dark-default'),
        ],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      });
    })();
  }
  return core;
}

/** Grammars already loaded or loading, so a re-render costs nothing. */
const loaded = new Map<string, Promise<void>>();

/** Loads one grammar into the shared highlighter, at most once. */
async function loadGrammar(language: string): Promise<void> {
  const grammar = GRAMMARS[language];
  if (!grammar) return;
  let pending = loaded.get(language);
  if (!pending) {
    pending = (async () => {
      const core = await highlighter();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await core.loadLanguage((await grammar()) as any);
    })();
    loaded.set(language, pending);
  }
  return pending;
}

/**
 * How long a line may be before the file is rendered un-tokenized.
 *
 * A minified bundle is one line of a hundred thousand characters, and
 * tokenizing it would jank the tab for seconds. Rendering it as plain text is
 * both faster and no less readable.
 */
const MAX_LINE = 2000;

/** How many lines are worth tokenizing. Past this the pane renders plain. */
const MAX_LINES = 8000;

/**
 * Tokenizes a file into one token list per line, or null when it should be
 * rendered plain — no grammar for the language, a pathological line, or a
 * failure in the grammar itself.
 *
 * Returning null rather than throwing is deliberate: highlighting is
 * decoration, and a file that cannot be coloured still has to be readable and
 * commentable.
 */
export async function tokenizeLines(
  content: string,
  language: string,
): Promise<Token[][] | null> {
  if (!canHighlight(language)) return null;

  const lines = content.split('\n');
  if (lines.length > MAX_LINES) return null;
  if (lines.some((line) => line.length > MAX_LINE)) return null;

  try {
    await loadGrammar(language);
    const core = await highlighter();
    const { tokens } = core.codeToTokens(content, {
      lang: language,
      themes: THEMES,
      // Both themes as custom properties and no committed default, so the
      // page's own light/dark class decides which one paints.
      defaultColor: false,
    });
    return tokens.map(toLine);
  } catch {
    return null;
  }
}

/** One Shiki line, reduced to what the pane renders. */
function toLine(tokens: ThemedToken[]): Token[] {
  return tokens.map((token) => ({
    content: token.content,
    style: token.htmlStyle && typeof token.htmlStyle === 'object' ? token.htmlStyle : {},
  }));
}
