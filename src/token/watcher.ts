/**
 * Decides, request by request, when a signed-in user's token has shown up in
 * a site's own traffic. Shared rule with the raidr extension: a credential is
 * accepted once a request carrying it to one of the host's signed-in-only
 * endpoints answers 2xx; with no such endpoints known, any 2xx will do.
 */
import {
  type CapturedCredential,
  type CredentialAuth,
  extractCredential,
  matchesPathTemplate,
} from '@sudobility/raidr_types';

export class CredentialWatcher {
  private readonly pending = new Map<string, string>();
  /** Last credential seen on any request to the host. */
  last: string | null = null;

  constructor(
    private readonly apiHost: string,
    private readonly auth: CredentialAuth,
    private readonly userPaths: string[]
  ) {}

  private forHost(url: string): URL | null {
    try {
      const u = new URL(url);
      return u.host === this.apiHost ? u : null;
    } catch {
      return null;
    }
  }

  /** A request is about to go out. */
  onRequest(id: string, url: string, headers: Record<string, string>): void {
    if (!this.forHost(url)) return;
    const token = extractCredential(headers, this.auth);
    if (!token) return;
    this.last = token;
    this.pending.set(id, token);
  }

  /** Its response arrived: returns the credential once it counts as signed in. */
  onResponse(id: string, url: string, status: number): CapturedCredential | null {
    const token = this.pending.get(id);
    if (token === undefined) return null;
    this.pending.delete(id);
    const u = this.forHost(url);
    if (!u || status < 200 || status >= 300) return null;
    const signedInOnly = this.userPaths.length === 0 || this.userPaths.some((t) => matchesPathTemplate(t, u.pathname));
    return signedInOnly ? { token, verified: true } : null;
  }

  /** The user gave up: only an unverifiable host gets the last token back. */
  onClosed(): CapturedCredential | null {
    return this.userPaths.length === 0 && this.last ? { token: this.last, verified: false } : null;
  }
}
