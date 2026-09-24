import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  auditLinks,
  buildApiModel,
  buildRouteModel,
  deriveTimeline,
  endpointKey,
  generateClient,
  generateProject,
  generateReplayServer,
  generateTypes,
  parseSourceMap,
  recoverSources,
  recoveryRatio,
  type EndpointSample,
  type StackFingerprint,
} from '@sudobility/raidr_lib';
import { loadBundle } from '../bundle/load';
import { unpackChunks } from '../stages/unpack';
import { emitMirror } from '../stages/mirror';
import { emitFiles } from '../emit';

export interface ReconstructReport {
  recoveryRatio: number;
  unreachablePages: number;
  mode: 'recovery' | 'inference' | 'mirror';
  mirroredFiles: number;
  pages: number;
  routes: number;
  endpoints: number;
  gaps: number;
  filesWritten: number;
}

const RECOVERY_THRESHOLD = 80;

/**
 * CDP labels every request with what the page asked it for. That is a far more
 * reliable signal than guessing from the URL: an SPA route like `/users` has no
 * file extension, so an extension-based filter counts HTML navigations as API
 * calls and generates client methods for them.
 */
const API_RESOURCE_TYPES = new Set(['XHR', 'Fetch']);

function isApiCall(request: { url: string; method: string; resourceType: string }): boolean {
  // CORS preflights are transport, not API surface; the browser sends them, the
  // application never calls them.
  if (request.method === 'OPTIONS') return false;
  return API_RESOURCE_TYPES.has(request.resourceType);
}

