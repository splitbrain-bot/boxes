// Launch defaults for a headless browser inside a session container.
//
// Three things about this environment break a plain chromium.launch(), and all
// three fail in ways that read as a bug in the page rather than in the box:
//
//   - /dev/shm is Docker's default 64 MB, which Chromium exhausts on any
//     substantial page and reports as a closed target.
//     --disable-dev-shm-usage moves that traffic to /tmp, which is already a
//     512 MB tmpfs in a session, so it costs nothing.
//   - A session network is `internal`. Nothing reaches the internet except
//     through the egress proxy, and Chromium has to be told where that is --
//     it does not pick the proxy up from the environment reliably.
//   - Chromium keeps its own trust store and reads none of the CA variables
//     the rest of the image is pointed at. The entrypoint imports the
//     deployment CA into the agent's NSS database for exactly this reason; if
//     that failed, the hosts the proxy intercepts fail TLS in the browser and
//     nowhere else.
//
// What is *not* handled here is the sandbox, because Playwright already
// handles it: chromiumSandbox defaults off, so --no-sandbox is passed for us.
// That is what makes any of this work -- Chromium's own sandbox needs a user
// namespace, and Docker's seccomp profile denies one to a container without
// CAP_SYS_ADMIN, which this container deliberately does not have. The
// container is the sandbox instead: non-root, no capabilities, read-only
// rootfs, no route out but the proxy.
import { chromium } from 'playwright';

const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const BYPASS = process.env.NO_PROXY || '';

/** The launch options this environment needs, with room to override any of them. */
export function launchOptions(overrides = {}) {
  const options = {
    ...overrides,
    args: ['--disable-dev-shm-usage', ...(overrides.args ?? [])],
  };
  if (PROXY && !options.proxy) {
    options.proxy = BYPASS ? { server: PROXY, bypass: BYPASS } : { server: PROXY };
  }
  return options;
}

/** A browser and a page ready to navigate. Close the browser when done. */
export async function launch(overrides = {}) {
  const browser = await chromium.launch(launchOptions(overrides));
  const page = await browser.newPage();
  return { browser, page };
}

/**
 * A browser whose cookies, storage and profile survive between runs, so a
 * multi-step job does not start from a logged-out browser every time a script
 * is run again. The profile lives in the home volume; delete the directory to
 * reset it. Close the context when done.
 */
export async function launchPersistent(userDataDir, overrides = {}) {
  const dir = userDataDir || `${process.env.HOME}/.cache/boxes-browser`;
  const context = await chromium.launchPersistentContext(dir, launchOptions(overrides));
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}
