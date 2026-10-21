// Offline end-to-end demo: seeds the example database, launches the built server over stdio exactly
// the way Claude Desktop would, and exercises each tool family, including two rejected calls.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from './seed.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'dist', 'cli.js');
const config = path.join(here, 'toolbox.config.json');

const text = (result) => result.content.map((c) => c.text ?? '').join('\n');
const show = (label, body) => console.log(`\n== ${label}\n${body}`);

await seed();
const client = new Client({ name: 'demo-client', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--config', config], stderr: 'pipe' });
transport.stderr?.on('data', (chunk) => process.stderr.write(String(chunk)));
await client.connect(transport);

const tools = await client.listTools();
show('tools', tools.tools.map((t) => `${t.name} — ${t.title ?? ''}`).join('\n'));
show('resources', (await client.listResources()).resources.map((r) => r.uri).join('\n'));
show('prompts', (await client.listPrompts()).prompts.map((p) => p.name).join('\n'));

show('sqlite_list_tables', text(await client.callTool({ name: 'sqlite_list_tables', arguments: { database: 'demo' } })));
show(
  'sqlite_query (top customers by revenue)',
  text(
    await client.callTool({
      name: 'sqlite_query',
      arguments: {
        database: 'demo',
        sql: 'SELECT customer, sum(total_cents) / 100.0 AS eur FROM order_totals GROUP BY customer ORDER BY eur DESC LIMIT ?',
        params: [3],
      },
    }),
  ),
);
show('sqlite_query rejected', text(await client.callTool({ name: 'sqlite_query', arguments: { database: 'demo', sql: 'DROP TABLE orders' } })));
show('fs_search "runbook" in *.md', text(await client.callTool({ name: 'fs_search', arguments: { pattern: 'runbook', include: ['*.md'] } })));
show('fs_read rejected', text(await client.callTool({ name: 'fs_read', arguments: { path: '../../etc/passwd' } })));
show('resource sqlite://demo/schema', (await client.readResource({ uri: 'sqlite://demo/schema' })).contents[0].text.split('\n').slice(0, 6).join('\n') + '\n…');
show('fs_write rejected (writes disabled)', text(await client.callTool({ name: 'fs_write', arguments: { path: 'notes/new.md', content: 'x' } })));

await client.close();
console.log(`\nAudit log written to ${path.join(here, 'audit.jsonl')}`);
