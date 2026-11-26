import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AgentSetSummary } from '../../../shared/types.ts';

/**
 * Selects the agent sets of a box as a list in the order of selection. A new set goes to the end of the list, so the
 * user changes the order by removing a set and adding it again.
 *
 * @param sets The named sets of the user, without the global set.
 * @param value The ids of the selected sets, in the order of the merge.
 * @param onChange Receives the new list of ids after each change.
 * @param disabled Disables all controls, for example while a request runs.
 * @param id The id of the select that adds a set, for a label.
 */
export function AgentSetPicker({
  sets,
  value,
  onChange,
  disabled = false,
  id,
}: {
  sets: AgentSetSummary[];
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  id?: string;
}) {
  const selected = value
    .map((setId) => sets.find((s) => s.id === setId))
    .filter((s): s is AgentSetSummary => s !== undefined);
  const available = sets.filter((s) => !value.includes(s.id));

  return (
    <div className="flex flex-col gap-2">
      {selected.length === 0 ? (
        <p className="text-sm text-muted-foreground">Global set only</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {selected.map((s) => (
            <li
              key={s.id}
              className="flex items-center gap-2 rounded-md border py-1 pr-1 pl-3 text-sm"
            >
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove ${s.name}`}
                disabled={disabled}
                onClick={() => onChange(value.filter((setId) => setId !== s.id))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ol>
      )}
      {available.length > 0 ? (
        // The empty value keeps the placeholder after each selection.
        <Select value="" disabled={disabled} onValueChange={(setId) => onChange([...value, setId])}>
          <SelectTrigger id={id} aria-label="Add an agent set" className="w-full">
            <SelectValue placeholder="Add a set" />
          </SelectTrigger>
          <SelectContent>
            {available.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {selected.length > 1 ? (
        <p className="text-xs text-muted-foreground">
          A later set replaces skills and MCP servers with the same name from an earlier set.
        </p>
      ) : null}
    </div>
  );
}
