import {
  ComposerPrimitive,
  type Unstable_DirectiveFormatter,
  type Unstable_TriggerItem,
  type Unstable_TriggerMatcher,
} from '@assistant-ui/react';
import { createContext, useContext, useMemo, type FC, type ReactNode } from 'react';
import type { AvailableCommand } from '../stores/thread/acp-types.ts';

/** Composer completion for the slash commands the adapter advertises. */

/** The commands the composer completes, published by the thread route. */
const CommandsContext = createContext<AvailableCommand[]>([]);

/** Puts the adapter's command list where the composer can read it. */
export function SlashCommandsProvider({
  commands,
  children,
}: {
  /** The commands from the thread's session/update stream. */
  commands: AvailableCommand[];
  /** The tree that holds the composer. */
  children: ReactNode;
}) {
  return <CommandsContext.Provider value={commands}>{children}</CommandsContext.Provider>;
}

/**
 * Matches only a slash at the start of the prompt, while the cursor is in the
 * command name. A slash further in is part of a path.
 */
const atStartOfPrompt: Unstable_TriggerMatcher = (text, char, cursorPosition) => {
  if (!text.startsWith(char)) return null;
  const nameEnd = text.indexOf(' ');
  if (nameEnd !== -1 && cursorPosition > nameEnd) return null;
  return { query: text.slice(char.length, cursorPosition), offset: 0, endOffset: cursorPosition };
};

/**
 * Writes the picked command as `/name`, the text the agent reads. The parse
 * half returns the text unchanged, because nothing parses commands back out.
 */
const asTypedCommand: Unstable_DirectiveFormatter = {
  serialize: (item) => `/${item.id}`,
  parse: (text) => [{ kind: 'text', text }],
};

/**
 * Wraps the command list as a trigger adapter.
 *
 * Without categories the popover searches from the first keystroke, so a bare
 * slash lists every command. The search matches names only, because a
 * description match would list commands that look unrelated.
 *
 * @param commands The advertised commands.
 * @returns The adapter.
 */
function commandAdapter(commands: AvailableCommand[]) {
  const items: Unstable_TriggerItem[] = commands.map((command) => ({
    id: command.name,
    type: 'command',
    label: command.name,
    ...(command.description ? { description: command.description } : {}),
  }));
  return {
    categories: () => [],
    categoryItems: () => [],
    search: (query: string) => {
      const lower = query.toLowerCase();
      const named = items.filter((item) => item.id.toLowerCase().includes(lower));
      // Names that start with the query come first.
      return [
        ...named.filter((item) => item.id.toLowerCase().startsWith(lower)),
        ...named.filter((item) => !item.id.toLowerCase().startsWith(lower)),
      ];
    },
  };
}

/**
 * The completion list above the composer while a slash command is typed.
 *
 * Picking a command writes its name into the composer without sending it,
 * because a command often takes arguments.
 */
export const SlashCommands: FC = () => {
  const commands = useContext(CommandsContext);
  const adapter = useMemo(() => commandAdapter(commands), [commands]);
  if (commands.length === 0) return null;

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="/"
      matcher={atStartOfPrompt}
      adapter={adapter}
      className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-64 overflow-y-auto overscroll-contain rounded-xl border bg-popover p-1 shadow-lg"
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Directive formatter={asTypedCommand} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) =>
          items.map((item, index) => (
            <ComposerPrimitive.Unstable_TriggerPopoverItem
              key={item.id}
              item={item}
              index={index}
              className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left data-[highlighted]:bg-accent"
            >
              {/* Both lines break anywhere, so a long word cannot widen the popover
                  past a phone screen. */}
              <span className="w-full font-mono text-sm break-words">/{item.id}</span>
              {item.description ? (
                <span className="line-clamp-2 w-full text-xs break-words text-muted-foreground">
                  {item.description}
                </span>
              ) : null}
            </ComposerPrimitive.Unstable_TriggerPopoverItem>
          ))
        }
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
};
