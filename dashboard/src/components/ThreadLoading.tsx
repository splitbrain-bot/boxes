import { Skeleton } from '@/components/ui/skeleton';

/**
 * Pulsing placeholder in the shape of a conversation, shown until the thread
 * has been read.
 *
 * It replaces the composer, which would suggest an empty thread while the
 * replay runs. Its layout matches the reading column, so the swap moves the
 * eye little.
 */
export function ThreadLoading() {
  return (
    <div
      data-slot="thread-loading"
      role="status"
      className="mx-auto flex w-full max-w-[44rem] flex-col gap-6 px-4 pt-4"
    >
      <span className="sr-only">Loading the conversation</span>
      {/* Two exchanges, because a single bubble reads as an arrived message. */}
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
