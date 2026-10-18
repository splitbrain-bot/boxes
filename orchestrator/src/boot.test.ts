import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { buildApp, type Orchestrator } from './app.ts';
import { BootState } from './boot.ts';
import { loadConfig } from './config.ts';
import { type Db, openDb } from './db.ts';

describe('the progress of a pull', () => {
  it('is null until a pull reports', () => {
    const boot = new BootState();
    boot.trackPull('example/box:latest');
    assert.deepEqual(boot.status(), { ready: false, pull: null });
  });

  it('adds the layers and their bytes together', () => {
    const boot = new BootState();
    const progress = boot.trackPull('example/box:latest');
    progress({ status: 'Pulling from example/box', id: 'latest' });
    progress({ status: 'Already exists', id: 'l1' });
    progress({ status: 'Pulling fs layer', id: 'l2' });
    progress({ status: 'Pulling fs layer', id: 'l3' });
    progress({ status: 'Downloading', id: 'l2', progressDetail: { current: 50, total: 100 } });
    progress({ status: 'Downloading', id: 'l3', progressDetail: { current: 10, total: 300 } });
    progress({ status: 'Download complete', id: 'l2' });
    progress({ status: 'Extracting', id: 'l2', progressDetail: { current: 5, total: 100 } });
    progress({ status: 'Pull complete', id: 'l2' });

    assert.deepEqual(boot.status().pull, {
      image: 'example/box:latest',
      layers: { downloaded: 2, done: 2, total: 3 },
      bytes: { current: 110, total: 400 },
      unpacking: null,
    });
  });

  it('shows the layer that is unpacked now', () => {
    const boot = new BootState();
    const progress = boot.trackPull('example/box:latest');
    progress({ status: 'Pulling fs layer', id: 'l1' });
    progress({ status: 'Pulling fs layer', id: 'l2' });
    progress({ status: 'Download complete', id: 'l1' });
    progress({ status: 'Download complete', id: 'l2' });
    progress({ status: 'Extracting', id: 'l1', progressDetail: { current: 30, total: 100 } });

    assert.deepEqual(boot.status().pull?.layers, { downloaded: 2, done: 0, total: 2 });
    assert.deepEqual(boot.status().pull?.unpacking, { current: 30, total: 100, unit: 'bytes' });
  });

  it('takes the seconds when the daemon gives no size for the unpacking', () => {
    const boot = new BootState();
    const progress = boot.trackPull('example/box:latest');
    progress({ status: 'Extracting', id: 'l1', progressDetail: { current: 4, units: 's' } });

    assert.deepEqual(boot.status().pull?.unpacking, { current: 4, total: 0, unit: 'seconds' });
  });

  it('shows the pull that reported last', () => {
    const boot = new BootState();
    const first = boot.trackPull('example/box:latest');
    const second = boot.trackPull('example/box:latest');
    first({ status: 'Pulling fs layer', id: 'l1' });
    second({ status: 'Pulling fs layer', id: 'l2' });
    second({ status: 'Pulling fs layer', id: 'l3' });

    assert.equal(boot.status().pull?.layers.total, 2);
  });
});

describe('the app while the orchestrator starts', () => {
  let dir: string;
  let db: Db;
  let boot: BootState;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'boxes-boot-'));
    db = openDb(dir);
    boot = new BootState();
    orchestrator = buildApp(loadConfig({ DATA_DIR: dir }), db, { boot });
  });

  afterEach(async () => {
    await orchestrator.app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the starting page to a browser', async () => {
    const res = await orchestrator.app.inject({
      method: 'GET',
      url: '/boxes/abc',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Boxes is starting/);
    assert.match(res.headers['content-security-policy'] as string, /script-src 'sha256-/);
  });

  it('refuses the API and the assets', async () => {
    const api = await orchestrator.app.inject({ method: 'GET', url: '/api/boxes' });
    assert.equal(api.statusCode, 503);
    const asset = await orchestrator.app.inject({ method: 'GET', url: '/assets/index.js' });
    assert.equal(asset.statusCode, 503);
  });

  it('answers the boot endpoint and the probes', async () => {
    const res = await orchestrator.app.inject({ method: 'GET', url: '/api/boot' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ready: false, pull: null });
    const health = await orchestrator.app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(health.statusCode, 200);
  });

  it('serves the API once it is ready', async () => {
    boot.markReady();
    const res = await orchestrator.app.inject({ method: 'GET', url: '/api/boxes' });
    assert.equal(res.statusCode, 200);
  });
});
