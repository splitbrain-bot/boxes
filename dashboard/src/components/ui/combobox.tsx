import { ChevronDownIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { type ComboboxOption, filterOptions, optionText } from '@/lib/combobox';
import { cn } from '@/lib/utils';

/**
 * A button that shows the selected entry and opens a list of entries. A text field above the list filters it.
 *
 * @param label The accessible name of the button and the list.
 * @param options The entries, in the order to show them.
 * @param value The value of the selected entry.
 * @param className Extra classes for the button.
 * @param onSelect Called with the value of the entry that the user selected, when it differs from the value.
 */
export function Combobox({
  label,
  options,
  value,
  className,
  onSelect,
}: {
  /** The accessible name of the button and the list. */
  label: string;
  /** The entries, in the order to show them. */
  options: readonly ComboboxOption[];
  /** The value of the selected entry. */
  value: string;
  /** Extra classes for the button. */
  className?: string;
  /** Called with the value of the entry that the user selected, when it differs from the value. */
  onSelect: (value: string) => void;
}) {
  const listId = useId();
  // The list element, as state, because the popover mounts it after the list opens.
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // The value of the active entry. It keeps the entry active when the entries change.
  const [activeValue, setActiveValue] = useState<string | null>(null);

  const selected = options.find((option) => option.value === value);
  const shown = filterOptions(options, query);
  // The position of the active entry in the list, or the first entry when the active entry is not in the list.
  const active = Math.max(
    0,
    shown.findIndex((option) => option.value === activeValue),
  );

  // The active entry stays in view, also when the list opens on an entry far down.
  useEffect(() => {
    list?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [list, active]);

  /**
   * Opens or closes the list. The list opens with an empty filter and the selected entry active.
   *
   * @param next True to open the list, false to close it.
   */
  const openChange = (next: boolean) => {
    setOpen(next);
    setQuery('');
    setActiveValue(value);
  };

  /**
   * Selects an entry and closes the list.
   *
   * @param option The entry.
   */
  const choose = (option: ComboboxOption) => {
    if (option.value !== value) onSelect(option.value);
    openChange(false);
  };

  /**
   * Handles the keys that move through the list and select an entry.
   *
   * @param event The key event of the text field.
   */
  const onFilterKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (shown.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveValue(shown[(active + step + shown.length) % shown.length]?.value ?? null);
    } else if (event.key === 'Enter') {
      const option = shown[active];
      if (option) choose(option);
    }
  };

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={listId}
          title={selected?.description ?? (selected ? optionText(selected) : label)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              openChange(true);
            }
          }}
          className={cn(
            'flex min-w-0 items-center gap-1 rounded-md border bg-muted px-2 py-1 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            className,
          )}
        >
          <span className="min-w-0 flex-1 truncate">{selected ? optionText(selected) : value}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        // The list stays below the button and shrinks to the space there.
        avoidCollisions={false}
        // On a touch device, the on-screen keyboard opens only when the user taps the text field.
        onOpenAutoFocus={(event) => {
          if (window.matchMedia('(pointer: coarse)').matches) event.preventDefault();
        }}
        className="flex w-(--radix-popover-trigger-width) min-w-48 flex-col gap-1 p-1"
      >
        <input
          type="text"
          aria-label="Filter"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
          placeholder="Filter"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveValue(null);
          }}
          onKeyDown={onFilterKeyDown}
          // 16 pixels below the md breakpoint, so a phone does not zoom the page on focus.
          className="min-w-0 rounded-sm border bg-muted px-2 py-1.5 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:text-xs"
        />
        <div
          ref={setList}
          id={listId}
          role="listbox"
          aria-label={label}
          // A press in the list keeps the focus where it is, so an open on-screen keyboard stays open.
          onMouseDown={(event) => event.preventDefault()}
          className="max-h-[min(18rem,var(--radix-popover-content-available-height,18rem))] overflow-y-auto"
        >
          {shown.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No match</p>
          ) : (
            shown.map((option, index) => (
              // biome-ignore lint/a11y/useFocusableInteractive: the text field names the active entry
              // biome-ignore lint/a11y/useKeyWithClickEvents: the keys of the text field select an entry
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
                  'cursor-default truncate rounded-sm px-2 py-1.5 text-xs pointer-coarse:py-2.5 pointer-coarse:text-sm',
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
