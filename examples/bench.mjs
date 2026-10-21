// Latency of each tool over the two transports, against the example data. Sequential calls, so the
// numbers are per-request round trips (protocol + handler), not throughput under concurrency.
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AuditLog, createToolboxServer, loadConfig } from '../dist/index.js';
import { seed } from './seed.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = path.join(here, 'toolbox.config.json');
const iterations = Number(process.argv[2] ?? 200);

const cases = [
  ['sqlite_query', { database: 'demo', sql: 'SELECT customer, sum(total_cents) AS cents FROM order_totals GROUP BY customer ORDER BY cents DESC' }],
  ['sqlite_describe_table', { database: 'demo', table: 'orders' }],
  ['fs_list', { depth: 2 }],
  ['fs_read', { path: 'notes/README.md' }],
  ['fs_search', { pattern: 'runbook', include: ['*.md'] }],
  ['fs_read (rejected)', { path: '../../etc/passwd' }, 'fs_read'],
];

async function connectInMemory() {
  const cfg = await loadConfig({ configPath: config, overrides: { auditLog: undefined } });
  const toolbox = createToolboxServer({ ...cfg, auditLog: undefined }, { audit: new AuditLog(undefined) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await toolbox.server.connect(serverTransport);
  const client = new Client({ name: 'bench', version: '0' });
  await client.connect(clientTransport);
  return { client, close: () => client.close().then(() => toolbox.close()) };
}

async function connectStdio() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, '..', 'dist', 'cli.js'), '--config', config],
    stderr: 'ignore',
  });
  const client = new Client({ name: 'bench', version: '0' });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p50: pick(0.5), p95: pick(0.95), mean: samples.reduce((a, b) => a + b, 0) / samples.length };
}

async function measure(client, name, args) {
  for (let i = 0; i < 5; i += 1) await client.callTool({ name, arguments: args });
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    await client.callTool({ name, arguments: args });
    samples.push(performance.now() - t0);
  }
  return stats(samples);
}

await seed();
const results = [];
for (const [label, connect] of [['in-memory', connectInMemory], ['stdio', connectStdio]]) {
  const session = await connect();
  for (const [name, args, tool] of cases) results.push({ transport: label, name, ...(await measure(session.client, tool ?? name, args)) });
  await session.close();
}

const fmt = (n) => n.toFixed(2).padStart(7);
console.log(`\n${iterations} sequential calls per cell, ms per call (Node ${process.version}, ${process.arch})\n`);
console.log('| tool | in-memory p50 | in-memory p95 | stdio p50 | stdio p95 |');
console.log('|---|---:|---:|---:|---:|');
for (const [name] of cases) {
  const mem = results.find((r) => r.transport === 'in-memory' && r.name === name);
  const io = results.find((r) => r.transport === 'stdio' && r.name === name);
  console.log(`| ${name} | ${fmt(mem.p50)} | ${fmt(mem.p95)} | ${fmt(io.p50)} | ${fmt(io.p95)} |`);
}
