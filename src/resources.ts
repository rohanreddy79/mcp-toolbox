/**
 * Resources: `sqlite://<db>/schema` (full DDL) and `file://<root-relative path>` (text file contents).
 * Both go through the same registries and safety checks as the tools, and both are audited.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ListResourcesResult } from '@modelcontextprotocol/sdk/types.js';
import { resolveExisting } from './safety/paths.js';
import { audited, type ServerContext } from './tooling.js';
import { readTextFile, walk } from './tools/fs.js';
import { schemaDdl } from './tools/sqlite.js';
import { guessMimeType } from './util/text.js';

const LIST_DEPTH = 2;
const LIST_MAX_FILES = 200;

export function fileResourceUri(relativePath: string): string {
  return `file://${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

async function listFileResources(ctx: ServerContext): Promise<ListResourcesResult> {
  const resources: ListResourcesResult['resources'] = [];
  for (const root of ctx.config.roots) {
    await walk(root, root, { maxDepth: LIST_DEPTH, ignore: ctx.config.ignore }, (entry) => {
      if (entry.type === 'file') {
        resources.push({ uri: fileResourceUri(entry.path), name: entry.path, mimeType: guessMimeType(entry.path) });
      }
      return resources.length < LIST_MAX_FILES;
    });
    if (resources.length >= LIST_MAX_FILES) break;
  }
  return { resources };
}

const variable = (value: string | string[] | undefined): string => (Array.isArray(value) ? value.join('/') : (value ?? ''));

export function registerResources(server: McpServer, ctx: ServerContext): void {
  server.registerResource(
    'sqlite-schema',
    new ResourceTemplate('sqlite://{database}/schema', {
      list: () => ({
        resources: ctx.databases.names().map((name) => ({
          uri: `sqlite://${name}/schema`,
          name: `${name} schema`,
          description: `DDL of the "${name}" SQLite database`,
          mimeType: 'application/sql',
        })),
      }),
    }),
    {
      title: 'SQLite schema',
      description: 'Full DDL (tables, indexes, views, triggers) of a configured database',
      mimeType: 'application/sql',
    },
    (uri, variables) =>
      audited(ctx, 'resource', 'sqlite_schema', { uri: uri.href }, async () => {
        const db = ctx.databases.open(variable(variables['database']));
        return { contents: [{ uri: uri.href, mimeType: 'application/sql', text: schemaDdl(db) }] };
      }),
  );

  server.registerResource(
    'file',
    new ResourceTemplate('file://{+path}', { list: () => listFileResources(ctx) }),
    {
      title: 'File',
      description: 'A text file inside an allowed root: file://notes/todo.md (root-relative) or file:///abs/path',
    },
    (uri, variables) =>
      audited(ctx, 'resource', 'file', { uri: uri.href }, async () => {
        const requested = decodeURIComponent(variable(variables['path']));
        const resolved = await resolveExisting(ctx.config.roots, requested);
        const result = await readTextFile(resolved, { maxBytes: ctx.config.maxBytes });
        return { contents: [{ uri: uri.href, mimeType: guessMimeType(resolved.absolute), text: result.text }] };
      }),
  );
}
