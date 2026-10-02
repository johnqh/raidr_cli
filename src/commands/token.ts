/**
 * `raidr token <apiHost>`: sign the user in to a site in a real
 * browser window on their own machine and save the site token for raidr's MCP
 * server, without anyone copying it out of DevTools.
 *
 * How the site sends its token (and which endpoints need it) comes from the
 * host's API doc on raidr_api, fetched with the raidr API key in
 * ~/.raidr/config.json, or from --login/--style flags. The browser uses a
 * persistent profile in ~/.raidr/browser, so once signed in, later runs pick
 * the session up at once. The password never leaves this machine; only the
 * token is saved, to ~/.raidr/config.json under `siteTokens`.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import type { ApiDoc, CapturedCredential, CredentialAuth, RaidrSettings } from '@sudobility/raidr_types';
/** `--name value` or `--name=value`. */
function flag(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  const next = i >= 0 ? argv[i + 1] : undefined;
  return next !== undefined && !next.startsWith('--') ? next : undefined;
}

import { CredentialWatcher } from '../token/watcher';

const CONFIG = join(homedir(), '.raidr', 'config.json');
const PROFILE = process.env.RAIDR_BROWSER_PROFILE ?? join(homedir(), '.raidr', 'browser');

export interface TokenTarget {
  apiHost: string;
  loginUrl: string;
  auth: CredentialAuth;
  userPaths: string[];
}

export async function readSettings(path = CONFIG): Promise<RaidrSettings> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as RaidrSettings;
  } catch {
    return {};
  }
}