export async function reconstruct(options: {
  bundlePath: string;
  outDir: string;
  /**
   * Mirror mode only. A frozen replay of one capture session cannot get a
   * stateful flow like login right — the real backend answers differently
   * over time, an OAuth code is consumed once, a chat reply depends on the
   * live model. Default is false: proxy every dynamic request to the real
   * origin, live. Pass true to fall back to replaying `recordings.json`
   * instead — useful offline, but frozen at whatever the capture saw.
   */
  replay?: boolean;
}): Promise<ReconstructReport> {
  const bundle = await loadBundle(options.bundlePath);
  const raidrDir = join(options.outDir, '.raidr');
  await mkdir(raidrDir, { recursive: true });

  const writeJson = (name: string, value: unknown) =>
    writeFile(join(raidrDir, name), JSON.stringify(value, null, 2), 'utf8');

  // Stage 1 — bundle summary, gaps first.
  await writeJson('01-bundle.json', {
    manifest: bundle.manifest,
    gaps: bundle.gaps,
    redaction: bundle.redaction,
  });

  // Stage 2 — source-map recovery.
  const recovered: Record<string, string> = {};
  let mappedBytes = 0;
  let totalJsBytes = 0;
  for (const request of bundle.requests) {
    if (!request.mimeType?.includes('javascript') || !request.responseBodyHash) continue;
    const size = bundle.content.get(request.responseBodyHash)?.byteLength ?? 0;
    totalJsBytes += size;

    const mapHash = bundle.sourceMaps[request.url];
    if (!mapHash) continue;
    const mapText = bundle.text(mapHash);
    if (mapText === null) continue;
    const map = parseSourceMap(mapText);
    if (!map) continue;

    mappedBytes += size;
    for (const file of recoverSources(map)) recovered[file.path] = file.content;
  }

  const ratio = recoveryRatio({ mappedBytes, totalBytes: totalJsBytes });
  if (Object.keys(recovered).length > 0) {
    await emitFiles(join(raidrDir, '02-sources'), recovered);
  }

  // Stage 3 — unpack whenever source maps did not carry the day.
  if (ratio < RECOVERY_THRESHOLD) {
    const chunks = await unpackChunks(bundle);
    const files: Record<string, string> = {};
    chunks.forEach((chunk, index) => {
      files[`chunk-${index}.js`] = chunk.source;
      for (const module of chunk.modules) {
        files[`chunk-${index}/module-${module.id}.js`] = module.source;
      }
    });
    await emitFiles(join(raidrDir, '03-chunks'), files);
  }

  // Stage 4 — API model, plus the recordings the replay server serves.
  const samples: EndpointSample[] = [];
  // Parallel to `samples`, index for index: the real captured content-type,
  // for the bodies that were not JSON (see below).
  const responseContentTypes: string[] = [];
  const recordings: Record<
    string,
    Array<{ status: number; headers: Record<string, string>; body: unknown }>
  > = {};

  for (const request of bundle.requests) {
    if (!isApiCall(request)) continue;
    // A response body that fails JSON.parse is not a missing capture — CDP
    // still recorded the real bytes, they are just not JSON (Next.js RSC
    // navigation fetches serve `text/x-component`, for example). Falling back
    // to the raw text instead of `undefined` is the difference between every
    // client-side route transition working and every one of them 501ing.
    const responseBody =
      request.responseBodyHash === null
        ? undefined
        : (bundle.json(request.responseBodyHash) ?? bundle.text(request.responseBodyHash));
    samples.push({
      method: request.method,
      url: request.url,
      status: request.status,
      requestBody:
        request.requestBodyHash === null ? null : bundle.json(request.requestBodyHash),
      responseBody: responseBody ?? undefined,
      requestHeaders: request.requestHeaders,
    });
    responseContentTypes.push(
      request.responseHeaders['content-type'] ?? request.mimeType ?? ''
    );
  }

  const api = buildApiModel(samples);
  await writeJson('04-api-model.json', api);

  samples.forEach((sample, index) => {
    if (sample.responseBody === undefined) return;
    // Re-derive the same key the model used. Substring matching on the template
    // would mis-bucket /api/users against /api/users/{id}.
    const key = endpointKey(sample.method, sample.url);
    const bucket = recordings[key] ?? [];
    bucket.push({
      status: sample.status ?? 200,
      headers:
        typeof sample.responseBody === 'string'
          ? { 'content-type': responseContentTypes[index] ?? '' }
          : {},
      body: sample.responseBody,
    });
    recordings[key] = bucket;
  });
  await writeJson('recordings.json', recordings);

  // Stage 5 — route model.
  //
  // A client-side router hands us its route table, and the extension stamps a
  // navigationId per row. Neither exists for a server-rendered or multi-page
  // site. When they are missing, recover both from the request timeline: every
  // Document request is a navigation, and what follows it belongs to that page.
  const runtimeRoutes = (bundle.runtime.routes as string[]) ?? [];
  const runtimeNavigations =
    (bundle.runtime.navigations as Array<{ navigationId: string; path: string }>) ?? [];

  const derived = deriveTimeline(bundle.requests);
  const usingDerived = runtimeRoutes.length === 0 || runtimeNavigations.length === 0;

  const routeModel = buildRouteModel({
    routes: usingDerived ? derived.navigations.map((n) => n.path) : runtimeRoutes,
    navigations: usingDerived ? derived.navigations : runtimeNavigations,
    requests: bundle.requests.map((r) => ({
      method: r.method,
      url: r.url,
      navigationId: usingDerived ? (derived.assignments[r.id] ?? null) : r.navigationId,
      resourceType: r.resourceType,
    })),
  });
  await writeJson('05-route-model.json', {
    ...routeModel,
    source: usingDerived ? 'derived-from-documents' : 'runtime-router-table',
  });

  // Stage 5b — the mirror. Always written: these are the served bytes, with no
  // inference involved at all.
  const mirror = await emitMirror(bundle, join(options.outDir, 'public'));
  await writeJson('06-mirror.json', {
    filesWritten: mirror.filesWritten,
    pages: mirror.pages,
    bytes: mirror.bytes,
    fromSnapshot: mirror.fromSnapshot,
  });

  // Stage 5c — link audit. Everything else verifies what the capture contains;
  // this is the only stage that asks what it is missing. A reconstruction whose
  // own navigation 404s is not finished, and no other check would notice.
  const linkAudit = auditLinks({
    pages: mirror.documents,
    available: mirror.paths,
  });
  await writeJson('07-link-audit.json', linkAudit);

  // With no source maps and no client router, there is no component tree to
  // reconstruct — the components ran on the server and were never sent. The
  // honest artifact is the mirror plus a replay server, not a fabricated SPA.
  // Without source maps there is no component source to reconstruct — that is
  // true whether or not a router table was readable, so the presence of routes
  // must not flip this decision. The honest artifact is the mirror; beautified
  // chunks are left under .raidr/03-chunks for whoever wants to read them.
  const mode: ReconstructReport['mode'] =
    ratio >= RECOVERY_THRESHOLD
      ? 'recovery'
      : mirror.pages.length > 0
        ? 'mirror'
        : 'inference';
  await writeJson('02-recovery.json', {
    ratio,
    mode,
    files: Object.keys(recovered).sort(),
  });

  // Stages 6–7 — stack decision and deterministic codegen.
  const stack: StackFingerprint = bundle.manifest.stack ?? {
    framework: 'unknown',
    frameworkVersion: null,
    router: null,
    routerVersion: null,
    stateLibraries: [],
    bundler: 'unknown',
  };

  const useReplay = options.replay === true;

  const project: Record<string, string> =
    mode === 'mirror'
      ? mirrorProject({
          origin: bundle.manifest.origin,
          stack,
          mirror,
          gaps: bundle.gaps,
          replay: useReplay,
        })
      : generateProject({
          name: 'rebuilt',
          stack,
          routes: routeModel.routes,
          api,
          gaps: bundle.gaps,
        });

  project['src/api/types.ts'] = generateTypes(api);
  project['src/api/client.ts'] = generateClient(api);
  project['server/replay.ts'] =
    mode === 'mirror'
      ? useReplay
        ? mirrorReplayServer(api, mirror.pages)
        : mirrorProxyServer(bundle.manifest.origin)
      : generateReplayServer(api);
  project['server/recordings.json'] = JSON.stringify(recordings, null, 2);

  const filesWritten = await emitFiles(options.outDir, project);

  const missingPages = linkAudit.unreachable.filter((u) => u.kind === 'page');
  const report: ReconstructReport = {
    recoveryRatio: ratio,
    unreachablePages: missingPages.length,
    mode,
    mirroredFiles: mirror.filesWritten,
    pages: mirror.pages.length,
    routes: routeModel.routes.length,
    endpoints: api.endpoints.length,
    gaps: bundle.gaps.length,
    filesWritten,
  };

  await writeFile(
    join(raidrDir, 'report.md'),
    [
      '# raidr reconstruction report',
      '',
      `- Origin: ${bundle.manifest.origin}`,
      `- Framework: ${stack.framework} ${stack.frameworkVersion ?? '(version unknown)'}`,
      `- Bundler: ${stack.bundler}`,
      `- Mode: **${mode}** (source-map recovery ${ratio}%)`,
      `- Mirrored: ${mirror.filesWritten} files, ${(mirror.bytes / 1048576).toFixed(1)} MB, ${mirror.pages.length} pages`,
      ...(mirror.fromSnapshot.length > 0
        ? [
            `- Of those, ${mirror.fromSnapshot.length} pages come from rendered-DOM`,
            '  snapshots rather than served bytes — the server never sent HTML for',
            '  them, so this is the post-hydration DOM, not source.',
          ]
        : []),
      `- Route source: ${usingDerived ? 'derived from Document requests' : 'runtime router table'}`,
      `- Routes: ${routeModel.routes.length} (${routeModel.routes.filter((r) => !r.visited).length} never visited)`,
      `- Endpoints: ${api.endpoints.length}`,
      `- Gaps: ${bundle.gaps.length}`,
      `- Unreachable internal links: ${missingPages.length} pages, ${linkAudit.unreachable.length - missingPages.length} assets`,
      '',
      '## Routes',
      '',
      ...routeModel.routes.map(
        (r) =>
          `- \`${r.path}\`${r.visited ? '' : ' — **never visited**'}${
            r.endpoints.length > 0 ? ` → ${r.endpoints.join(', ')}` : ''
          }`
      ),
      '',
      '## Linked but never captured',
      '',
      ...(linkAudit.unreachable.length > 0
        ? [
            'These are linked from captured pages but are not in the bundle.',
            'Re-capture visiting them, or the reconstruction ships broken navigation.',
            '',
            ...linkAudit.unreachable.map(
              (u) => `- \`${u.link}\` (${u.kind}) — linked from ${u.linkedFrom.join(', ')}`
            ),
          ]
        : ['(none — every internal link resolves)']),
      '',
      '## Pages',
      '',
      ...(mirror.pages.length > 0 ? mirror.pages.map((p) => `- \`${p}\``) : ['(none)']),
      '',
      '## Unattributed endpoints',
      '',
      ...(routeModel.unattributed.length > 0
        ? routeModel.unattributed.map((e) => `- ${e}`)
        : ['(none)']),
    ].join('\n'),
    'utf8'
  );

  return report;
}

