/**
 * Prompts one view leaves for a box's thread to open with, by box id. The
 * review's "Hand to agent" uses it.
 *
 * Kept outside the history entry's state, because back and then forward would
 * replay that state and stage the prompt again.
 */
const staged = new Map<string, string>();

/** Leaves a prompt for the given box's thread to open with. */
export function stagePrompt(boxId: string, prompt: string): void {
  staged.set(boxId, prompt);
}

/** Takes the staged prompt for a box and clears it. Null when there is none. */
export function takeStagedPrompt(boxId: string): string | null {
  const prompt = staged.get(boxId);
  staged.delete(boxId);
  return prompt ?? null;
}
