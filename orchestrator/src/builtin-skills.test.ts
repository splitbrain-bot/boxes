import assert from 'node:assert/strict';
import { test } from 'vitest';
import { builtinSkills } from './builtin-skills.ts';

test('environment and diagrams always, share-app only with the Dev Tunnels credential', () => {
  const names = (has: boolean) => builtinSkills({ hasCredential: () => has }).map((s) => s.name);
  assert.deepEqual(names(false), ['environment', 'diagrams']);
  assert.deepEqual(names(true), ['environment', 'diagrams', 'share-app']);
});

test('the content is the SKILL.md of the skill', () => {
  for (const skill of builtinSkills({ hasCredential: () => true })) {
    assert.match(skill.content, new RegExp(`^---\\nname: ${skill.name}\\n`));
  }
});
