// Journal administration uses the same advisory lock as presence_write. No web
// process owns a second journal or changes an entry's original timestamp.
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { journalLock, loadConfig, type Config } from './service.ts';
import { bind, checkGuard, hash, history, listPage, locate, owner, publish, syncDirectory, type History, type Guard, unique } from './store.ts';

function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
const revision = (found: History) => hash(JSON.stringify(found));
export async function listJournal(agentDir: string, args: { before?: string; revision?: string; limit?: number; cwd?: string; settings?: Record<string, unknown>; validateConfig?: (config: Config) => void | Promise<void> } = {}) {
  const config = await loadConfig(agentDir, args.cwd, args.settings);
  await args.validateConfig?.(config);
  let found: History = { entries: [], warnings: [] };
  try { found = await history(await locate(config.root, config.user, config.defaultUser, false, config.agentUser, config.directory)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const current = revision(found);
  if (args.revision && current !== args.revision) fail('Presence changed. Refresh the list to continue; your draft is retained.', 409);
  const page = listPage(found, Math.min(Math.max(Number(args.limit) || 30, 1), 100), args.before);
  return { ...page, revision: current, total: found.entries.length, owner: owner(config.user, config.defaultUser, config.agentUser), contextMessages: config.contextMessages, contextIds: unique(found.entries).slice(0, config.contextMessages).map(entry => entry.id), contextError: config.contextError };
}
async function atomic(path: string, data: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path); await syncDirectory(join(path, '..'));
  } finally { await unlink(temporary).catch(() => {}); }
}
export interface Change { action: string; revision?: string; id?: string; text?: string; requestId?: string; target?: string; position?: string }
async function applyChange(agentDir: string, input: Change, lockedGuard?: Guard, cwd = process.cwd(), selectedConfig?: Config) {
  if (!input || !['create', 'edit', 'delete', 'move'].includes(input.action)) fail('Choose a supported presence action.');
  const config = selectedConfig ?? await loadConfig(agentDir, cwd);
  const path = await locate(config.root, config.user, config.defaultUser, true, config.agentUser, config.directory);
  const guard = await bind(path);
  if (lockedGuard) {
    await checkGuard(lockedGuard);
    if (JSON.stringify(guard) !== JSON.stringify(lockedGuard)) fail('Presence profile changed while waiting to save. Refresh before retrying.', 409);
  }
  const found = await history(path);
  if (input.action === 'create') {
    if (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId)) fail('A creation request ID is required.');
    if (typeof input.text !== 'string' || !input.text.trim()) fail('Presence text must not be empty.');
    return { entry: await publish({ invocation: `presence-editor:${input.requestId}`, at: Date.now(), text: input.text, guard }) };
  }
  if (!input.revision || input.revision !== revision(found)) fail('Presence changed. Refresh before saving; your draft is retained.', 409);
  const entry = found.entries.find(row => row.id === input.id);
  if (!entry) fail('This presence entry is unavailable. Refresh the list.', 409);
  await checkGuard(guard);
  if (input.action === 'move') {
    // Do not replace damaged ordering metadata with an apparently empty order.
    if (found.warnings.some(warning => warning.includes('order'))) fail('Repair the saved presence order before reordering.', 409);
    const ids = found.entries.map(row => row.id).filter(id => id !== input.id);
    let index = ids.indexOf(input.target!);
    if (input.position === 'start') index = 0;
    else if (input.position === 'end') index = ids.length;
    if (index < 0 || (!['start', 'end', 'before', 'after'].includes(input.position!))) fail('Choose an available destination.');
    if (input.position === 'after') index++;
    ids.splice(index, 0, entry.id);
    await atomic(join(path, '.presence-order.json'), `${JSON.stringify(ids)}\n`);
  } else if (input.action === 'delete') {
    await unlink(join(path, `${entry.id}.md`)); await syncDirectory(path);
  } else {
    if (typeof input.text !== 'string' || !input.text.trim()) fail('Presence text must not be empty.');
    const file = await open(join(path, `${entry.id}.md`), constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: string; try { raw = await file.readFile('utf8'); } finally { await file.close(); }
    await atomic(join(path, `${entry.id}.md`), `${raw.slice(0, raw.indexOf('\n---\n', 4) + 5)}${input.text}`);
  }
  return { saved: true };
}
export async function manageJournal(agentDir: string, input: Change, cwd = process.cwd(), validateConfig?: (config: Config) => void | Promise<void>, settings?: Record<string, unknown>) {
  const config = await loadConfig(agentDir, cwd, settings);
  await validateConfig?.(config);
  const path = await locate(config.root, config.user, config.defaultUser, true, config.agentUser, config.directory);
  const guard = await bind(path);
  const release = await journalLock(path);
  try {
    return await applyChange(agentDir, input, guard, cwd, config);
  } finally {
    await release();
  }
}
