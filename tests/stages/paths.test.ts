import { expect, test } from 'bun:test';
import { readdir, rm } from 'node:fs/promises';
import { emitFiles } from '../../src/emit';
import { MAX_SEGMENT_BYTES, safeRelativePath, shortenSegment } from '../../src/paths';

test('short segments are kept; long ones keep a prefix, a hash and their extension', () => {
  expect(safeRelativePath('assets/app-1a2b.js')).toBe('assets/app-1a2b.js');
  const long = `${'x'.repeat(300)}.js`;
  const short = shortenSegment(long);
  expect(Buffer.byteLength(short)).toBeLessThanOrEqual(MAX_SEGMENT_BYTES);
  expect(short).toMatch(/^x+-[0-9a-f]{12}\.js$/);
  // Two long names with the same prefix stay distinct.
  expect(shortenSegment(`${'x'.repeat(300)}a.js`)).not.toBe(shortenSegment(`${'x'.repeat(300)}b.js`));
  // Multi-byte characters are counted in bytes and never split.
  const wide = shortenSegment('é'.repeat(200));
  expect(Buffer.byteLength(wide)).toBeLessThanOrEqual(MAX_SEGMENT_BYTES);
  expect(wide.startsWith('é')).toBe(true);
});

test('emitFiles writes a source whose name is longer than the file system allows', async () => {
  const out = `${import.meta.dir}/../../.tmp/paths-test`;
  await rm(out, { recursive: true, force: true });
  const written = await emitFiles(out, { [`src/${'segment'.repeat(60)}.txt`]: 'hello', 'src/ok.txt': 'ok' });
  expect(written).toBe(2);
  const names = await readdir(`${out}/src`);
  expect(names).toContain('ok.txt');
  expect(names.every((n) => Buffer.byteLength(n) <= MAX_SEGMENT_BYTES)).toBe(true);
});
