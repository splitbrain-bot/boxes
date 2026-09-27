import { shortSize } from '@/lib/rough';
import type { DeploymentImages, ImageInfo } from '../../../shared/types.ts';

/** The images, in the order the footer names them, and under the name it uses. */
const ORDER: Array<keyof DeploymentImages> = ['orchestrator', 'proxy', 'box'];

/** How much of a digest is shown, in hex characters. */
const SHORT_DIGEST = 12;

/**
 * Shortens a digest to Docker's short id length and drops the `sha256:` prefix.
 *
 * @param digest The full digest.
 * @returns The short hex form.
 */
function short(digest: string): string {
  return digest.replace(/^sha256:/, '').slice(0, SHORT_DIGEST);
}

/**
 * Formats a moment as `YYYY-MM-DD HH:MM` in the reader's timezone. The fixed
 * format makes two build dates easy to compare in any locale.
 *
 * @param at The moment in epoch milliseconds.
 * @returns The formatted time.
 */
function stamp(at: number): string {
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * One image, with the full digest on hover.
 *
 * @param label The image name.
 * @param image The image facts.
 */
function Entry({ label, image }: { label: string; image: ImageInfo }) {
  // A fact the daemon did not give is left out, not shown as a dash.
  const facts: string[] = [];
  if (image.builtAt !== null) facts.push(stamp(image.builtAt));
  if (image.sizeBytes !== null) facts.push(shortSize(image.sizeBytes));

  return (
    <span title={image.digest} className="whitespace-nowrap">
      {label} <span className="font-mono">{short(image.digest)}</span>
      {facts.map((fact) => ` · ${fact}`).join('')}
    </span>
  );
}

/**
 * Footer line that names each image of the deployment with its digest, build
 * time and size. The digest tells which build answers when the deployment
 * follows `latest`.
 *
 * Renders nothing when no image could be read, as outside Docker.
 *
 * @param images The deployment's images.
 */
export function ImageFooter({ images }: { images: DeploymentImages }) {
  const present = ORDER.flatMap((name) => {
    const image = images[name];
    return image ? [{ name, image }] : [];
  });
  if (present.length === 0) return null;

  return (
    <footer className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
      {present.map(({ name, image }) => (
        <Entry key={name} label={name} image={image} />
      ))}
    </footer>
  );
}
