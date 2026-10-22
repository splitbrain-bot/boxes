import { describe, expect, test } from 'vitest';
import { filterOptions, optionText } from './combobox.ts';

/** A part of a long model list, as opencode sends it. */
const MODELS = [
  { value: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle' },
  { value: 'openrouter/anthropic/claude-sonnet-4.5', name: 'OpenRouter/Claude Sonnet 4.5' },
  { value: 'openrouter/openai/gpt-5.6', name: 'OpenRouter/GPT-5.6' },
  { value: 'openrouter/qwen/qwen3-coder' },
];

describe('the combobox filter', () => {
  test('gives each entry, in its order, for an empty text', () => {
    expect(filterOptions(MODELS, '')).toEqual(MODELS);
    expect(filterOptions(MODELS, '   ')).toEqual(MODELS);
  });

  test('finds the text in the name or in the value, without regard to case', () => {
    expect(filterOptions(MODELS, 'pickle').map((m) => m.value)).toEqual(['opencode/big-pickle']);
    expect(filterOptions(MODELS, 'ANTHROPIC').map((m) => m.value)).toEqual([
      'openrouter/anthropic/claude-sonnet-4.5',
    ]);
    // An entry without a name matches on its value.
    expect(filterOptions(MODELS, 'qwen3').map((m) => m.value)).toEqual([
      'openrouter/qwen/qwen3-coder',
    ]);
  });

  test('needs each word, in any order', () => {
    expect(filterOptions(MODELS, 'sonnet openrouter').map((m) => m.value)).toEqual([
      'openrouter/anthropic/claude-sonnet-4.5',
    ]);
    expect(filterOptions(MODELS, 'openrouter').length).toBe(3);
    expect(filterOptions(MODELS, 'sonnet gpt')).toEqual([]);
  });

  test('shows the name of an entry, or its value when it has no name', () => {
    expect(optionText(MODELS[0]!)).toBe('OpenCode Zen/Big Pickle');
    expect(optionText(MODELS[3]!)).toBe('openrouter/qwen/qwen3-coder');
  });
});
