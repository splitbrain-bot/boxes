/**
 * Client-side syntax highlighting for the review's code pane and for the code
 * blocks in chat output.
 *
 * The text is tokenized into one token list per line, so each line can be its
 * own row. The engine, the themes and the grammars are imported lazily, so only
 * a view that shows code loads them.
 */

import type { HighlighterCore, LanguageInput, ThemedToken } from 'shiki/core';

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

/** The grammars that can be loaded, by language name. */
const GRAMMARS: Record<string, LanguageInput> = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
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

/** Other names of the languages in {@link GRAMMARS}, as the info string of a markdown code fence often gives them. */
const ALIASES: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  py: 'python',
  yml: 'yaml',
  md: 'markdown',
  dockerfile: 'docker',
  make: 'makefile',
  golang: 'go',
  rb: 'ruby',
  rs: 'rust',
  'c++': 'cpp',
  cs: 'csharp',
  kt: 'kotlin',
  htm: 'html',
  patch: 'diff',
};

/**
 * Gives the name of the grammar for a language name or an alias.
 *
 * @param language A language name that the API reports, or an alias of one.
 * @returns The key in {@link GRAMMARS}, or null when no grammar exists.
 */
function grammarName(language: string): string | null {
  const name = language.toLowerCase();
  const resolved = ALIASES[name] ?? name;
  return resolved in GRAMMARS ? resolved : null;
}

/** The shared highlighter, once {@link highlighter} has started creating it. */
let core: Promise<HighlighterCore> | null = null;

/**
 * Gives the shared highlighter, created on first use.
 *
 * Uses the JavaScript regex engine, which needs no wasm download. In
 * `forgiving` mode it skips a pattern it cannot compile, so a grammar it
 * supports only in part still colours most of the file.
 *
 * @returns The highlighter.
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

/**
 * Loads one grammar into the shared highlighter, at most once.
 *
 * @param language A key in {@link GRAMMARS}.
 */
async function loadGrammar(language: string): Promise<void> {
  const grammar = GRAMMARS[language];
  if (!grammar) return;
  let pending = loaded.get(language);
  if (!pending) {
    pending = (async () => {
      const core = await highlighter();
      await core.loadLanguage(grammar);
    })();
    loaded.set(language, pending);
  }
  return pending;
}

/**
 * The maximum line length, in characters, for a file that the pane tokenizes.
 *
 * A minified bundle is one very long line, and tokenizing it would block the
 * tab for seconds.
 */
const MAX_LINE = 2000;

/**
 * The maximum number of lines for a file that the pane colours and renders one
 * row per line. The pane shows a longer file as one plain block.
 */
const MAX_LINES = 8000;

/**
 * Checks if a file is short enough to colour and to render one row per line.
 *
 * Stops counting at the limit and allocates nothing.
 *
 * @param content The text of the file.
 * @returns True when the file has at most {@link MAX_LINES} lines.
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
 *
 * @param content The text of the file.
 * @param language The language name that the API reports, or an alias of one.
 * @returns One token list per line, or null for a plain file.
 */
export async function tokenizeLines(content: string, language: string): Promise<Token[][] | null> {
  const grammar = grammarName(language);
  if (!grammar) return null;
  if (!withinLineLimit(content)) return null;
  if (content.split('\n').some((line) => line.length > MAX_LINE)) return null;

  try {
    await loadGrammar(grammar);
    const core = await highlighter();
    const { tokens } = core.codeToTokens(content, {
      lang: grammar,
      themes: THEMES,
      // No default colour, so the page's .dark class picks the theme.
      defaultColor: false,
    });
    return tokens.map(toLine);
  } catch {
    return null;
  }
}

/**
 * Reduces one Shiki line to what the pane renders.
 *
 * @param tokens The Shiki tokens of the line.
 * @returns The tokens of the line.
 */
function toLine(tokens: ThemedToken[]): Token[] {
  return tokens.map((token) => ({
    content: token.content,
    style: token.htmlStyle && typeof token.htmlStyle === 'object' ? token.htmlStyle : {},
  }));
}
