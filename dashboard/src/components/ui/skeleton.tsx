import { cn } from '@/lib/utils';

/**
 * A pulsing placeholder block for content that is not loaded.
 *
 * @param className Extra classes.
 * @param props The other div props.
 */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-md bg-accent', className)}
      {...props}
    />
  );
}

export { Skeleton };
