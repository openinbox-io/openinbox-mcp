import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { OpenInboxClient, OpenInboxError, type EmailDetail } from './client.js';
import { VERSION } from './version.js';

/** Email text longer than this is truncated in tool output (keeps context small). */
const MAX_TEXT_CHARS = 20_000;

const INSTRUCTIONS = `OpenInbox gives you real, disposable email addresses.
Typical flow for signing up somewhere or testing an email flow:
1. create_inbox → use the returned address in the form.
2. Submit the form.
3. get_verification (or wait_for_email) → returns the one-time code and/or the verification link.
Use one inbox per site/task, reuse it for follow-up emails, and delete_inbox when done.
Inboxes expire automatically (lifetime depends on the user's plan).`;

export function createServer(client: OpenInboxClient): McpServer {
  const server = new McpServer({ name: 'openinbox', version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'create_inbox',
    {
      title: 'Create inbox',
      description:
        'Create a new disposable email address that can receive email right away. Use it to sign up for a website, receive a verification code or link, or test an email flow. Returns the address and an inbox_id for the other tools.',
      inputSchema: {
        prefix: z
          .string()
          .optional()
          .describe('Optional custom local part, e.g. "jane.test" → jane.test@<domain>. Needs a plan with custom aliases.'),
        domain: z
          .string()
          .optional()
          .describe(
            "Optional custom domain the user has verified in OpenInbox (e.g. \"mail.example.com\"). Useful when a site blocks shared temporary-email domains. Omit to use OpenInbox's domains.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ prefix, domain }) =>
      run(async () => {
        const inbox = await client.createInbox({ prefix: prefix || undefined, domain: domain || undefined });
        return {
          inbox_id: inbox.id,
          email: inbox.email,
          expires_at: inbox.expiresAt,
          next_step: 'Use this address, then call get_verification or wait_for_email with this inbox_id.',
        };
      }),
  );

  server.registerTool(
    'get_verification',
    {
      title: 'Get verification code or link',
      description:
        'Wait for the next verification email in an inbox and return just the one-time code and/or the verification / magic / password-reset link. The fastest way to finish a signup or login. Waits up to timeout_seconds for the email to arrive.',
      inputSchema: {
        inbox_id: z.string().describe('The inbox_id returned by create_inbox.'),
        from: z
          .string()
          .optional()
          .describe('Only match senders containing this text, e.g. "github.com". Recommended when the inbox gets other mail.'),
        timeout_seconds: z
          .number()
          .int()
          .min(5)
          .max(300)
          .optional()
          .describe('How long to wait for the email (default 60).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ inbox_id, from, timeout_seconds }) =>
      run(async () => {
        const { email } = await client.waitForEmail(inbox_id, { from, timeoutSeconds: timeout_seconds ?? 60 });
        if (!email) {
          return {
            found: false,
            message: `No matching email arrived within ${timeout_seconds ?? 60}s. Check the address was submitted correctly, look for a "resend" button, then call get_verification again.`,
          };
        }
        const codes = email.extracted?.codes ?? [];
        const action = (email.extracted?.links ?? []).filter((l) =>
          ['verification', 'magic-link', 'password-reset'].includes(l.kind),
        );
        return {
          found: true,
          code: codes[0] ?? null,
          other_codes: codes.slice(1),
          link: action[0]?.url ?? null,
          link_kind: action[0]?.kind ?? null,
          other_links: action.slice(1).map((l) => l.url),
          email_id: email.id,
          from: email.from,
          subject: email.subject,
          ...(codes.length === 0 && action.length === 0
            ? { note: 'No code or verification link was detected automatically — call read_email with this email_id to read the full message.' }
            : {}),
        };
      }),
  );

  server.registerTool(
    'wait_for_email',
    {
      title: 'Wait for email',
      description:
        'Wait until a matching email arrives in an inbox and return it in full (text, detected codes, links). Without "since", returns the newest unread matching email, so repeated calls return successive emails.',
      inputSchema: {
        inbox_id: z.string().describe('The inbox_id returned by create_inbox.'),
        from: z.string().optional().describe('Only match senders containing this text.'),
        subject: z.string().optional().describe('Only match subjects containing this text.'),
        since: z
          .string()
          .optional()
          .describe('ISO timestamp — only match emails received after it (read or unread).'),
        timeout_seconds: z.number().int().min(5).max(300).optional().describe('How long to wait (default 60).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ inbox_id, from, subject, since, timeout_seconds }) =>
      run(async () => {
        const { email } = await client.waitForEmail(inbox_id, {
          from,
          subject,
          since,
          timeoutSeconds: timeout_seconds ?? 60,
        });
        if (!email) return { found: false, message: `No matching email within ${timeout_seconds ?? 60}s. Call again to keep waiting.` };
        return { found: true, email: formatEmail(email) };
      }),
  );

  server.registerTool(
    'list_emails',
    {
      title: 'List emails',
      description: 'List the emails in an inbox (newest first, up to 30) with sender, subject, preview and detected codes.',
      inputSchema: {
        inbox_id: z.string().describe('The inbox_id returned by create_inbox.'),
        unread_only: z.boolean().optional().describe('Only return unread emails.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ inbox_id, unread_only }) =>
      run(async () => {
        const emails = await client.listEmails(inbox_id, { unreadOnly: unread_only });
        return {
          count: emails.length,
          emails: emails.map((e) => ({
            email_id: e.id,
            from: e.from,
            subject: e.subject,
            received_at: e.receivedAt,
            is_read: e.isRead,
            preview: e.preview,
            codes: e.extracted?.codes ?? [],
          })),
        };
      }),
  );

  server.registerTool(
    'read_email',
    {
      title: 'Read email',
      description: 'Read one email as plain text, with its detected codes and links.',
      inputSchema: { email_id: z.string().describe('An email_id from list_emails, wait_for_email or get_verification.') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ email_id }) => run(async () => formatEmail(await client.getEmail(email_id))),
  );

  server.registerTool(
    'list_inboxes',
    {
      title: 'List inboxes',
      description: "List the user's active OpenInbox inboxes.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        const inboxes = await client.listInboxes();
        return {
          count: inboxes.length,
          inboxes: inboxes.map((i) => ({
            inbox_id: i.id,
            email: i.email,
            expires_at: i.expiresAt,
            email_count: i.emailCount ?? 0,
          })),
        };
      }),
  );

  server.registerTool(
    'delete_inbox',
    {
      title: 'Delete inbox',
      description: 'Delete an inbox and its emails when the task is done.',
      inputSchema: { inbox_id: z.string().describe('The inbox to delete.') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ inbox_id }) =>
      run(async () => {
        await client.deleteInbox(inbox_id);
        return { deleted: true, inbox_id };
      }),
  );

  server.registerTool(
    'get_account',
    {
      title: 'Account and limits',
      description: "Show the user's OpenInbox plan, remaining API requests today and inbox usage.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        const a = (await client.getAccount()) as Record<string, any>;
        return { plan: a.tierName ?? a.tier, rate_limit: a.rateLimit, usage: a.usage };
      }),
  );

  return server;
}

function formatEmail(email: EmailDetail) {
  let text = email.text ?? email.textBody ?? '';
  const truncated = text.length > MAX_TEXT_CHARS;
  if (truncated) text = `${text.slice(0, MAX_TEXT_CHARS)}\n…[truncated]`;
  return {
    email_id: email.id,
    from: email.from,
    subject: email.subject,
    received_at: email.receivedAt,
    codes: email.extracted?.codes ?? [],
    links: (email.extracted?.links ?? []).filter((l) => l.kind !== 'unsubscribe'),
    attachments: email.attachments?.map((a) => `${a.filename} (${a.contentType}, ${a.size} bytes)`) ?? [],
    text,
  };
}

/** Runs a tool body and turns the result (or an error) into an MCP result. */
export async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message =
      err instanceof OpenInboxError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}`;
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
}
