import { KeyRound, Plus, SlidersHorizontal } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router';
import { ImageFooter } from '@/components/ImageFooter';
import { Loading } from '@/components/Loading';
import { Notice } from '@/components/Notice';
import { PushToggle } from '@/components/PushToggle';
import { BoxCard } from '@/components/BoxCard';
import { TokenWarning } from '@/components/TokenWarning';
import { Button } from '@/components/ui/button';
import { startPolling, useBoxes } from '../stores/boxes.ts';

/** Home page that shows every box as a card. */
export function BoxList() {
  const { boxes, images, error, loading } = useBoxes();

  // Polls the box list only while this page is mounted. Other views watch one box.
  useEffect(() => startPolling(), []);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Boxes</h1>
        <div className="flex items-center gap-1">
          <PushToggle />
          <Button asChild size="sm" variant="ghost" aria-label="Agent configuration">
            <Link to="/agents">
              <SlidersHorizontal />
            </Link>
          </Button>
          <Button asChild size="sm" variant="ghost" aria-label="Settings">
            <Link to="/settings">
              <KeyRound />
            </Link>
          </Button>
          <Button asChild size="sm">
            <Link to="/new">
              <Plus />
              New
            </Link>
          </Button>
        </div>
      </div>

      <TokenWarning className="rounded-md border px-3 py-2" />

      {error ? (
        <Notice className="rounded-md border px-3 py-2">{error}</Notice>
      ) : null}

      {loading && boxes.length === 0 ? <Loading className="py-8 text-center" /> : null}

      {/* A failed poll says nothing about the count, so the empty note waits for success. */}
      {!loading && !error && boxes.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No boxes yet. Create one to get started.
        </div>
      ) : null}

      {boxes.map((s) => (
        <BoxCard key={s.id} box={s} />
      ))}

      <ImageFooter images={images} />
    </div>
  );
}
