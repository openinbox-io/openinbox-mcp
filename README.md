# OpenInbox MCP server

[![npm](https://img.shields.io/npm/v/openinbox-mcp)](https://www.npmjs.com/package/openinbox-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[![OpenInbox – Email for AI Agents MCP server – quality and maintenance score on Glama](https://glama.ai/mcp/servers/openinbox-io/openinbox-mcp/badges/card.svg)](https://glama.ai/mcp/servers/openinbox-io/openinbox-mcp)

**Give your AI agent its own email inbox.** This [Model Context Protocol](https://modelcontextprotocol.io) server lets Claude, Cursor, Codex, VS Code and other MCP clients create real, disposable email addresses with [OpenInbox](https://openinbox.io), wait for incoming mail, and pull out verification codes and links, so the agent can finish signups, logins and email-flow tests without a human checking an inbox.

```
You:    Sign up for the Acme newsletter and confirm the subscription.
Agent:  create_inbox      → k7x2@teminbox.click
        (fills in the signup form)
        get_verification  → link: https://acme.com/confirm?t=…
        (opens the link)  → Done, subscription confirmed.
```

## Quick start

1. **Get an API key.** API access is included in the OpenInbox **Pro**, **Business** and **7-Day Pass** plans ([pricing](https://openinbox.io/pricing)). Copy your key from **[Settings → API](https://openinbox.io/settings)**.
2. **Add the server to your client** (examples below). Replace `tmp_your_key` with your key.

### Claude Code

```bash
claude mcp add openinbox --env OPENINBOX_API_KEY=tmp_your_key -- npx -y openinbox-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "openinbox": {
      "command": "npx",
      "args": ["-y", "openinbox-mcp"],
      "env": { "OPENINBOX_API_KEY": "tmp_your_key" }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "openinbox": {
      "command": "npx",
      "args": ["-y", "openinbox-mcp"],
      "env": { "OPENINBOX_API_KEY": "tmp_your_key" }
    }
  }
}
```

### VS Code (GitHub Copilot agent mode)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "openinbox": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "openinbox-mcp"],
      "env": { "OPENINBOX_API_KEY": "tmp_your_key" }
    }
  }
}
```

### OpenAI Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.openinbox]
command = "npx"
args = ["-y", "openinbox-mcp"]
env = { OPENINBOX_API_KEY = "tmp_your_key" }
```

Any other MCP client that can run a stdio server works the same way: command `npx`, args `-y openinbox-mcp`, env `OPENINBOX_API_KEY`.

## Tools

| Tool | What it does |
|---|---|
| `create_inbox` | Creates a new disposable address. Optional `prefix` (custom alias) and `domain` (your own verified custom domain). |
| `get_verification` | Waits for the next email and returns **just the one-time code and/or verification link**. The shortcut for signups and logins. |
| `wait_for_email` | Waits for a matching email (`from`, `subject`, `since` filters) and returns it in full. |
| `list_emails` | Lists emails in an inbox with previews and detected codes. |
| `read_email` | Reads one email as plain text, with its codes and links. |
| `list_inboxes` | Lists your active inboxes. |
| `delete_inbox` | Deletes an inbox when the task is done. |
| `get_account` | Shows your plan, remaining API requests today and inbox usage. |

Codes and links are detected server-side (6-digit codes, `123 456`, alphanumeric codes, verify/confirm/magic-link/reset links, in many languages), so the agent doesn't need to parse HTML.

## Example prompts

- *"Create a temporary email, sign up for a trial at example.com with it, and confirm the account."*
- *"Test our password-reset flow on staging: request a reset for a fresh inbox and check that the email arrives with a working link."*
- *"Make an inbox, register on the forum, and tell me the verification code."*

## Tips

- **Sites that block temp-mail domains:** add your own domain in OpenInbox (included in Pro, Business and 7-Day Pass) and pass it as `domain` to `create_inbox`. Addresses on your domain look like any normal mailbox.
- **One inbox per site or task.** Reuse it for follow-up emails, and delete it when you're done.
- **Inbox lifetime** depends on your plan (Pro: 7 days, Business: 30 days, 7-Day Pass: 7 days).

## Limits and fair use

Each API call counts toward your plan's daily request limit (3,000 on Pro and 7-Day Pass, 10,000 on Business). Inbox creation is also capped per hour (60 on Pro and 7-Day Pass, 300 on Business). `wait_for_email` and `get_verification` hold a single request open while waiting, so waiting costs about one request per minute.

Use it for your own accounts, testing and automation. Mass account creation, spam and other abuse are against the [OpenInbox terms](https://openinbox.io/terms) and lead to suspension.

## Configuration

| Variable | Required | Default |
|---|---|---|
| `OPENINBOX_API_KEY` | yes | none |
| `OPENINBOX_API_URL` | no | `https://api.openinbox.io/api/v1` |

## Development

```bash
npm install
npm test        # builds and runs the test suite
npm run build   # outputs dist/index.js
```

## Links

- Website: [openinbox.io](https://openinbox.io)
- AI agents: [openinbox.io/ai-agents](https://openinbox.io/ai-agents)
- API docs: [openinbox.io/api-docs](https://openinbox.io/api-docs)
- n8n integration: [n8n-nodes-openinbox](https://github.com/openinbox-io/n8n-nodes-openinbox)
- Support: support@openinbox.io

## License

MIT © OpenInbox
