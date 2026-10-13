
## Browsers in this container

Chromium is already installed, at the revision this image's Playwright wants,
and it is already linked into `PLAYWRIGHT_BROWSERS_PATH`. `playwright-cli` uses
it with no setup, and so does a project's own Playwright on that revision.

**There is no need to run `playwright install chromium`.** Nothing is missing,
so it finds the link and returns without downloading anything.

To drive the browser, use `playwright-cli`, described above.

Firefox and WebKit are not in the image, but their system libraries are, so one
download makes either work — into the same path, beside the Chromium link:

```sh
playwright install firefox webkit
```

Use `playwright`, the CLI already on PATH here. Avoid `npx playwright`, which
ignores PATH and downloads a second copy of the tool before running it.

A project pinning a Playwright that wants some other Chromium revision can
download that too, the same way. If you would rather not download at all, name
the browser the image carries instead:

```js
chromium.launch({ executablePath: '/usr/local/bin/chromium' });
```

That is a stable link to whatever revision the image has. Naming it this way is
what skips Playwright's revision check, which `channel: 'chromium'` would fail.
