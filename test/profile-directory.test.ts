import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { manageJournal, listJournal } from '../src/management.ts';
import { PresenceService, loadConfig } from '../src/service.ts';

test('configured profile directories isolate both Pi and management journal operations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'presence-profiles-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agents: string[] = [];
  for (const user of ['first', 'second']) {
    const agent = join(root, user, '.pi'); await mkdir(agent, { recursive: true }); agents.push(agent);
    await writeFile(join(agent, 'presence.json'), JSON.stringify({ root, user, defaultUser: user, directory: join(root, user, 'presence'), contextMessages: 5 }));
  }
  const accepted: any = await manageJournal(agents[0]!, { action: 'create', text: 'A private inner state', requestId: randomUUID() });
  assert.equal((await listJournal(agents[0]!)).total, 1);
  assert.equal((await listJournal(agents[1]!)).total, 0);
  const first = new PresenceService(agents[0]!);
  assert.equal((await first.history(await loadConfig(agents[0]!))).entries[0]?.text, 'A private inner state');
  await assert.rejects(manageJournal(agents[1]!, { action: 'edit', id: accepted.entry.id, text: 'Other profile', requestId: 'foreign' }));
  assert.ok((await readdir(join(root, 'first', 'presence'))).length > 0);
});
