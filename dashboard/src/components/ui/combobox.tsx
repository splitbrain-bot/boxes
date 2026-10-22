import { useEffect, useId, useRef, useState } from 'react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { type ComboboxOption, filterOptions, optionText } from '@/lib/combobox';
import { cn } from '@/lib/utils';

/**
 * A text input with a list of entries below it. The list shows only the entries that match the typed text.
 *
 * The combobox accepts only an entry of the list. Typed text that matches no entry does not change the value.
 *
 * @param label The accessible name of the input.
 * @param options The entries, in the order to show them.
 * @param value The value of the selected entry.
 * @param className Extra classes for the input.
 * @param onSelect Called with the value of the entry that the user selected, when it differs from the value.
 */
export function Combobox({
  label,
  options,
  value,
  className,
  onSelect,
}: {
  /** The accessible name of the input. */
  label: string;
  /** The entries, in the order to show them. */
  options: readonly ComboboxOption[];
  /** The value of the selected entry. */
  value: string;
  /** Extra classes for the input. */
  className?: string;
  /** Called with the value of the entry that the user selected, when it differs from the value. */
  onSelect: (value: string) => void;
}) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // The typed text, or null while the input shows the selected entry.
  const [query, setQuery] = useState<string | null>(null);
  // The value of the active entry. It keeps the entry active when the entries change.
  const [activeValue, setActiveValue] = useState<string | null>(null);

  const selected = options.find((option) => option.value === value);
  const shown = filterOptions(options, query ?? '');
  // The position of the active entry in the list, or the first entry when the active entry is not in the list.
  const active = Math.max(
    0,
    shown.findIndex((option) => option.value === activeValue),
  );

  // The active entry stays in view, also when the list opens on an entry far down.
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  /**
   * Opens the list with the selected entry active.
   */
  const openList = () => {
    setActiveValue(value);
    setOpen(true);
  };

  /**
   * Closes the list and shows the selected entry in the input again.
   */
  const close = () => {
    setOpen(false);
    setQuery(null);
  };

  /**
   * Selects an entry and closes the list.
   *
   * @param option The entry.
   */
  const choose = (option: ComboboxOption) => {
    if (option.value !== value) onSelect(option.value);
    close();
  };

  /**
   * Handles the keys that open the list, move through it and select an entry.
   *
   * Enter never submits a form that holds the combobox. On a closed list, it opens the list.
   *
   * @param event The key event of the input.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      if (shown.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveValue(shown[(active + step + shown.length) % shown.length]?.value ?? null);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      const option = shown[active];
      if (option) choose(option);
    }
  };

  /**
   * Keeps the list open on a click or a focus in the input, which Radix counts as outside of the list.
   *
   * @param event The outside event of Radix.
   */
  const inInput = (event: Event) => {
    if (event.target instanceof Node && input.current?.contains(event.target)) {
      event.preventDefault();
    }
  };

  return (
    <Popover open={open} onOpenChange={(next) => (next ? openList() : close())}>
      <PopoverAnchor asChild>
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && shown[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          title={selected?.description ?? (selected ? optionText(selected) : label)}
          value={query ?? (selected ? optionText(selected) : value)}
          onFocus={(event) => {
            event.target.select();
            openList();
          }}
          onClick={() => {
            if (!open) openList();
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveValue(null);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onBlur={close}
          // 16 pixels below the md breakpoint, so a phone does not zoom the page on focus.
          className={cn(
            'min-w-0 rounded-md border bg-muted px-2 py-1 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:text-xs',
            className,
          )}
        />
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        // Radix flips the list above the input when it lacks space below.
        avoidCollisions={false}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={inInput}
        onFocusOutside={inInput}
        // A press in the list keeps the focus in the input, so the input does not close the list on blur.
        onMouseDown={(event) => event.preventDefault()}
        className="w-(--radix-popover-trigger-width) min-w-48 p-1"
      >
        <div
          ref={list}
          id={listId}
          role="listbox"
          aria-label={label}
          className="max-h-[min(18rem,var(--radix-popover-content-available-height))] overflow-y-auto"
        >
          {shown.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No match</p>
          ) : (
            shown.map((option, index) => (
              // biome-ignore lint/a11y/useFocusableInteractive: the input keeps the focus and names the active entry
              // biome-ignore lint/a11y/useKeyWithClickEvents: the keys of the input select an entry
              <div
                key={option.value}
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={option.value === value}
                title={option.description ?? undefined}
                onMouseMove={() => {
                  if (index !== active) setActiveValue(option.value);
                }}
                onClick={() => choose(option)}
                className={cn(
                  'cursor-default truncate rounded-sm px-2 py-1.5 text-xs',
                  index === active && 'bg-accent text-accent-foreground',
                  option.value === value && 'font-medium',
                )}
              >
                {optionText(option)}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
