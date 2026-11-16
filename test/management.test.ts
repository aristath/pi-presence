import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { listJournal, manageJournal } from '../src/management.ts';
import { history, contextText, locate } from '../src/store.ts';
import { PresenceService } from '../src/service.ts';

async function fixture(t: any) {
  const base = await mkdtemp(join(tmpdir(), 'presence-admin-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const agent = join(base, 'agent'); await mkdir(agent);
  const config = { root: join(base, 'journal'), user: 'person', defaultUser: 'person', contextMessages: 2 };
  await writeFile(join(agent, "settings.json"), JSON.stringify({ presence: config }));
  const add = (text: string, requestId = randomUUID()) => manageJournal(agent, { action: 'create', text, requestId }) as Promise<any>;
  return { base, agent, config, add };
}
test('editor and Pi share durable entries, custom context order and unchanged timestamps', async t => {
  const f = await fixture(t);
  const a = await f.add('First state'), b = await f.add('Second state');
  const initial = await listJournal(f.agent);
  assert.equal(initial.total, 2);
  await manageJournal(f.agent, { action: 'move', id: a.entry.id, position: 'start', revision: initial.revision });
  const ordered = await listJournal(f.agent);
  assert.deepEqual(ordered.entries.map(row => row.id), [a.entry.id, b.entry.id]);
  assert.equal(ordered.entries[0].created_at, a.entry.created_at);
  await manageJournal(f.agent, { action: 'edit', id: a.entry.id, text: 'A changed state', revision: ordered.revision });
  const service = new PresenceService(f.agent);
  const modelHistory = await service.history(f.config);
  assert.match(contextText(modelHistory, 2), /A changed state/);
  assert.equal(modelHistory.entries[0].id, a.entry.id);
  const c = await f.add('New automatic state');
  const latest = await listJournal(f.agent);
  assert.deepEqual(latest.entries.map(row => row.id), [c.entry.id, a.entry.id, b.entry.id]);
  await manageJournal(f.agent, { action: 'delete', id: a.entry.id, revision: latest.revision });
  assert.deepEqual((await service.history(f.config)).entries.map(row => row.id), [c.entry.id, b.entry.id]);
});
test('retrying creation reuses the committed entry and stale edits/pages do not overwrite current work', async t => {
  const f = await fixture(t), requestId = randomUUID();
  const entry = await f.add('Original', requestId);
  assert.equal((await f.add('Original', requestId)).entry.id, entry.entry.id);
  const before = await listJournal(f.agent, { limit: 1 });
  await f.add('Concurrent write');
  await assert.rejects(manageJournal(f.agent, { action: 'edit', id: entry.entry.id, text: 'Stale edit', revision: before.revision }), /Presence changed/);
  await assert.rejects(listJournal(f.agent, { before: entry.entry.id, revision: before.revision }), /Presence changed/);
  assert.equal((await listJournal(f.agent)).entries.find(row => row.id === entry.entry.id)?.text, 'Original');
});
test('paginated journal has no gaps; damaged records and ordering remain preserved', async t => {
  const f = await fixture(t);
  const path = await locate(f.config.root, 'person', 'person', true);
  for (let i = 0; i < 65; i++) {
    const id = i.toString(16).padStart(64, '0');
    await writeFile(join(path, id + '.md'), '---\n' + JSON.stringify({ id, created_at: new Date(i * 1000).toISOString() }) + '\n---\nState ' + i);
  }
  let page = await listJournal(f.agent), entries = [...page.entries];
  while (page.next_before) { page = await listJournal(f.agent, { before: page.next_before, revision: page.revision }); entries.push(...page.entries); }
  assert.equal(entries.length, 65); assert.equal(new Set(entries.map(row => row.id)).size, 65);
  await writeFile(join(path, 'f'.repeat(64) + '.md'), 'unreadable');
  await writeFile(join(path, '.presence-order.json'), 'damaged');
  const damaged = await listJournal(f.agent);
  assert.equal(damaged.entries.length, 30); assert.equal(damaged.warnings.length, 2);
  await assert.rejects(manageJournal(f.agent, { action: 'move', id: entries[0].id, position: 'end', revision: damaged.revision }), /Repair/);
  assert.equal(await readFile(join(path, '.presence-order.json'), 'utf8'), 'damaged');
});
