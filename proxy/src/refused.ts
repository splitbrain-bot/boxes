/** The targets that the egress profile of each box refused, for the box details page. */

import type { EgressDenial } from '../../shared/types.ts';

/** The number of refused targets that the list keeps for each box. */
export const MAX_REFUSED_TARGETS = 50;

/** The refused targets of all boxes, in memory. */
export class RefusedTargets {
  /**
   * The entries of each box, by box id. The entries of a box are keyed by host
   * and port, and the most recent entry is the last one.
   */
  private readonly byBox = new Map<string, Map<string, EgressDenial>>();

  /**
   * Records one refused attempt. A box keeps only its
   * {@link MAX_REFUSED_TARGETS} most recent targets.
   *
   * @param box The id of the box that sent the request.
   * @param host The hostname or the IP literal of the target.
   * @param port The port of the target.
   * @param category The category of the denial.
   * @param now The time of the attempt, in epoch milliseconds.
   */
  record(box: string, host: string, port: number, category: string, now = Date.now()): void {
    const list = this.byBox.get(box) ?? new Map<string, EgressDenial>();
    this.byBox.set(box, list);
    const key = `${host}:${port}`;
    const previous = list.get(key);
    // The delete makes the set put the entry at the end, so the first entry is the oldest.
    list.delete(key);
    list.set(key, { host, port, category, count: (previous?.count ?? 0) + 1, lastAt: now });
    const oldest = list.keys().next().value;
    if (list.size > MAX_REFUSED_TARGETS && oldest !== undefined) list.delete(oldest);
  }

  /**
   * Lists the refused targets of a box.
   *
   * @param box The id of the box.
   * @returns The refused targets, the most recent first.
   */
  list(box: string): EgressDenial[] {
    return [...(this.byBox.get(box)?.values() ?? [])].reverse();
  }

  /**
   * Drops the lists of the boxes that are not in a set.
   *
   * @param boxes The ids of the boxes whose lists stay.
   */
  retain(boxes: ReadonlySet<string>): void {
    for (const box of this.byBox.keys()) {
      if (!boxes.has(box)) this.byBox.delete(box);
    }
  }
}
