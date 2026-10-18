/**
 * The skills of the orchestrator. Each one describes a feature of the
 * deployment, so a box gets it only while the deployment has that feature.
 */

/// <reference types="vite/client" />
import diagrams from '../skills/diagrams/SKILL.md?raw';
import shareApp from '../skills/share-app/SKILL.md?raw';

/** One skill of the orchestrator. */
export interface BuiltinSkill {
  /** The name, which is also the directory of the skill in a skill layout. */
  name: string;
  /** The content of its SKILL.md. */
  content: string;
}

/** The state of the deployment that the conditions of the skills read. */
export interface BuiltinConditions {
  /**
   * Checks if a credential is stored.
   *
   * @param id The id of the credential.
   * @returns True when the credential is stored.
   */
  hasCredential: (id: 'devtunnels') => boolean;
}

/** Every skill of the orchestrator, with the condition under which a box gets it. */
const SKILLS: ReadonlyArray<BuiltinSkill & { available: (c: BuiltinConditions) => boolean }> = [
  // The dashboard renders the Mermaid blocks that this skill teaches.
  { name: 'diagrams', content: diagrams, available: () => true },
  // The tunnel needs the Dev Tunnels credential.
  { name: 'share-app', content: shareApp, available: (c) => c.hasCredential('devtunnels') },
];

/**
 * Gives the skills of the orchestrator whose condition is true now.
 *
 * @param conditions The state of the deployment.
 * @returns The available skills.
 */
export function builtinSkills(conditions: BuiltinConditions): BuiltinSkill[] {
  return SKILLS.filter((skill) => skill.available(conditions)).map(({ name, content }) => ({
    name,
    content,
  }));
}
