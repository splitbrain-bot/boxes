import type { HighlighterCore, ThemedToken } from 'shiki/core';

/**
 * Client-side syntax highlighting for the review's code pane.
 *
 * The API sends plain text, so each line can be its own row. The engine, the
 * themes and the grammars are imported lazily, so only the review route loads
 * them.
 */

/** The Shiki themes for light and dark mode. */
const THEMES = { light: 'github-light-default', dark: 'github-dark-default' } as const;

/** One coloured span of a line, as the pane renders it. */
export interface Token {
  /** The text of the span. */
  content: string;
  /**
   * CSS properties for the span. They hold the colour of both themes as
   * `--shiki-light` and `--shiki-dark`, so switching theme needs no new
   * tokenize pass.
   */
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
function canHighlight(language: string): boolean {
  return language in GRAMMARS;
}

/** The shared highlighter, once {@link highlighter} has started creating it. */
let core: Promise<HighlighterCore> | null = null;

/**
 * The shared highlighter, created on first use.
 *
 * Uses the JavaScript regex engine, which needs no wasm download. In
 * `forgiving` mode it skips a pattern it cannot compile, so a grammar it
 * supports only in part still colours most of the file.
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
 * The longest line, in characters, a file may have and still be tokenized.
 *
 * A minified bundle is one very long line, and tokenizing it would block the
 * tab for seconds.
 */
const MAX_LINE = 2000;

/**
 * The most lines a file may have and still be coloured and rendered one row
 * per line. The pane shows a longer file as one plain block.
 */
const MAX_LINES = 8000;

/**
 * Whether a file is short enough to colour and to render one row per line.
 *
 * Stops counting at the limit and allocates nothing.
 */
export function withinLineLimit(content: string): boolean {
  let lines = 1;
  for (let at = content.indexOf('\n'); at >= 0; at = content.indexOf('\n', at + 1)) {
    if (++lines > MAX_LINES) return false;
  }
  return true;
}

/**
 * Tokenizes a file into one token list per line.
 *
 * Returns null, and never throws, when the file should be rendered plain: no
 * grammar for the language, too many lines, a line that is too long, or a
 * failure in the grammar.
 */
export async function tokenizeLines(
  content: string,
  language: string,
): Promise<Token[][] | null> {
  if (!canHighlight(language)) return null;
  if (!withinLineLimit(content)) return null;
  if (content.split('\n').some((line) => line.length > MAX_LINE)) return null;

  try {
    await loadGrammar(language);
    const core = await highlighter();
    const { tokens } = core.codeToTokens(content, {
      lang: language,
      themes: THEMES,
      // No default colour, so the page's .dark class picks the theme.
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