function mirrorProject(input: {
  origin: string;
  stack: StackFingerprint;
  mirror: { filesWritten: number; pages: string[]; bytes: number };
  gaps: Array<{ reason: string; url: string; detail: string | null }>;
  replay: boolean;
}): Record<string, string> {
  const files: Record<string, string> = {};

  files['package.json'] = JSON.stringify(
    {
      name: 'mirror',
      private: true,
      type: 'module',
      scripts: { serve: 'bun run server/replay.ts' },
      dependencies: { hono: '^4.6.0' },
    },
    null,
    2
  );

  const readme: Array<string | null> = [
    `# ${new URL(input.origin).host} — reconstruction`,
    '',
    `Rebuilt by raidr from a capture of ${input.origin}.`,
    '',
    '## What this is',
    '',
    `The site was rendered on the server and shipped no source maps, so its`,
    `component source never reached the browser and cannot be recovered. What`,
    `*was* received is here in full: ${input.mirror.filesWritten} files`,
    `(${(input.mirror.bytes / 1048576).toFixed(1)} MB) across ${input.mirror.pages.length} pages,`,
    'byte-identical to what the server sent.',
    '',
    `Detected stack: ${input.stack.framework}${input.stack.frameworkVersion ? ` ${input.stack.frameworkVersion}` : ''}`,
    input.stack.stateLibraries.length > 0
      ? `State libraries: ${input.stack.stateLibraries.join(', ')}`
      : null,
    '',
    '## Run it',
    '',
    '```bash',
    'bun install',
    'bun run serve   # http://localhost:8787',
    '```',
    '',
    ...(input.replay
      ? [
          'Static files are served from `public/`. API calls are replayed from',
          '`server/recordings.json`, stepping through every response the capture',
          'saw for that endpoint in the order it saw them (so a flow like login,',
          'captured as logged-out then logged-in, replays that transition instead',
          'of freezing on the first snapshot). Anything never captured returns 501',
          'rather than a plausible invention. Pass `--replay` to `raidr reconstruct`',
          'to regenerate in this mode; the default instead proxies live to the real',
          'backend, since no replay can get a stateful flow fully right.',
          '',
        ]
      : [
          'Static files (`/_next/static`, `/assets`) are served from `public/`.',
          'Everything else — pages, client-side navigation fetches, and `/api/*` —',
          `is proxied straight through to the real backend at ${input.origin}, live.`,
          'A frozen replay of one capture session can never get a real login or a',
          'real chat reply right; the live backend can. `server/recordings.json`',
          'and `.raidr/04-api-model.json` are kept as a record of what was captured,',
          'but the server no longer reads them. Pass `--replay` to `raidr reconstruct`',
          'to regenerate against the frozen capture instead (useful offline).',
          '',
          '**Known limitation:** an OAuth-style login (e.g. "Sign in with Google")',
          `redirects through the provider and back to ${new URL(input.origin).host}`,
          'itself, not back to localhost — the proxy cannot rewrite that callback.',
          'Everything that does not leave the origin (auth checks, API calls, RSC',
          'navigation) is fully live.',
          '',
        ]),
    '## What is not here',
    '',
    '- Server component source — it ran on the server and was never sent.',
    '- Any behaviour behind an endpoint the capture did not exercise.',
    input.gaps.length > 0
      ? `- ${input.gaps.length} resources listed in RAIDR-GAPS.md.`
      : null,
    '',
    '## Pages',
    '',
    ...input.mirror.pages.map((p) => `- \`${p}\``),
    '',
  ];
  files['README.md'] = readme
    .filter((line): line is string => line !== null)
    .join('\n');

  if (input.gaps.length > 0) {
    files['RAIDR-GAPS.md'] = [
      '# Capture gaps',
      '',
      'Requested by the site but not captured. Anything depending on these is',
      'missing evidence, not merely unimplemented.',
      '',
      ...input.gaps.map(
        (gap) => `- \`${gap.reason}\` — ${gap.url}${gap.detail ? ` (${gap.detail})` : ''}`
      ),
      '',
    ].join('\n');
  }

  return files;
}

