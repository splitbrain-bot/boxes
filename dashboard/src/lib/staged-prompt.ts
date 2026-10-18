/**
 * Prompts that one view leaves for the thread of a box to open with, by box id.
 * The "Hand to agent" action of the review uses the map.
 *
 * The map is outside the state of the history entry, because back and then
 * forward would replay that state and stage the prompt again.
 */
const staged = new Map<string, string>();

/**
 * Leaves a prompt for the thread of the given box to open with.
 *
 * @param boxId The id of the box.
 * @param prompt The prompt text.
 */
export function stagePrompt(boxId: string, prompt: string): void {
  staged.set(boxId, prompt);
}

/**
 * Takes the staged prompt for a box and clears it.
 *
 * @param boxId The id of the box.
 * @returns The prompt, or null when there is none.
 */
export function takeStagedPrompt(boxId: string): string | null {
  const prompt = staged.get(boxId);
  staged.delete(boxId);
  return prompt ?? null;
}
