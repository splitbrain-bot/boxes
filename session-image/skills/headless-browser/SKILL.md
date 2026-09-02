---
name: headless-browser
description: Drive a headless Chromium in this session with Playwright — screenshot or PDF a page, scrape rendered content, fill a form, or check a dev server. Use whenever a task needs a real browser rather than curl, and read it before writing any Playwright code here, because a plain chromium.launch() cannot reach the network from this container.
---

Playwright and Chromium are installed. Two things about this container change
how you use them: **nothing reaches the network except through the egress
proxy**, and the browsers directory is read-only.

## One-shot page capture

No code needed. Pass the proxy explicitly:

```sh
playwright screenshot --proxy-server="$HTTPS_PROXY" --full-page https://example.com shot.png
playwright pdf        --proxy-server="$HTTPS_PROXY" https://example.com page.pdf
```

Useful flags: `--viewport-size=1280,900`, `--wait-for-timeout=2000`,
`--device="iPhone 15"`. Add `--ignore-https-errors` only if a page fails TLS
and you have ruled out everything under Troubleshooting.

## Anything more than that: write a script

Import the launch helper rather than calling `chromium.launch()` yourself — it
supplies the proxy and the flags this container needs.

```js
// scrape.mjs — run with: node scrape.mjs
import { launch } from '/usr/local/share/boxes/browser.mjs';

const { browser, page } = await launch();
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
console.log(await page.title());
console.log(await page.locator('h1').innerText());
await page.screenshot({ path: 'shot.png', fullPage: true });
await browser.close();
```

`launch(overrides)` passes anything through to `chromium.launch`, so
`await launch({ headless: false })` or `{ args: [...] }` work as usual. Import
`launchOptions` instead if you need to build the browser yourself.

For a job spanning several runs — a login, then work behind it — use
`launchPersistent()`, which keeps cookies and storage in `~/.cache/boxes-browser`
between runs:

```js
import { launchPersistent } from '/usr/local/share/boxes/browser.mjs';
const { context, page } = await launchPersistent();
// ... page is already logged in if a previous run logged in
await context.close();
```

Delete `~/.cache/boxes-browser` to start from a clean profile.

## A local dev server

`localhost` is in `NO_PROXY`, and the helper passes that through as the proxy
bypass, so a server you started in this session is reachable without extra
configuration:

```js
const { browser, page } = await launch();
await page.goto('http://localhost:5173');
```

## Troubleshooting

| What you see | Why | Fix |
|---|---|---|
| `net::ERR_PROXY_CONNECTION_FAILED`, or every navigation times out | Chromium was launched without the proxy | Use the helper, or pass `proxy: { server: process.env.HTTPS_PROXY }` |
| `net::ERR_CERT_AUTHORITY_INVALID` on some hosts only | The proxy terminates TLS for the hosts whose credentials it swaps in, and Chromium's trust store did not get the deployment CA | Check `certutil -L -d sql:$HOME/.pki/nssdb` lists `boxes-egress-proxy`; as a last resort pass `ignoreHTTPSErrors: true` on the context |
| `net::ERR_BLOCKED_BY_CLIENT` or a host that never resolves | That host is not on the deployment's egress allowlist | Nothing to fix in the browser — the host has to be allowed |
| `Target page, context or browser has been closed` on a heavy page | `/dev/shm` is 64 MB here | Use the helper, which passes `--disable-dev-shm-usage` |
| `Executable doesn't exist at /home/agent/.cache/ms-playwright/...` | A project pins a different Playwright version, which wants its own browser build, and the image's browsers directory is read-only | `export PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright && npx playwright install chromium` — that writes to the home volume and persists |

## Notes

- Firefox and WebKit are **not** installed, only Chromium. `npx playwright install firefox` after the `PLAYWRIGHT_BROWSERS_PATH` change above if a task truly needs it.
- Screenshots and PDFs are files like any other: write them into the workspace and they show up in the review surface.
- There is no display. Everything runs headless; `headless: false` will fail.
