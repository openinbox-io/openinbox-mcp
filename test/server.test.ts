import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OpenInboxClient } from '../src/client.js';
import { createServer } from '../src/server.js';
import { VERSION } from '../src/version.js';

type Call = { method: string; url: URL; headers: Record<string, string>; body?: unknown };
type Reply = { status?: number; body: unknown };

/** Fake fetch: records calls and answers from a route table. */
function fakeApi(routes: Record<string, Reply | Reply[] | ((c: Call) => Reply)>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: URL, init: RequestInit) => {
    const call: Call = {
      method: init.method ?? 'GET',
      url: new URL(input),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const key = `${call.method} ${call.url.pathname.replace('/api/v1', '')}`;
    let route = routes[key];
    if (!route) return new Response(JSON.stringify({ message: 'Not found' }), { status: 404 });
    let reply: Reply;
    if (typeof route === 'function') reply = route(call);
    else if (Array.isArray(route)) reply = route.length > 1 ? route.shift()! : route[0];
    else reply = route;
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

async function connect(apiKey: string | undefined, fetchFn: typeof fetch) {
  const server = createServer(new OpenInboxClient(apiKey, 'https://api.test/api/v1', fetchFn));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(b);
  return client;
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: !!res.isError, text: res.content[0].text, json: res.isError ? null : JSON.parse(res.content[0].text) };
}

const otpEmail = {
  id: 'e1',
  from: 'GitHub <noreply@github.com>',
  subject: 'Your GitHub launch code',
  text: 'Here is your GitHub launch code: 51640219',
  extracted: {
    codes: ['51640219'],
    links: [
      { url: 'https://github.com/verify?t=1', text: 'Verify', kind: 'verification' },
      { url: 'https://github.com/unsub', text: 'Unsubscribe', kind: 'unsubscribe' },
    ],
  },
  receivedAt: '2026-11-20T10:00:00Z',
};

test('version matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
});

test('lists all tools', async () => {
  const { fetchFn } = fakeApi({});
  const client = await connect('k', fetchFn);
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['create_inbox', 'delete_inbox', 'get_account', 'get_verification', 'list_emails', 'list_inboxes', 'read_email', 'wait_for_email'],
  );
});

test('create_inbox sends the key, user agent and body', async () => {
  const { fetchFn, calls } = fakeApi({
    'POST /inboxes': { status: 201, body: { success: true, data: { id: 'i1', email: 'k7x2@teminbox.click', expiresAt: 'x', createdAt: 'y' } } },
  });
  const client = await connect('tmp_abc', fetchFn);
  const r = await callJson(client, 'create_inbox', { domain: 'mail.example.com' });
  assert.equal(r.json.email, 'k7x2@teminbox.click');
  assert.equal(r.json.inbox_id, 'i1');
  assert.equal(calls[0].headers['X-API-Key'], 'tmp_abc');
  assert.equal(calls[0].headers['User-Agent'], `openinbox-mcp/${VERSION}`);
  assert.deepEqual(calls[0].body, { domain: 'mail.example.com' });
});

test('get_verification returns just the code and the action link', async () => {
  const { fetchFn, calls } = fakeApi({
    'GET /inboxes/i1/wait': { body: { success: true, data: otpEmail, meta: { timedOut: false } } },
  });
  const client = await connect('k', fetchFn);
  const r = await callJson(client, 'get_verification', { inbox_id: 'i1', from: 'github.com' });
  assert.equal(r.json.found, true);
  assert.equal(r.json.code, '51640219');
  assert.equal(r.json.link, 'https://github.com/verify?t=1');
  assert.equal(r.json.link_kind, 'verification');
  assert.equal(calls[0].url.searchParams.get('from'), 'github.com');
  assert.equal(calls[0].url.searchParams.get('timeout'), '55');
});

test('waiting longer than one long-poll re-polls until the email arrives', async () => {
  const { fetchFn, calls } = fakeApi({
    'GET /inboxes/i1/wait': [
      { body: { success: true, data: null, meta: { timedOut: true } } },
      { body: { success: true, data: otpEmail, meta: { timedOut: false } } },
    ],
  });
  const client = await connect('k', fetchFn);
  const r = await callJson(client, 'wait_for_email', { inbox_id: 'i1', timeout_seconds: 120 });
  assert.equal(r.json.found, true);
  assert.equal(r.json.email.codes[0], '51640219');
  assert.equal(r.json.email.links.length, 1, 'unsubscribe links are hidden');
  assert.equal(calls.length, 2);
});

test('get_verification says what to do when nothing arrives', async () => {
  const { fetchFn } = fakeApi({ 'GET /inboxes/i1/wait': { body: { success: true, data: null } } });
  const client = await connect('k', fetchFn);
  const r = await callJson(client, 'get_verification', { inbox_id: 'i1', timeout_seconds: 5 });
  assert.equal(r.json.found, false);
  assert.match(r.json.message, /resend/);
});

test('missing API key → helpful error, no request sent', async () => {
  const { fetchFn, calls } = fakeApi({});
  const client = await connect(undefined, fetchFn);
  const r = await callJson(client, 'create_inbox');
  assert.equal(r.isError, true);
  assert.match(r.text, /OPENINBOX_API_KEY is not set/);
  assert.match(r.text, /openinbox\.io\/settings/);
  assert.equal(calls.length, 0);
});

test('API errors are turned into actionable messages', async () => {
  const { fetchFn } = fakeApi({
    'GET /account': { status: 401, body: { message: 'Invalid API key' } },
    'POST /inboxes': { status: 403, body: { message: 'API access is not available on the Free plan.' } },
    'GET /emails/e9': { status: 404, body: { message: 'Email not found' } },
    'DELETE /inboxes/i1': { status: 429, body: { message: 'You can create up to 60 inboxes per hour on your plan.' } },
  });
  const client = await connect('k', fetchFn);
  assert.match((await callJson(client, 'get_account')).text, /API key was rejected/);
  const forbidden = await callJson(client, 'create_inbox');
  assert.match(forbidden.text, /Free plan\. Plans: https:\/\/openinbox\.io\/pricing/);
  assert.match((await callJson(client, 'read_email', { email_id: 'e9' })).text, /Email not found\. The inbox may have expired/);
  assert.match((await callJson(client, 'delete_inbox', { inbox_id: 'i1' })).text, /60 inboxes per hour/);
});

test('read_email truncates very long text', async () => {
  const { fetchFn } = fakeApi({
    'GET /emails/e1': { body: { success: true, data: { ...otpEmail, text: 'x'.repeat(30_000) } } },
  });
  const client = await connect('k', fetchFn);
  const r = await callJson(client, 'read_email', { email_id: 'e1' });
  assert.ok(r.json.text.length < 20_100);
  assert.match(r.json.text, /\[truncated\]$/);
});
