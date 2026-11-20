#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_API_URL, OpenInboxClient } from './client.js';
import { createServer } from './server.js';

async function main() {
  // A missing key is not fatal: the server still starts (so clients and MCP
  // directories can list the tools) and every tool explains how to set it.
  const client = new OpenInboxClient(
    process.env.OPENINBOX_API_KEY?.trim() || undefined,
    process.env.OPENINBOX_API_URL?.trim() || DEFAULT_API_URL,
  );
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  // stdout is the MCP channel — log to stderr only.
  console.error('openinbox-mcp failed to start:', err);
  process.exit(1);
});
