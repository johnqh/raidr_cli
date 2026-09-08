import type { StackFingerprint } from '@sudobility/raidr_lib';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Every function below is serialized with `.toString()` and evaluated inside
 * the page. They must reference nothing outside their own body.
 */

export function detectFramework(): StackFingerprint {
  const g = globalThis as any;

  let framework: 'react' | 'vue' | 'unknown' = 'unknown';
  let frameworkVersion: string | null = null;

  const reactHook = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const vueHook = g.__VUE_DEVTOOLS_GLOBAL_HOOK__;

  // The devtools hooks exist only when the devtools extension is installed, so
  // they cannot be the primary signal. Both frameworks leave unmistakable
  // traces on the DOM itself, which are present in every production build.
  const doc = g.document;
  let vueAppInstance: any = null;
  let reactByDom = false;

  if (doc && doc.querySelectorAll) {
    const candidates = Array.prototype.slice.call(
      doc.querySelectorAll('body, body *'),
      0,
      200
    ) as any[];

    for (const element of candidates) {
      if (!vueAppInstance && element.__vue_app__) vueAppInstance = element.__vue_app__;
      if (!reactByDom) {
        for (const key in element) {
          if (
            key.indexOf('__reactFiber$') === 0 ||
            key.indexOf('__reactContainer$') === 0 ||
            key.indexOf('__reactProps$') === 0
          ) {
            reactByDom = true;
            break;
          }
        }
      }
      if (vueAppInstance && reactByDom) break;
    }
  }

  if (vueAppInstance) {
    framework = 'vue';
    frameworkVersion = vueAppInstance.version ?? vueHook?.Vue?.version ?? null;
  } else if (reactByDom) {
    framework = 'react';
    // Production React does not publish its version to the page; the devtools
    // hook is the only runtime source, and it is usually absent.
    const renderers = reactHook?.renderers
      ? (Array.from(reactHook.renderers.values()) as any[])
      : [];
    frameworkVersion = renderers[0]?.version ?? null;
  } else if (reactHook && reactHook.renderers && reactHook.renderers.size > 0) {
    framework = 'react';
    const renderers = Array.from(reactHook.renderers.values()) as any[];
    frameworkVersion = renderers[0]?.version ?? null;
  } else if (vueHook) {
    framework = 'vue';
    frameworkVersion = vueHook.Vue?.version ?? null;
  }

  let bundler: 'webpack' | 'vite' | 'unknown' = 'unknown';
  const webpackGlobal =
    typeof g.__webpack_require__ !== 'undefined' ||
    Object.keys(g).some((key) => key.indexOf('webpackChunk') === 0);
  if (webpackGlobal) {
    bundler = 'webpack';
  } else if (typeof g.__vite__mapDeps !== 'undefined') {
    bundler = 'vite';
  } else if (doc && doc.querySelector) {
    // Vite production builds emit hashed module scripts under /assets/.
    const moduleScript = doc.querySelector('script[type="module"][src]');
    const src = moduleScript ? String(moduleScript.getAttribute('src')) : '';
    if (/\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.js/.test(src)) bundler = 'vite';
  }

  const stateLibraries: string[] = [];
  if (g.__REDUX_DEVTOOLS_EXTENSION__ || g.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__) {
    stateLibraries.push('redux');
  }
  if (vueHook && vueHook.Pinia) stateLibraries.push('pinia');

  let router: string | null = null;
  if (vueAppInstance?.config?.globalProperties?.$router) router = 'vue-router';
  else if (g.__reactRouterDataRouter?.routes) router = 'react-router';

  return {
    framework,
    frameworkVersion,
    router,
    routerVersion: null,
    stateLibraries,
    bundler,
  };
}

export function readRoutes(): string[] {
  const g = globalThis as any;
  const paths: string[] = [];

  const vueHook = g.__VUE_DEVTOOLS_GLOBAL_HOOK__;
  const vueApp = vueHook?.apps?.[0]?.app;
  const vueRouter = vueApp?.config?.globalProperties?.$router;
  if (vueRouter && typeof vueRouter.getRoutes === 'function') {
    for (const route of vueRouter.getRoutes()) {
      if (route && typeof route.path === 'string') paths.push(route.path);
    }
    return paths;
  }

  // React Router's data router registers itself for its own devtools.
  const reactRouter = g.__reactRouterDataRouter ?? g.__staticRouterHydrationData;
  const routes = reactRouter?.routes;
  if (Array.isArray(routes)) {
    const walk = (nodes: any[], prefix: string): void => {
      for (const node of nodes) {
        const segment = typeof node.path === 'string' ? node.path : '';
        const full = segment.startsWith('/')
          ? segment
          : `${prefix}/${segment}`.replace(/\/+/g, '/');
        if (segment) paths.push(full);
        if (Array.isArray(node.children)) walk(node.children, full);
      }
    };
    walk(routes, '');
  }

  return paths;
}