/**
 * A frozen replay of one capture session cannot get a stateful flow like
 * login right: the real backend answers "/api/auth/me" differently over
 * time, an OAuth callback exchanges a code that has already been consumed,
 * and a chat endpoint's reply depends on the live model. There is no honest
 * mock for any of that. So for mirror mode, only genuinely immutable,
 * content-hashed build output (`/_next/static`, `/assets`) is served from the
 * local mirror; every dynamic request — pages, client-side navigation
 * fetches, `/api/*` — is proxied straight through to the real origin, live.
 */
function mirrorProxyServer(origin: string): string {
  return [
    '// Generated by raidr. Serves captured static assets locally and proxies',
    '// everything dynamic to the real backend, live.',
    'import { Hono } from "hono";',
    'import { serveStatic } from "hono/bun";',
    '',
    `const ORIGIN = ${JSON.stringify(origin)};`,
    '',
    '// Content-hashed build output only — anything whose bytes cannot change',
    '// without its URL changing too. Every dynamic path (pages, RSC navigation',
    '// fetches, /api/*) is proxied live instead, below.',
    'const STATIC_ASSET = /^\\/(_next\\/static\\/|assets\\/)/;',
    '',
    'const app = new Hono();',
    '',
    'app.use("*", async (c, next) => {',
    '  const url = new URL(c.req.url);',
    '  if (STATIC_ASSET.test(url.pathname) || url.pathname === "/favicon.png") {',
    '    return next();',
    '  }',
    '',
    '  const target = new URL(url.pathname + url.search, ORIGIN);',
    '  const headers = new Headers(c.req.raw.headers);',
    '  headers.delete("host");',
    '  headers.delete("content-length");',
    '  // An Origin/Referer check on the real backend would never fire for a real',
    '  // browser on the real site; presenting our own localhost origin instead',
    '  // would make it fire for no reason.',
    '  headers.set("origin", ORIGIN);',
    '  if (headers.has("referer")) headers.set("referer", target.toString());',
    '',
    '  const upstream = await fetch(target, {',
    '    method: c.req.method,',
    '    headers,',
    '    redirect: "manual",',
    '    body: ["GET", "HEAD"].includes(c.req.method)',
    '      ? undefined',
    '      : await c.req.raw.arrayBuffer(),',
    '  });',
    '',
    '  const outHeaders = new Headers(upstream.headers);',
    '  // A Set-Cookie scoped to the real domain is silently rejected by the',
    '  // browser when it arrives from localhost; drop the Domain attribute so it',
    '  // stays scoped to this proxy instead, and a real session actually sticks.',
    '  const cookies = outHeaders.getSetCookie?.() ?? [];',
    '  outHeaders.delete("set-cookie");',
    '  for (const cookie of cookies) {',
    '    outHeaders.append("set-cookie", cookie.replace(/;\\s*Domain=[^;]+/i, ""));',
    '  }',
    '  outHeaders.delete("content-encoding");',
    '  outHeaders.delete("content-length");',
    '',
    '  return new Response(upstream.body, {',
    '    status: upstream.status,',
    '    headers: outHeaders,',
    '  });',
    '});',
    '',
    'app.use("/*", serveStatic({ root: "./public" }));',
    '',
    'const port = Number(process.env.PORT ?? 8787);',
    'export default { port, fetch: app.fetch };',
    '',
  ].join('\n');
}

