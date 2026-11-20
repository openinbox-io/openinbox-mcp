import { VERSION } from './version.js';

export const DEFAULT_API_URL = 'https://api.openinbox.io/api/v1';
export const SETTINGS_URL = 'https://openinbox.io/settings';
export const PRICING_URL = 'https://openinbox.io/pricing';

export interface ExtractedLink {
  url: string;
  text: string;
  kind: 'verification' | 'magic-link' | 'password-reset' | 'unsubscribe' | 'other';
}

export interface Extracted {
  codes: string[];
  links: ExtractedLink[];
}

export interface Inbox {
  id: string;
  email: string;
  expiresAt: string;
  createdAt: string;
  emailCount?: number;
  isExpired?: boolean;
}

export interface EmailSummary {
  id: string;
  from: string;
  subject: string;
  receivedAt: string;
  isRead: boolean;
  hasAttachments?: boolean;
  preview?: string;
  extracted?: Extracted;
}

export interface EmailDetail {
  id: string;
  inboxId?: string;
  from: string;
  subject: string;
  text?: string;
  textBody?: string | null;
  htmlBody?: string | null;
  attachments?: { filename: string; contentType: string; size: number }[];
  extracted?: Extracted;
  receivedAt: string;
}

export interface WaitResult {
  email: EmailDetail | null;
  timedOut: boolean;
}

/** An error with a message written for the agent (and the human behind it). */
export class OpenInboxError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OpenInboxError';
  }
}

type FetchFn = typeof fetch;

/** Thin client for the OpenInbox REST API (`/v1`). */
export class OpenInboxClient {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string | undefined,
    baseUrl: string = DEFAULT_API_URL,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  createInbox(opts: { prefix?: string; domain?: string } = {}): Promise<Inbox> {
    return this.request<Inbox>('POST', '/inboxes', { body: opts });
  }

  listInboxes(): Promise<Inbox[]> {
    return this.request<Inbox[]>('GET', '/inboxes', { query: { limit: 100 } });
  }

  getInbox(inboxId: string): Promise<Inbox> {
    return this.request<Inbox>('GET', `/inboxes/${enc(inboxId)}`);
  }

  async deleteInbox(inboxId: string): Promise<void> {
    await this.request('DELETE', `/inboxes/${enc(inboxId)}`);
  }

  listEmails(inboxId: string, opts: { unreadOnly?: boolean } = {}): Promise<EmailSummary[]> {
    return this.request<EmailSummary[]>('GET', `/inboxes/${enc(inboxId)}/emails`, {
      query: { unreadOnly: opts.unreadOnly ? 'true' : undefined },
    });
  }

  getEmail(emailId: string): Promise<EmailDetail> {
    return this.request<EmailDetail>('GET', `/emails/${enc(emailId)}`);
  }

  /**
   * Long-poll for a matching email. The server holds each request for at most
   * 55s, so longer waits are split into several requests.
   */
  async waitForEmail(
    inboxId: string,
    opts: { from?: string; subject?: string; since?: string; timeoutSeconds?: number } = {},
  ): Promise<WaitResult> {
    const deadline = Date.now() + Math.max(1, opts.timeoutSeconds ?? 60) * 1000;
    for (;;) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      if (remaining <= 0) return { email: null, timedOut: true };
      const started = Date.now();
      const res = await this.request<EmailDetail | null>('GET', `/inboxes/${enc(inboxId)}/wait`, {
        query: {
          from: opts.from,
          subject: opts.subject,
          since: opts.since,
          timeout: Math.min(remaining, 55),
        },
      });
      if (res) return { email: res, timedOut: false };
      // The server normally holds the request open; if it answered "nothing
      // yet" almost instantly, pause so we never spin in a tight loop.
      if (Date.now() - started < 1000) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  getAccount(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', '/account');
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    if (!this.apiKey) {
      throw new OpenInboxError(
        `OPENINBOX_API_KEY is not set. Get an API key at ${SETTINGS_URL} (API access is included in the Pro, Business and 7-Day Pass plans: ${PRICING_URL}) and add it to this MCP server's environment.`,
      );
    }

    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers: {
          'X-API-Key': this.apiKey,
          'User-Agent': `openinbox-mcp/${VERSION}`,
          Accept: 'application/json',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      throw new OpenInboxError(`Could not reach the OpenInbox API (${(err as Error).message}). Check your network connection and try again.`);
    }

    const payload = (await res.json().catch(() => null)) as
      | { success?: boolean; data?: unknown; message?: unknown; error?: unknown }
      | null;

    if (!res.ok) throw new OpenInboxError(errorMessage(res.status, payload), res.status);
    return (payload?.data ?? null) as T;
  }
}

function enc(id: string): string {
  return encodeURIComponent(id.trim());
}

function errorMessage(status: number, payload: { message?: unknown; error?: unknown } | null): string {
  const raw = payload?.message ?? payload?.error;
  const serverMsg = Array.isArray(raw) ? raw.join('; ') : typeof raw === 'string' ? raw : '';
  switch (status) {
    case 401:
      return `The OpenInbox API key was rejected. Check OPENINBOX_API_KEY, or create a new key at ${SETTINGS_URL}.`;
    case 403:
      return `${serverMsg || 'This action is not available on your OpenInbox plan.'} Plans: ${PRICING_URL}`;
    case 404:
      return `${serverMsg || 'Not found'}. The inbox may have expired or been deleted — use list_inboxes, or create_inbox for a fresh one.`;
    case 429:
      return serverMsg || 'OpenInbox rate limit reached. Wait a bit and retry, or reuse an existing inbox.';
    default:
      return serverMsg ? `OpenInbox API error (${status}): ${serverMsg}` : `OpenInbox API error (${status}).`;
  }
}
