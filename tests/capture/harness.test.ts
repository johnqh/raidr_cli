import { expect, test } from 'bun:test';
import { unzipSync, strFromU8 } from 'fflate';
import { validateManifest, parseJsonl, type CapturedRequest } from '@sudobility/raidr_processor';
import { captureApp } from '../../src/capture/harness';
import { startFixtureApi } from '../../fixtures/api/server';

// Real browser work; generous but bounded.
const TIMEOUT = 120_000;

test(
  'captures the react sample into a valid bundle',
  async () => {
    const api = startFixtureApi(8123);
    try {
      const zipped = await captureApp({
        appDir: `${import.meta.dir}/../../fixtures/apps/react-sample/dist`,
        routes: ['/', '/users', '/users/1', '/stats'],
        outName: 'react-sample',
      });

      const files = unzipSync(zipped);
      const manifest = JSON.parse(strFromU8(files['raidr.json']!));
      expect(validateManifest(manifest).ok).toBe(true);
      expect(manifest.stack.framework).toBe('react');
      expect(manifest.stack.bundler).toBe('vite');
      expect(manifest.stack.router).toBe('react-router');

      const requests = parseJsonl<CapturedRequest>(
        strFromU8(files['network/requests.jsonl']!)
      );
      expect(requests.length).toBeGreaterThan(5);
      expect(requests.some((r) => r.url.includes('/api/users'))).toBe(true);

      // Every captured request carries the navigation it happened under.
      expect(requests.every((r) => r.navigationId !== null)).toBe(true);

      // Real JS bodies landed in the content store.
      expect(
        Object.keys(files).some((p) => p.startsWith('content/') && p.endsWith('.js'))
      ).toBe(true);

      // Source maps were discovered — the recovery path has material.
      const mapIndex = JSON.parse(strFromU8(files['sourcemaps/index.json']!));
      expect(Object.keys(mapIndex).length).toBeGreaterThan(0);

      // Redaction ran: the login token never appears in the clear.
      const all = Object.values(files)
        .map((bytes) => strFromU8(bytes))
        .join('');
      expect(all).not.toContain('c2lnbmF0dXJlLXBsYWNlaG9sZGVy');

      // Bodiless preflights are not reported as lost capture.
      const gaps = JSON.parse(strFromU8(files['gaps.json']!));
      expect(gaps).toHaveLength(0);
    } finally {
      api.stop();
    }
  },
  TIMEOUT
);

test(
  'captures the vue sample, detecting vue and its real version',
  async () => {
    const api = startFixtureApi(8123);
    try {
      const zipped = await captureApp({
        appDir: `${import.meta.dir}/../../fixtures/apps/vue-sample/dist`,
        routes: ['/', '/users', '/users/1', '/stats'],
        outName: 'vue-sample',
      });
      const files = unzipSync(zipped);
      const manifest = JSON.parse(strFromU8(files['raidr.json']!));
      expect(manifest.stack.framework).toBe('vue');
      expect(manifest.stack.frameworkVersion).toMatch(/^3\./);
      expect(manifest.stack.router).toBe('vue-router');
    } finally {
      api.stop();
    }
  },
  TIMEOUT
);
