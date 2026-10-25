/** Tests for the list of the targets that the egress profile of each box refused. */

import { describe, expect, it } from 'vitest';
import { MAX_REFUSED_TARGETS, RefusedTargets } from './refused.ts';

describe('RefusedTargets', () => {
  it('lists the targets of a box, the most recent first', () => {
    const refused = new RefusedTargets();
    refused.record('box-1', 'evil.com', 443, 'allowlist', 1000);
    refused.record('box-1', 'example.com', 22, 'port', 2000);
    expect(refused.list('box-1')).toEqual([
      { host: 'example.com', port: 22, category: 'port', count: 1, lastAt: 2000 },
      { host: 'evil.com', port: 443, category: 'allowlist', count: 1, lastAt: 1000 },
    ]);
  });

  it('counts a repeated target and moves it to the top', () => {
    const refused = new RefusedTargets();
    refused.record('box-1', 'evil.com', 443, 'allowlist', 1000);
    refused.record('box-1', 'example.com', 22, 'port', 2000);
    refused.record('box-1', 'evil.com', 443, 'allowlist', 3000);
    expect(refused.list('box-1')).toEqual([
      { host: 'evil.com', port: 443, category: 'allowlist', count: 2, lastAt: 3000 },
      { host: 'example.com', port: 22, category: 'port', count: 1, lastAt: 2000 },
    ]);
  });

  it('keeps a separate entry for each port of a host', () => {
    const refused = new RefusedTargets();
    refused.record('box-1', 'example.com', 443, 'allowlist', 1000);
    refused.record('box-1', 'example.com', 8443, 'port', 2000);
    expect(refused.list('box-1').map((d) => d.port)).toEqual([8443, 443]);
  });

  it('keeps the lists of the boxes apart', () => {
    const refused = new RefusedTargets();
    refused.record('box-1', 'evil.com', 443, 'allowlist', 1000);
    expect(refused.list('box-2')).toEqual([]);
    expect(refused.list('box-1')).toHaveLength(1);
  });

  it('keeps only the most recent targets of a box', () => {
    const refused = new RefusedTargets();
    for (let i = 0; i <= MAX_REFUSED_TARGETS; i++) {
      refused.record('box-1', `host-${i}.example.com`, 443, 'allowlist', i);
    }
    const list = refused.list('box-1');
    expect(list).toHaveLength(MAX_REFUSED_TARGETS);
    expect(list[0]?.host).toBe(`host-${MAX_REFUSED_TARGETS}.example.com`);
    expect(list.map((d) => d.host)).not.toContain('host-0.example.com');
    expect(list.at(-1)?.host).toBe('host-1.example.com');
  });

  it('does not drop a target that comes again', () => {
    const refused = new RefusedTargets();
    for (let i = 0; i < MAX_REFUSED_TARGETS; i++) {
      refused.record('box-1', `host-${i}.example.com`, 443, 'allowlist', i);
    }
    // A new attempt makes host-0 the most recent, so host-1 is the oldest.
    refused.record('box-1', 'host-0.example.com', 443, 'allowlist', 100);
    refused.record('box-1', 'new.example.com', 443, 'allowlist', 101);
    const hosts = refused.list('box-1').map((d) => d.host);
    expect(hosts).toHaveLength(MAX_REFUSED_TARGETS);
    expect(hosts).toContain('host-0.example.com');
    expect(hosts).not.toContain('host-1.example.com');
  });

  it('drops the lists of the boxes that are not in the set', () => {
    const refused = new RefusedTargets();
    refused.record('box-1', 'evil.com', 443, 'allowlist', 1000);
    refused.record('box-2', 'evil.com', 443, 'allowlist', 1000);
    refused.retain(new Set(['box-2', 'box-3']));
    expect(refused.list('box-1')).toEqual([]);
    expect(refused.list('box-2')).toHaveLength(1);
  });
});
