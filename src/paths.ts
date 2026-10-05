/**
 * Disk-safe relative paths for names that come from URLs and source maps.
 * File systems cap one path segment at 255 bytes (NAME_MAX); URLs do not, and
 * a tracking pixel's segment (`activityi;dc_pre=…;u1=…`) can run to
 * kilobytes, which made `mkdir` fail with ENAMETOOLONG and abort the whole
 * reconstruction.
 */
import { createHash } from 'node:crypto';

/** Longest segment written as is; leaves room under NAME_MAX for suffixes. */
export const MAX_SEGMENT_BYTES = 200;

const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');

/**
 * A segment within {@link MAX_SEGMENT_BYTES}: unchanged when it fits, else its
 * first bytes, `-`, 12 hex digits of the whole segment's SHA-1 and its
 * extension, so two long names never collide and the file type survives.
 */
export function shortenSegment(segment: string): string {
  if (byteLength(segment) <= MAX_SEGMENT_BYTES) return segment;
  const ext = /\.[A-Za-z0-9]{1,10}$/.exec(segment)?.[0] ?? '';
  const hash = createHash('sha1').update(segment).digest('hex').slice(0, 12);
  const budget = MAX_SEGMENT_BYTES - 1 - hash.length - ext.length;
  let head = '';
  for (const char of segment) {
    if (byteLength(head + char) > budget) break;
    head += char;
  }
  return `${head}-${hash}${ext}`;
}

/** Every segment of a `/`-separated relative path through {@link shortenSegment}. */
export function safeRelativePath(relative: string): string {
  return relative.split('/').map(shortenSegment).join('/');
}