/**
 * The `--replay` fallback: serves `recordings.json` instead of the real
 * backend. Useful offline, but frozen at whatever the capture saw — see the
 * doc comment on `mirrorProxyServer` for why that is the wrong default for a
 * stateful app.
 */
function mirrorReplayServer(
  api: Parameters<typeof generateReplayServer>[0],
  pages: string[]
): string {
  // A page path (e.g. /documentation) and its Next.js RSC navigation fetch
  // are the exact same URL — Next.js tells them apart with an `rsc` request
  // header, never with the path. The endpoint routes registered below answer
  // both, so a real browser request for the page itself (no `rsc` header: a
  // hard reload, a bookmark, a link opened in a new tab) must be served the
  // mirrored HTML before it ever reaches those routes.
  const pagePaths = pages.map((p) => p.replace(/\/index\.html$/, '') || '/').sort();
  const pageGuard =
    // The capture often recorded more than one response for the same key —
    // real moments in the session's real timeline (logged out, then in, then
    // out again). Freezing on the first one means a client that polls this
    // endpoint waiting for state to change (e.g. after clicking "Log in")
    // never sees it change, and can retry-loop hard enough to trip the
    // browser's history.replaceState rate limit and crash. Stepping through
    // what was actually captured, in order, replays that real transition.
    'const callCounts = new Map();\n' +
    'const MIRRORED_PAGES = new Set(' +
    JSON.stringify(pagePaths) +
    ');\n' +
    "app.use('*', (c, next) => {\n" +
    "  const path = new URL(c.req.url).pathname.replace(/\\/$/, '') || '/';\n" +
    "  if (c.req.method !== 'GET' || c.req.header('rsc') || !MIRRORED_PAGES.has(path)) {\n" +
    '    return next();\n' +
    '  }\n' +
    '  return serveStatic({ path: `./public${path === \'/\' ? \'\' : path}/index.html` })(\n' +
    '    c,\n' +
    '    next\n' +
    '  );\n' +
    '});\n';

  // The mirror lives in public/, not dist/, and extensionless pages were
  // written as <path>/index.html — so the fallback resolves them there.
  return generateReplayServer(api)
    .replace('const app = new Hono();\n', `const app = new Hono();\n\n${pageGuard}`)
    .replace("serveStatic({ root: './dist' })", "serveStatic({ root: './public' })")
    .replace(
      "app.get('*', serveStatic({ path: './dist/index.html' }));",
      "app.get('*', (c, next) =>\n" +
        "  serveStatic({\n" +
        "    path: `./public${new URL(c.req.url).pathname.replace(/\\/$/, '')}/index.html`,\n" +
        "  })(c, next)\n" +
        ');'
    )
    .replace(
      '  const pick = recorded[0]!;\n' +
        '  return c.json(pick.body as never, pick.status as never);\n' +
        '}',
      '  const seen = callCounts.get(key) ?? 0;\n' +
        '  callCounts.set(key, seen + 1);\n' +
        '  const pick = recorded[seen % recorded.length]!;\n' +
        '  // A recorded string body is one that failed JSON.parse at capture time\n' +
        '  // (e.g. a Next.js RSC flight payload) and was kept as raw text instead of\n' +
        "  // being dropped — replay it with its real content-type, not application/json.\n" +
        "  if (typeof pick.body === 'string') {\n" +
        '    return c.body(pick.body, pick.status as never, {\n' +
        "      'content-type': pick.headers['content-type'] || 'text/plain; charset=utf-8',\n" +
        '    });\n' +
        '  }\n' +
        '  return c.json(pick.body as never, pick.status as never);\n' +
        '}'
    );
}

export async function runReconstruct(argv: string[]): Promise<void> {
  const bundlePath = argv[0];
  const outIndex = argv.indexOf('--out');
  const outDir = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  const replay = argv.includes('--replay');

  if (!bundlePath || !outDir) {
    console.error(
      'usage: raidr reconstruct <bundle.zip|dir> --out <dir> [--replay]\n' +
        '  --replay  mirror mode only: serve recordings.json instead of proxying\n' +
        '            to the real backend. Default is to proxy live.'
    );
    process.exit(1);
  }

  const report = await reconstruct({ bundlePath, outDir, replay });
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nArtifacts: ${join(outDir, '.raidr')}`);
  console.log(`Report:    ${join(outDir, '.raidr', 'report.md')}`);
}
