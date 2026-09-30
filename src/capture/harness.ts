import { chromium } from 'playwright';
import {
  MemoryContentStore,
  buildBundleFiles,
  bundleFilename,
  createManifest,
  createPseudonymizer,
  redactRequest,
  zipBundle,
  type CapturedRequest,
  type Gap,
  type StackFingerprint,
} from '@sudobility/raidr_processor';
import { PROBE_SOURCES } from '../introspect/probes';

export interface CaptureOptions {
  /** Built app directory to serve statically. */
  appDir: string;
  /** SPA paths to visit, in order. */
  routes: string[];
  outName: string;
}

const encoder = new TextEncoder();

/** Statuses that carry no body by definition; asking for one is not a gap. */
const BODILESS_STATUSES = new Set([101, 204, 205, 304]);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asHeaders(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(asRecord(value))) {
    out[key.toLowerCase()] = String(raw);
  }
  return out;
}

export async function captureApp(options: CaptureOptions): Promise<Uint8Array> {
  // Serve the built app with SPA fallback so deep links resolve.
  const appServer = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const file = Bun.file(`${options.appDir}${url.pathname}`);
      if (await file.exists()) return new Response(file);
      return new Response(Bun.file(`${options.appDir}/index.html`), {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  const origin = `http://localhost:${appServer.port}`;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);

  const store = new MemoryContentStore(sha256Hex);
  const { pseudonym, entries } = createPseudonymizer(crypto.randomUUID());
  const manifest = createManifest({
    sessionId: options.outName,
    origin,
    startedAt: new Date().toISOString(),
  });

  const rows: CapturedRequest[] = [];
  const gaps: Gap[] = [];
  const sourceMaps: Record<string, string> = {};
  const pending = new Map<string, Record<string, unknown>>();
  const inFlight: Array<Promise<void>> = [];

  // The harness fetches source maps through the page after browsing finishes.
  // Those are instrumentation, not application behaviour, and must not appear
  // in the capture — otherwise they are indistinguishable from real API calls.
  let recording = true;
  let navigationCounter = 0;
  let currentNavigationId: string | null = null;
  const navigations: Array<{ navigationId: string; path: string }> = [];

  cdp.on('Network.requestWillBeSent', (p) =>
    pending.set(p.requestId, p as unknown as Record<string, unknown>)
  );
  cdp.on('Network.responseReceived', (p) => {
    const entry = pending.get(p.requestId);
    if (entry) entry.response = p.response;
  });

  cdp.on('Network.loadingFinished', (p) => {
    const entry = pending.get(p.requestId);
    if (!entry) return;
    pending.delete(p.requestId);
    if (!recording) return;
    const navigationId = currentNavigationId;

    inFlight.push(
      (async () => {
        const request = asRecord(entry.request);
        const response = asRecord(entry.response);
        const url = String(request.url ?? '');
        const mimeType =
          typeof response.mimeType === 'string' ? response.mimeType : null;
        const ts = Math.round(Number(entry.wallTime ?? 0) * 1000);

        const status = Number(response.status ?? 0);
        const method = String(request.method ?? 'GET');
        const bodiless = method === 'HEAD' || BODILESS_STATUSES.has(status);

        let body: string | null = null;
        if (!bodiless) {
          try {
            const result = await cdp.send('Network.getResponseBody', {
              requestId: p.requestId,
            });
            body = result.base64Encoded
              ? Buffer.from(result.body, 'base64').toString('binary')
              : result.body;
          } catch (error) {
            gaps.push({
              requestId: p.requestId,
              url,
              reason: 'body-evicted',
              ts,
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        }

        const redacted = redactRequest(
          {
            requestHeaders: asHeaders(request.headers),
            responseHeaders: asHeaders(response.headers),
            mimeType,
            requestBody:
              typeof request.postData === 'string' ? request.postData : null,
            responseBody: body,
          },
          pseudonym
        );

        rows.push({
          id: p.requestId,
          ts,
          method,
          url,
          resourceType: String(entry.type ?? 'Other'),
          requestHeaders: redacted.requestHeaders,
          requestBodyHash:
            redacted.requestBody === null
              ? null
              : await store.put(encoder.encode(redacted.requestBody)),
          status,
          responseHeaders: redacted.responseHeaders,
          responseBodyHash:
            redacted.responseBody === null
              ? null
              : await store.put(encoder.encode(redacted.responseBody)),
          mimeType,
          fromCache: response.fromDiskCache === true,
          navigationId,
        });
      })()
    );
  });

  await cdp.send('Network.enable', {
    maxResourceBufferSize: 100 * 1024 * 1024,
    maxTotalBufferSize: 500 * 1024 * 1024,
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  let framework: StackFingerprint | null = null;
  const knownChunks = new Set<string>();
  const knownRoutes = new Set<string>();

  for (const route of options.routes) {
    navigationCounter += 1;
    currentNavigationId = `nav${navigationCounter}`;
    navigations.push({ navigationId: currentNavigationId, path: route });

    await page.goto(`${origin}${route}`, { waitUntil: 'networkidle' });

    // Drain before the next navigation. Chrome discards response bodies from
    // its buffer on navigation, so a body still being fetched when we move on
    // is lost — which is exactly how /api/login and /api/me became gaps.
    await Promise.all(inFlight.splice(0));

    const detected = (await page.evaluate(
      PROBE_SOURCES.framework
    )) as StackFingerprint | null;
    if (detected && detected.framework !== 'unknown') framework = detected;
    else if (!framework) framework = detected;

    for (const r of (await page.evaluate(PROBE_SOURCES.routes)) as string[]) {
      knownRoutes.add(r);
    }
    for (const c of (await page.evaluate(PROBE_SOURCES.chunks)) as string[]) {
      knownChunks.add(c);
    }
  }

  await Promise.all(inFlight);

  // Fetch source maps with the page's own credentials.
  recording = false;
  for (const row of rows) {
    if (!row.mimeType?.includes('javascript')) continue;
    if (sourceMaps[row.url]) continue;
    const mapUrl = `${row.url.split('?')[0]}.map`;
    try {
      const text = (await page.evaluate(async (u) => {
        const response = await fetch(u);
        return response.ok ? response.text() : '';
      }, mapUrl)) as string;
      if (!text) continue;
      const parsed = JSON.parse(text) as { sourcesContent?: unknown };
      if (
        Array.isArray(parsed.sourcesContent) &&
        parsed.sourcesContent.some((s) => typeof s === 'string' && s.length > 0)
      ) {
        sourceMaps[row.url] = await store.put(encoder.encode(text));
      }
    } catch {
      // No map for this chunk; not a gap — the bundle is complete without it.
    }
  }

  await browser.close();
  appServer.stop(true);

  manifest.endedAt = new Date().toISOString();
  manifest.stack = framework;
  manifest.counts = {
    requests: rows.length,
    frames: 0,
    bodies: await store.count(),
    gaps: gaps.length,
  };

  const files = await buildBundleFiles({
    store,
    manifest,
    requests: rows,
    frames: [],
    gaps,
    redaction: entries(),
    sourceMaps,
    runtime: {
      framework,
      routes: Array.from(knownRoutes),
      stores: framework?.stateLibraries ?? [],
      chunks: {
        known: Array.from(knownChunks),
        loaded: Array.from(knownChunks).filter((c) =>
          rows.some((r) => r.url.endsWith(c))
        ),
      },
      coverage: {},
      navigations,
    },
  });

  return zipBundle(files);
}

export { bundleFilename };