export function readChunkManifest(): string[] {
  const g = globalThis as any;

  const webpackRequire = g.__webpack_require__;
  const urlHelper = webpackRequire?.u;

  if (typeof urlHelper !== 'function') {
    // Vite has no readable equivalent. Its dep list lives in a `const` inside
    // a module chunk — never on the page's global scope, whatever the docs for
    // __vite__mapDeps suggest — so the only signal available here is what the
    // document references, which is the entry and its modulepreloads. The lazy
    // route chunks are recovered instead by parsing the captured script body.
    const doc = g.document;
    if (doc && doc.querySelectorAll) {
      const referenced: string[] = [];
      const add = (value: unknown): void => {
        const path = String(value ?? '');
        if (!path) return;
        const match = /\/assets\/[^"'\s)]+\.js/.exec(path);
        if (match && referenced.indexOf(match[0].slice(1)) < 0) {
          referenced.push(match[0].slice(1));
        }
      };
      for (const script of Array.prototype.slice.call(
        doc.querySelectorAll('script[type="module"][src]')
      ) as any[]) {
        add(script.getAttribute('src'));
      }
      for (const link of Array.prototype.slice.call(
        doc.querySelectorAll('link[rel="modulepreload"][href]')
      ) as any[]) {
        add(link.getAttribute('href'));
      }
      if (referenced.length > 0) return referenced;
    }
  }
  if (typeof urlHelper === 'function') {
    // webpack inlines the chunk id→name map into the body of `u`. Recovering
    // the ids from its source is the only way to enumerate chunks that have
    // not loaded yet.
    const source = String(urlHelper);
    const literal = source.match(/\{[^{}]*\}/);
    if (literal) {
      const ids = literal[0].match(/(^|[{,])\s*("?)([\w.-]+)\2\s*:/g) ?? [];
      const chunks: string[] = [];
      for (const raw of ids) {
        const id = raw.replace(/[{,:\s"]/g, '');
        if (!id) continue;
        try {
          chunks.push(String(urlHelper(id)));
        } catch {
          // A chunk id the helper cannot resolve is not a chunk we can fetch.
        }
      }
      return chunks;
    }
  }

  return [];
}

/**
 * Every internal link the current page offers. For an app whose router is not
 * readable from the runtime — a server-rendered site, or any framework that
 * keeps its route table private — this is the only way to know which pages
 * exist before the operator closes the tab.
 */
export function readLinks(): string[] {
  const g = globalThis as any;
  const doc = g.document;
  if (!doc || !doc.querySelectorAll) return [];

  const origin = g.location ? String(g.location.origin) : '';
  const found: string[] = [];

  for (const anchor of Array.prototype.slice.call(
    doc.querySelectorAll('a[href]')
  ) as any[]) {
    const raw = String(anchor.getAttribute('href') || '');
    if (!raw) continue;

    let path = '';
    if (raw.indexOf('/') === 0 && raw.indexOf('//') !== 0) {
      path = raw;
    } else if (origin && raw.indexOf(origin) === 0) {
      path = raw.slice(origin.length) || '/';
    } else {
      continue;
    }

    path = String(path.split('#')[0]).split('?')[0] as string;
    // A template placeholder in documentation is not a page.
    if (!path || /[{}$]/.test(path)) continue;
    if (found.indexOf(path) < 0) found.push(path);
  }

  return found;
}

export function readLocation(): string {
  const g = globalThis as any;
  return g.location ? String(g.location.pathname) : '/';
}

export function readHref(): string {
  const g = globalThis as any;
  return g.location ? String(g.location.href) : '';
}

/**
 * Waits for the DOM to stop changing before reading it.
 *
 * navigatedWithinDocument fires on pushState, which happens before the client
 * router renders the new route — reading immediately captures the *previous*
 * page's DOM under the new URL. Settling on a quiet MutationObserver is what
 * makes the snapshot belong to the page it is named after.
 */
export function snapshotDom(): Promise<string> {
  const g = globalThis as any;
  const doc = g.document;
  if (!doc || !doc.documentElement) return Promise.resolve('');

  return new Promise<string>((resolve) => {
    const QUIET_MS = 250;
    const MAX_MS = 3000;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (): void => {
      try {
        observer.disconnect();
      } catch {
        // Observer may already be gone; the DOM read is what matters.
      }
      clearTimeout(timer);
      clearTimeout(ceiling);
      resolve(String(doc.documentElement.outerHTML));
    };

    const observer = new g.MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(finish, QUIET_MS);
    });

    observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    timer = setTimeout(finish, QUIET_MS);
    // A page that never stops mutating still owes us a snapshot.
    const ceiling = setTimeout(finish, MAX_MS);
  });
}

export const PROBE_SOURCES = {
  framework: `(${detectFramework.toString()})()`,
  routes: `(${readRoutes.toString()})()`,
  chunks: `(${readChunkManifest.toString()})()`,
  links: `(${readLinks.toString()})()`,
  location: `(${readLocation.toString()})()`,
  href: `(${readHref.toString()})()`,
  dom: `(${snapshotDom.toString()})()`,
};
