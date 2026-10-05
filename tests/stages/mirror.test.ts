import { expect, test } from 'bun:test';
import { rm, readFile } from 'node:fs/promises';
import { loadBundle } from '../../src/bundle/load';
import { emitMirror } from '../../src/stages/mirror';

const OUT = `${import.meta.dir}/../../.tmp/mirror-test`;

test('writes captured assets back at their served paths', async () => {
  await rm(OUT, { recursive: true, force: true });
  const bundle = await loadBundle(
    `${import.meta.dir}/../../fixtures/bundles/react-sample.zip`
  );
  const result = await emitMirror(bundle, OUT);

  expect(result.filesWritten).toBeGreaterThan(1);
  expect(result.pages).toContain('/index.html');

  const html = await readFile(`${OUT}/index.html`, 'utf8');
  expect(html).toContain('<!doctype html>');
});

test('the mirrored javascript is byte-identical to what was served', async () => {
  await rm(OUT, { recursive: true, force: true });
  const bundle = await loadBundle(
    `${import.meta.dir}/../../fixtures/bundles/react-sample.zip`
  );
  await emitMirror(bundle, OUT);

  const entry = bundle.requests.find(
    (r) => r.mimeType?.includes('javascript') && r.url.includes('/assets/')
  )!;
  const served = bundle.content.get(entry.responseBodyHash!)!;
  const written = await readFile(`${OUT}/${new URL(entry.url).pathname.slice(1)}`);
  expect(new Uint8Array(written)).toEqual(new Uint8Array(served));
});

test('directory urls are written as index.html', async () => {
  await rm(OUT, { recursive: true, force: true });
  const bundle = await loadBundle(
    `${import.meta.dir}/../../fixtures/bundles/react-sample.zip`
  );
  const result = await emitMirror(bundle, OUT);
  expect(result.pages.every((p) => p.endsWith('.html'))).toBe(true);
});

test('an extensionless page and its children do not collide on disk', async () => {
  // /users is a page and /users/1 is a page; writing the first as a file named
  // `users` makes the directory for the second impossible.
  await rm(OUT, { recursive: true, force: true });
  const bundle = await loadBundle(
    `${import.meta.dir}/../../fixtures/bundles/react-sample.zip`
  );
  const result = await emitMirror(bundle, OUT);

  expect(result.pages).toContain('/users/index.html');
  expect(result.pages).toContain('/users/1/index.html');
  expect((await readFile(`${OUT}/users/index.html`, 'utf8')).length).toBeGreaterThan(0);
});

test('a client-rendered route is written from its DOM snapshot', async () => {
  await rm(OUT, { recursive: true, force: true });
  const bundle = await loadBundle(
    `${import.meta.dir}/../../fixtures/bundles/react-sample.zip`
  );
  // Simulate what the extension records for a client-side navigation: a route
  // with no served document, evidenced only by the rendered DOM.
  const html = '<html><body>client-rendered league</body></html>';
  bundle.content.set('snap1', new TextEncoder().encode(html));
  bundle.snapshots = { '/league': 'snap1' };

  const result = await emitMirror(bundle, OUT);
  expect(result.pages).toContain('/league/index.html');
  expect(result.fromSnapshot).toContain('/league/index.html');
  expect(await readFile(`${OUT}/league/index.html`, 'utf8')).toContain('league');
});

test('served bytes always win over a snapshot for the same path', async () => {
  await rm(OUT, { recursive: true, force: true });
  const bundle = await loadBundle(
    `${import.meta.dir}/../../fixtures/bundles/react-sample.zip`
  );
  bundle.content.set('snap1', new TextEncoder().encode('<html>SNAPSHOT</html>'));
  bundle.snapshots = { '/': 'snap1' };

  const result = await emitMirror(bundle, OUT);
  expect(result.fromSnapshot).not.toContain('/index.html');
  expect(await readFile(`${OUT}/index.html`, 'utf8')).not.toContain('SNAPSHOT');
});

test('a path that is both a file and a directory on the web does not abort the mirror', async () => {
  // Cloudflare serves /beacon.min.js and /beacon.min.js/v8...; on disk the
  // second needs a directory where the first is a file. The second is skipped.
  await rm(OUT, { recursive: true, force: true });
  const bundle = await loadBundle(`${import.meta.dir}/../../fixtures/bundles/react-sample.zip`);
  const encoder = new TextEncoder();
  const add = (url: string, hash: string, text: string) => {
    bundle.content.set(hash, encoder.encode(text));
    bundle.requests.push({
      id: hash, ts: 0, method: 'GET', url, resourceType: 'Script', requestHeaders: {}, requestBodyHash: null,
      status: 200, responseHeaders: {}, responseBodyHash: hash, mimeType: 'text/javascript', fromCache: false, navigationId: null,
    });
  };
  add('https://example.com/beacon.min.js', 'h-beacon', 'beacon();');
  add('https://example.com/beacon.min.js/v8c78df7c7', 'h-beacon-v8', 'beacon8();');

  const result = await emitMirror(bundle, OUT);
  expect(await readFile(`${OUT}/beacon.min.js`, 'utf8')).toBe('beacon();');
  expect(result.paths).toContain('/beacon.min.js');
  expect(result.paths).not.toContain('/beacon.min.js/v8c78df7c7');
});

test('a tracking pixel whose path segment exceeds the file-name limit is shortened, not fatal', async () => {
  // A DoubleClick floodlight URL put a 1 KB `activityi;…` segment in the path:
  // mkdir failed with ENAMETOOLONG and the whole reconstruction aborted.
  await rm(OUT, { recursive: true, force: true });
  const bundle = await loadBundle(`${import.meta.dir}/../../fixtures/bundles/react-sample.zip`);
  const segment = `activityi;dc_pre=CMTB9MOhopcDFcAGRAgdxokHRQ;src=13040738;${'u1=www.example.com%2F;'.repeat(60)}`;
  bundle.content.set('h-pixel', new TextEncoder().encode('<html></html>'));
  bundle.requests.push({
    id: 'h-pixel', ts: 0, method: 'GET', url: `https://ad.doubleclick.net/${segment}`, resourceType: 'Document', requestHeaders: {}, requestBodyHash: null,
    status: 200, responseHeaders: {}, responseBodyHash: 'h-pixel', mimeType: 'text/html', fromCache: false, navigationId: null,
  });

  const result = await emitMirror(bundle, OUT);
  const written = result.paths.find((p) => p.startsWith('/activityi;'))!;
  expect(written).toBeDefined();
  expect(written.split('/').every((s) => Buffer.byteLength(s) <= 200)).toBe(true);
  expect(await readFile(`${OUT}${written}`, 'utf8')).toBe('<html></html>');
});
