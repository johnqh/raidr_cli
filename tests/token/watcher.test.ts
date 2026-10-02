import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiDoc } from '@sudobility/raidr_types';
import { saveSiteToken, targetFromDoc } from '../../src/commands/token';
import { CredentialWatcher } from '../../src/token/watcher';

const API = 'https://api.example.com';

describe('CredentialWatcher', () => {
  test('a 2xx from a signed-in-only endpoint accepts the token; guests and 401s do not', () => {
    const w = new CredentialWatcher('api.example.com', { style: 'bearer' }, ['/v1/me', '/v1/orders/{id}']);
    w.onRequest('1', `${API}/v1/feed`, { authorization: 'Bearer guest' });
    expect(w.onResponse('1', `${API}/v1/feed`, 200)).toBeNull();
    w.onRequest('2', `${API}/v1/me`, { authorization: 'Bearer stale' });
    expect(w.onResponse('2', `${API}/v1/me`, 401)).toBeNull();
    w.onRequest('3', 'https://other.example.com/v1/me', {
      authorization: 'Bearer x',
    });
    expect(w.onResponse('3', 'https://other.example.com/v1/me', 200)).toBeNull();
    w.onRequest('4', `${API}/v1/orders/9?x=1`, {
      authorization: 'Bearer good',
    });
    expect(w.onResponse('4', `${API}/v1/orders/9?x=1`, 200)).toEqual({
      token: 'good',
      verified: true,
    });
    expect(w.onClosed()).toBeNull();
  });

  test('cookie style, and the unverifiable fallback when no signed-in-only endpoint is known', () => {
    const w = new CredentialWatcher('api.example.com', { style: 'cookie', cookieName: 'sid' }, []);
    w.onRequest('1', `${API}/x`, { cookie: 'a=1; sid=abc' });
    expect(w.onClosed()).toEqual({ token: 'abc', verified: false });
    expect(w.onResponse('1', `${API}/x`, 204)).toEqual({
      token: 'abc',
      verified: true,
    });
  });
});

describe('token command helpers', () => {
  test('saveSiteToken keeps other settings and writes a private file', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'raidr-cfg-')), 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        apiKey: 'raidr_k',
        siteTokens: { 'a.com': { token: 'old', savedAt: 'x' } },
      })
    );
    await saveSiteToken('api.example.com', 'tok', path, new Date('2026-10-02T00:00:00Z'));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      apiKey: 'raidr_k',
      siteTokens: {
        'a.com': { token: 'old', savedAt: 'x' },
        'api.example.com': {
          token: 'tok',
          savedAt: '2026-10-02T00:00:00.000Z',
        },
      },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('targetFromDoc takes the login page, style and signed-in-only paths', () => {
    const doc = {
      apiHost: 'api.example.com',
      baseUrl: API,
      siteOrigins: ['https://example.com'],
      auth: {
        user: { style: 'bearer', loginUrl: 'https://example.com/login' },
      },
      endpoints: [
        { path: '/v1/me', auth: 'user' },
        { path: '/v1/public', auth: 'none' },
      ],
    } as unknown as ApiDoc;
    expect(targetFromDoc(doc)).toEqual({
      apiHost: 'api.example.com',
      loginUrl: 'https://example.com/login',
      auth: { style: 'bearer' },
      userPaths: ['/v1/me'],
    });
  });
});
