/**
 * The filter of the combobox, kept apart from the component so that it can be tested without a browser.
 */

/** One entry of a combobox list. */
export interface ComboboxOption {
  /** The value that the combobox reports when the user selects the entry. */
  value: string;
  /** The name to show, or undefined to show the value. */
  name?: string;
  /** A longer text about the entry, or null or undefined for none. */
  description?: string | null;
}

/**
 * Gives the text that the combobox shows for an entry.
 *
 * @param option The entry.
 * @returns The name, or the value when the entry has no name.
 */
export function optionText(option: ComboboxOption): string {
  return option.name ?? option.value;
}

/**
 * Gives the entries that match a typed text. An entry matches when its name or value holds each word of the text,
 * in any order and without regard to case. An empty text matches each entry.
 *
 * @param options The entries, in the order to show them.
 * @param query The typed text.
 * @returns The matching entries, in their original order.
 */
export function filterOptions<T extends ComboboxOption>(options: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...options];
  return options.filter((option) => {
    const text = `${optionText(option)} ${option.value}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