/** Save the token, keeping every other field; the file stays private (0600). */
export async function saveSiteToken(apiHost: string, token: string, path = CONFIG, now = new Date()): Promise<void> {
  const settings = await readSettings(path);
  settings.siteTokens = {
    ...settings.siteTokens,
    [apiHost]: { token, savedAt: now.toISOString() },
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

/** Login URL, auth style and signed-in-only paths from the host's API doc. */
export function targetFromDoc(doc: ApiDoc): TokenTarget {
  const user = doc.auth.user;
  return {
    apiHost: doc.apiHost,
    loginUrl: user?.loginUrl ?? doc.siteOrigins[0] ?? doc.baseUrl,
    auth: user
      ? {
          style: user.style,
          headerName: user.headerName,
          cookieName: user.cookieName,
          tokenPrefix: user.tokenPrefix,
        }
      : { style: 'none' },
    userPaths: doc.endpoints.filter((e) => e.auth === 'user').map((e) => e.path),
  };
}

async function fetchDoc(apiHost: string, apiUrl: string, apiKey: string): Promise<ApiDoc> {
  const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/v1/apis/${encodeURIComponent(apiHost)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    data?: { doc?: ApiDoc };
    error?: string;
  } | null;
  if (!res.ok || !body?.data?.doc) {
    throw new Error(
      `could not load the API doc for ${apiHost} (HTTP ${res.status}${body?.error ? `: ${body.error}` : ''})`
    );
  }
  return body.data.doc;
}

async function launch(
  channel: string | undefined,
  extra: { headless?: boolean; args?: string[] } = {}
): Promise<BrowserContext> {
  const options = { headless: extra.headless ?? false, viewport: null, ...(extra.args ? { args: extra.args } : {}) };
  // The installed Chrome first: sites trust it more and it needs no download.
  for (const c of channel ? [channel] : ['chrome', 'msedge', undefined]) {
    try {
      return await chromium.launchPersistentContext(PROFILE, {
        ...options,
        ...(c ? { channel: c } : {}),
      });
    } catch (error) {
      if (channel) throw error;
    }
  }
  throw new Error('no browser found: install Google Chrome, or run `bunx playwright install chromium`');
}

/** Open the site, wait for a signed-in request, close. Null when the user closed the window first. */
export async function captureToken(
  target: TokenTarget,
  opts: {
    channel?: string;
    timeoutMs: number;
    /** Tests only: run without a window, with extra browser flags. */
    headless?: boolean;
    args?: string[];
  }
): Promise<CapturedCredential | null> {
  const context = await launch(opts.channel, {
    ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
    ...(opts.args ? { args: opts.args } : {}),
  });
  const watcher = new CredentialWatcher(target.apiHost, target.auth, target.userPaths);
  /** Per request: resolves to its id once its headers have been read. */
  const recorded = new WeakMap<object, Promise<string>>();
  let next = 0;
  try {
    return await new Promise<CapturedCredential | null>((resolve) => {
      const timer = setTimeout(() => resolve(watcher.onClosed()), opts.timeoutMs);
      const done = (value: CapturedCredential | null) => {
        clearTimeout(timer);
        resolve(value);
      };
      context.on('request', (request) => {
        const id = String(next++);
        recorded.set(
          request,
          request
            .allHeaders()
            .then((headers) => watcher.onRequest(id, request.url(), headers))
            .catch(() => undefined)
            .then(() => id)
        );
      });
      context.on('response', (response) => {
        void recorded.get(response.request())?.then((id) => {
          const found = watcher.onResponse(id, response.url(), response.status());
          if (found) done(found);
        });
      });
      context.on('close', () => done(watcher.onClosed()));
      void (async () => {
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto(target.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      })();
    });
  } finally {
    await context.close().catch(() => undefined);
  }
}

export async function runToken(argv: string[]): Promise<void> {
  const apiHost = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;
  if (!apiHost) {
    console.error(
      'usage: raidr token <apiHost> [--print] [--login <url> --style bearer|header|cookie [--header-name N] [--cookie-name N] [--token-prefix P] [--user-path /me …]]\n' +
        '                   [--api-url <url>] [--channel chrome] [--timeout-ms 600000]'
    );
    process.exit(1);
  }
  const settings = await readSettings();
  let target: TokenTarget;
  const style = flag(argv, 'style');
  if (flag(argv, 'login') && style) {
    target = {
      apiHost,
      loginUrl: flag(argv, 'login')!,
      auth: {
        style: style as CredentialAuth['style'],
        headerName: flag(argv, 'header-name'),
        cookieName: flag(argv, 'cookie-name'),
        tokenPrefix: flag(argv, 'token-prefix'),
      },
      // Without the API doc, signed-in-only paths come from --user-path (repeatable).
      userPaths: argv.flatMap((a, i) => (a === '--user-path' && argv[i + 1] ? [argv[i + 1]!] : [])),
    };
  } else {
    if (!settings.apiKey) {
      console.error(
        `No raidr API key in ${CONFIG}. Create one at https://raidr.app under Dashboard > API keys and save it as {"apiKey": "raidr_..."}.`
      );
      process.exit(1);
    }
    const apiUrl = flag(argv, 'api-url') ?? process.env.RAIDR_API_URL ?? settings.apiUrl ?? 'https://api.raidr.app';
    target = targetFromDoc(await fetchDoc(apiHost, apiUrl, settings.apiKey));
  }
  if (target.auth.style === 'none') {
    console.error(`${apiHost} needs no site token.`);
    return;
  }

  console.error(`Opening ${target.loginUrl}. Sign in there; the window closes by itself once you are in.`);
  const credential = await captureToken(target, {
    ...(flag(argv, 'channel') ? { channel: flag(argv, 'channel')! } : {}),
    timeoutMs: Number(flag(argv, 'timeout-ms') ?? 600_000),
  });
  if (!credential) {
    console.error('The window closed before you were signed in. Run the command again to retry.');
    process.exit(2);
  }
  await saveSiteToken(apiHost, credential.token);
  console.error(
    `Signed in. Token for ${apiHost} saved to ~/.raidr/config.json${credential.verified ? '' : ' (not confirmed yet: if calls answer 401, run this again)'}.`
  );
  if (argv.includes('--print')) process.stdout.write(`${credential.token}\n`);
}
