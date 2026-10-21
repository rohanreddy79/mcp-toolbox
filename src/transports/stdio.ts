/** stdio transport: the default for Claude Desktop / Claude Code. stdout is the protocol channel; logs go to stderr. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ToolboxServer } from '../server.js';

export async function serveStdio(factory: () => ToolboxServer): Promise<ToolboxServer> {
  const toolbox = factory();
  await toolbox.server.connect(new StdioServerTransport());
  return toolbox;
}
