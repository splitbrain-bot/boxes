import { Skeleton } from '@/components/ui/skeleton';

/**
 * What a thread shows before it has been read: the shape of a conversation,
 * pulsing, and nothing that can be acted on.
 *
 * This is the whole arrival sequence for a box with something in it. A
 * composer over a greeting would say the thread is empty, which on arrival at
 * a conversation is both wrong and about to be contradicted — and the
 * replay it is contradicted by is not a thing to watch happen. So: one
 * placeholder, then the conversation, once, at its end.
 *
 * Shaped like the reading column it stands in for, and weighted like a
 * conversation — a short prompt on the right, an answer under it — so the
 * swap moves the eye as little as possible.
 */
export function ThreadLoading() {
  return (
    <div
      data-slot="thread-loading"
      role="status"
      className="mx-auto flex w-full max-w-[44rem] flex-col gap-6 px-4 pt-4"
    >
      <span className="sr-only">Loading the conversation</span>
      {/* Two exchanges rather than one: a single bubble reads as a message
          that has arrived, and this is not one. */}
      {[0, 1].map((exchange) => (
        <div key={exchange} className="flex flex-col gap-6">
          <Skeleton className="ml-auto h-9 w-2/5 rounded-xl motion-reduce:animate-none" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
            <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
            <Skeleton className="h-4 w-3/5 motion-reduce:animate-none" />
          </div>
        </div>
      ))}
    </div>
  );
}
