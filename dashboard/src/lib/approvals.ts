/** The answer to a permission request, as a card passes it on. */

import { createContext } from 'react';

/** One answer to the permission request of a tool call. */
export interface ApprovalAnswer {
  /** The id of the request, as the thread store numbered it. */
  approvalId: string;
  /** True for an answer that lets the call run, when the request offered no options. */
  approved?: boolean;
  /** The option the user picked, when the request offered options. */
  optionId?: string;
}

/**
 * Answers a permission request outside the runtime.
 *
 * The cards inside a sub agent render in a readonly thread, whose runtime drops an answer. The thread view
 * provides the function, and a card uses it in place of the runtime when it is there.
 */
export const ApprovalResponderContext = createContext<((answer: ApprovalAnswer) => void) | null>(
  null,
);
