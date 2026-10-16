import { createHash } from 'node:crypto';
import type { BootResponse, PullProgress } from '../../shared/types.ts';
import type { PullEvent } from './runtime/runtime.ts';

/** The progress of one layer of a pull. */
interface LayerProgress {
  /** The bytes of the layer that are downloaded. */
  current: number;
  /** The size of the layer, or 0 while it is not known. */
  total: number;
  /** Whether the layer is downloaded. */
  downloaded: boolean;
  /** Whether the layer is on the host, unpacked. */
  done: boolean;
}

/** One pull of an image. */
interface Pull {
  /** The image reference that is pulled. */
  image: string;
  /** The layers of the image by id. */
  layers: Map<string, LayerProgress>;
  /** The id of the layer that the daemon unpacks now, and its progress. */
  unpacking: { id: string; progress: NonNullable<PullProgress['unpacking']> } | null;
}

/**
 * Whether the orchestrator has started, and how far the pull of the box
 * image has come while it starts.
 */
export class BootState {
  /** True once the orchestrator serves the dashboard and the API. */
  ready: boolean;

  /** The pull that reported last. */
  private pull: Pull | null = null;

  /**
   * @param ready Whether the orchestrator has started already.
   */
  constructor(ready = false) {
    this.ready = ready;
  }

  /** Records that the orchestrator has started. */
  markReady(): void {
    this.ready = true;
  }

  /**
   * Gives the progress callback for one pull of an image.
   *
   * The pull becomes the one that is shown with its first event. Thus a pull
   * that does not occur replaces nothing.
   *
   * @param image The image reference that is pulled.
   * @returns The callback for the progress events of the pull.
   */
  trackPull(image: string): (event: PullEvent) => void {
    const pull: Pull = { image, layers: new Map(), unpacking: null };
    return (event) => {
      this.pull = pull;
      // The first event names the tag, not a layer.
      if (!event.id || !event.status || event.status.startsWith('Pulling from')) return;
      let layer = pull.layers.get(event.id);
      if (!layer) {
        layer = { current: 0, total: 0, downloaded: false, done: false };
        pull.layers.set(event.id, layer);
      }
      switch (event.status) {
        case 'Downloading':
          layer.current = event.progressDetail?.current ?? layer.current;
          layer.total = event.progressDetail?.total ?? layer.total;
          break;
        case 'Download complete':
          layer.current = layer.total;
          layer.downloaded = true;
          break;
        case 'Extracting':
          pull.unpacking = {
            id: event.id,
            progress: {
              current: event.progressDetail?.current ?? 0,
              total: event.progressDetail?.total ?? 0,
              unit: event.progressDetail?.units === 's' ? 'seconds' : 'bytes',
            },
          };
          break;
        case 'Pull complete':
        case 'Already exists':
          layer.downloaded = true;
          layer.done = true;
          if (pull.unpacking?.id === event.id) pull.unpacking = null;
          break;
      }
    };
  }

  /** The state for the boot endpoint. */
  status(): BootResponse {
    return { ready: this.ready, pull: this.pull ? summarize(this.pull) : null };
  }
}

/** Adds the progress of the layers of a pull together. */
function summarize(pull: Pull): PullProgress {
  const progress: PullProgress = {
    image: pull.image,
    layers: { downloaded: 0, done: 0, total: pull.layers.size },
    bytes: { current: 0, total: 0 },
    unpacking: pull.unpacking?.progress ?? null,
  };
  for (const layer of pull.layers.values()) {
    if (layer.downloaded) progress.layers.downloaded++;
    if (layer.done) progress.layers.done++;
    progress.bytes.current += layer.current;
    progress.bytes.total += layer.total;
  }
  return progress;
}

/**
 * The script of the starting page. It polls the boot endpoint, shows the
 * progress of the pull, and loads the dashboard once the orchestrator has
 * started. The bar counts the unpacked layers, because the daemon downloads
 * ahead and the unpacking takes the most time.
 */
const BOOT_SCRIPT = `
const pull = document.getElementById('pull');
const bar = document.getElementById('bar');
const image = document.getElementById('image');
const detail = document.getElementById('detail');
const mb = (n) => (n / 1e6).toFixed(0) + ' MB';
async function poll() {
  try {
    const res = await fetch('/api/boot', { cache: 'no-store' });
    const boot = await res.json();
    if (boot.ready) {
      location.reload();
      return;
    }
    if (boot.pull) {
      pull.hidden = false;
      image.textContent = boot.pull.image;
      const { layers, bytes, unpacking } = boot.pull;
      const part = unpacking && unpacking.total ? unpacking.current / unpacking.total : 0;
      bar.max = layers.total || 1;
      bar.value = layers.done + part;
      if (layers.downloaded < layers.total) {
        detail.textContent = mb(bytes.current) + ' of ' + mb(bytes.total) + ' downloaded, ' +
          layers.done + ' of ' + layers.total + ' layers unpacked';
      } else {
        let text = 'Unpacking layer ' + Math.min(layers.done + 1, layers.total) + ' of ' + layers.total;
        if (unpacking && unpacking.unit === 'seconds') text += ', ' + unpacking.current + ' s';
        else if (unpacking) text += ', ' + mb(unpacking.current) + ' of ' + mb(unpacking.total);
        detail.textContent = text;
      }
    }
  } catch {
    // The orchestrator may restart. The next poll tries again.
  }
  setTimeout(poll, 1000);
}
poll();
`;

/** The page that is shown in place of the dashboard while the orchestrator starts. */
export const BOOT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Boxes is starting</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { display: grid; place-items: center; min-height: 100vh; margin: 0; }
  main { width: min(28rem, 90vw); text-align: center; }
  progress { width: 100%; }
  p { opacity: 0.7; overflow-wrap: anywhere; }
</style>
</head>
<body>
<main>
<h1>Boxes is starting</h1>
<p>The dashboard opens when the start is complete.</p>
<section id="pull" hidden>
<p>Pulling the box image <span id="image"></span></p>
<progress id="bar" value="0" max="1"></progress>
<p id="detail"></p>
</section>
</main>
<script>${BOOT_SCRIPT}</script>
</body>
</html>
`;

/** The content security policy of the starting page. It allows only its own script. */
export const BOOT_PAGE_CSP = [
  "default-src 'none'",
  `script-src 'sha256-${createHash('sha256').update(BOOT_SCRIPT).digest('base64')}'`,
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');
