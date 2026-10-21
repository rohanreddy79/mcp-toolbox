/**
 * Prompts: `explain_schema` embeds a database's DDL, `summarize_file` embeds a file. Prompt arguments
 * are strings by protocol, so numeric options arrive as text and are parsed here.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ToolboxError } from './errors.js';
import { resolveExisting } from './safety/paths.js';
import { audited, type ServerContext } from './tooling.js';
import { readTextFile } from './tools/fs.js';
import { schemaDdl } from './tools/sqlite.js';

const DEFAULT_SUMMARY_WORDS = 150;

function userMessage(description: string, text: string): GetPromptResult {
  return { description, messages: [{ role: 'user', content: { type: 'text', text } }] };
}

export function registerPrompts(server: McpServer, ctx: ServerContext): void {
  server.registerPrompt(
    'explain_schema',
    {
      title: 'Explain a database schema',
      description: 'Embeds the full DDL of a configured SQLite database and asks for a plain-language explanation.',
      argsSchema: {
        database: z.string().describe(`Configured database name (${ctx.databases.names().join(', ') || 'none'})`),
        focus: z.string().optional().describe('Optional table or question to concentrate on'),
      },
    },
    ({ database, focus }) =>
      audited(ctx, 'prompt', 'explain_schema', { database, focus }, async () => {
        const ddl = schemaDdl(ctx.databases.open(database));
        const text = [
          `Here is the full DDL of the SQLite database "${database}":`,
          '',
          '```sql',
          ddl,
          '```',
          '',
          'Explain this schema: what each table stores, how the tables relate (primary/foreign keys, join paths),',
          'which indexes exist and why, and three useful example queries. Use sqlite_query to sanity-check',
          'assumptions against real rows before stating them.',
          focus ? `\nFocus on: ${focus}` : '',
        ].join('\n');
        return userMessage(`Explain the schema of "${database}"`, text);
      }),
  );

  server.registerPrompt(
    'summarize_file',
    {
      title: 'Summarize a file',
      description: 'Embeds a text file from an allowed root and asks for a summary of the requested length.',
      argsSchema: {
        path: z.string().describe('Root-relative path of the file'),
        maxWords: z.string().optional().describe(`Target length in words (default ${DEFAULT_SUMMARY_WORDS})`),
      },
    },
    ({ path, maxWords }) =>
      audited(ctx, 'prompt', 'summarize_file', { path, maxWords }, async () => {
        const words = maxWords === undefined ? DEFAULT_SUMMARY_WORDS : Number.parseInt(maxWords, 10);
        if (!Number.isInteger(words) || words < 10 || words > 2000) {
          throw new ToolboxError('INVALID_ARGUMENT', 'maxWords must be an integer between 10 and 2000');
        }
        const resolved = await resolveExisting(ctx.config.roots, path);
        const file = await readTextFile(resolved, { maxBytes: ctx.config.maxBytes });
        const text = [
          `Summarize the file "${file.path}" (${file.bytes} bytes) in at most ${words} words.`,
          'Lead with its purpose, then the key points in the order they appear. Quote identifiers exactly.',
          '',
          '```',
          file.text,
          '```',
        ].join('\n');
        return userMessage(`Summarize ${file.path}`, text);
      }),
  );
}
