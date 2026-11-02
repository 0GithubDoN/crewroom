import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Room, HUMAN } from '../src/room.js';
import { formatWait } from '../src/format.js';

const tmpProject = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewroom-p-'));
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log("hello");\n');
  return dir;
};

async function setup(...names) {
  const room = new Room({ projectRoot: tmpProject() });
  const members = [];
  for (const [i, n] of names.entries()) {
    const r = await room.call('join', null, { name: n, app: `${n} app`, lead: i === 0 });
    members.push(room.memberByToken(r.your_token));
  }
  for (const m of members) await room.call('wait', m, { timeout_seconds: 0 });
  return { room, members };
}

test('ask -> finish routes the result back to the asker, with attachments', async () => {
  const { room, members: [claude, gpt] } = await setup('Claude', 'ChatGPT');
  assert.equal(room.s.leadId, claude.id);
  const { task } = await room.call('ask', claude, { to: 'ChatGPT', title: 'Make an icon', kind: 'asset' });
  assert.equal(task.status, 'assigned');
  const forGpt = await room.call('wait', gpt, { timeout_seconds: 0 });
  assert.equal(forGpt.your_tasks[0].id, task.id);
  assert.match(forGpt.guidance, /talking to you directly/);

  const shared = await room.call('share_file', gpt, { base64: Buffer.from('PNGDATA').toString('base64'), name: 'icon.png', message: false });
  await room.call('finish_task', gpt, { task_id: task.id, result: 'Here it is', attachments: [shared.asset.id] });
  const forClaude = await room.call('wait', claude, { timeout_seconds: 0 });
  const result = forClaude.new_messages.find((m) => m.kind === 'result');
  assert.equal(result.from, 'ChatGPT');
  assert.equal(result.to, 'Claude');
  assert.equal(result.attachments[0].name, 'icon.png');

  await room.call('save_asset', claude, { asset_id: shared.asset.id, path: 'public/icon.png' });
  assert.equal(fs.readFileSync(path.join(room.projectRoot, 'public/icon.png'), 'utf8'), 'PNGDATA');
  room.close();
});

test('wait blocks until a message arrives, and mentions are flagged', async () => {
  const { room, members: [a, b] } = await setup('A', 'B');
  const started = Date.now();
  const pending = room.call('wait', b, { timeout_seconds: 5 });
  setTimeout(() => room.call('send', a, { text: 'ping @B' }), 100);
  const r = await pending;
  assert.ok(Date.now() - started < 3000);
  assert.equal(r.new_messages.at(-1).text, 'ping @B');
  assert.equal(r.new_messages.at(-1).mentions_you, true);
  room.close();
});

test('file claims protect files; paths stay inside the project', async () => {
  const { room, members: [a, b] } = await setup('A', 'B');
  await room.call('claim_file', a, { path: 'index.js' });
  await assert.rejects(room.call('edit_file', b, { path: 'index.js', old_text: 'hello', new_text: 'hi' }), /being edited by A/);
  await room.call('edit_file', a, { path: path.join(room.projectRoot, 'index.js'), old_text: 'hello', new_text: 'hi' });
  assert.match(fs.readFileSync(path.join(room.projectRoot, 'index.js'), 'utf8'), /hi/);
  await assert.rejects(room.call('read_file', a, { path: '../../etc/passwd' }), /outside the project/);
  await assert.rejects(room.call('read_file', a, { path: '/etc/passwd' }), /outside the project/);
  await assert.rejects(room.call('write_file', a, { path: '.crewroom/room.json', content: '{}' }), /managed automatically/);
  await assert.rejects(room.call('write_file', a, { path: '.git/config', content: '' }), /managed automatically/);
  room.close();
});

test('file history and restore undo an edit', async () => {
  const { room, members: [a] } = await setup('A');
  await room.call('write_file', a, { path: 'index.js', content: 'broken\n' });
  const { versions } = await room.call('file_history', a, { path: 'index.js' });
  assert.equal(versions.length, 1);
  await room.call('restore_file', a, { path: 'index.js' });
  assert.match(fs.readFileSync(path.join(room.projectRoot, 'index.js'), 'utf8'), /hello/);
  room.close();
});

test('restore works even when the edit and the restore happen in the same millisecond', async () => {
  const { room, members: [a] } = await setup('A');
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  try {
    await room.call('write_file', a, { path: 'index.js', content: 'broken\n' });
    await room.call('restore_file', a, { path: 'index.js' });
  } finally {
    Date.now = realNow;
  }
  assert.match(fs.readFileSync(path.join(room.projectRoot, 'index.js'), 'utf8'), /hello/);
  assert.equal((await room.call('file_history', a, { path: 'index.js' })).versions.length, 2);
  room.close();
});

test('lead away: explicit and detected by silence; members are told to finish and wait', async () => {
  const { room, members: [lead, g] } = await setup('Claude', 'Gemini');
  await room.call('ask', lead, { to: 'Gemini', title: 'Write tests' });
  await room.call('set_activity', lead, { status: 'away', activity: 'out of tokens' });
  let r = await room.call('wait', g, { timeout_seconds: 0 });
  assert.equal(r.lead.status, 'away');
  assert.match(r.guidance, /lead \(Claude\) is away\. Finish your 1 task/);

  await room.call('status', lead); // any activity brings the lead back
  r = await room.call('wait', g, { timeout_seconds: 0 });
  assert.ok(r.new_messages.some((m) => /Claude is back/.test(m.text)));
  assert.equal(r.new_messages.filter((m) => /back/.test(m.text)).length, 1, 'announced once');

  // Silence: lead not seen for longer than leadAwayMinutes.
  room._tick();
  lead.lastSeen = Date.now() - 11 * 60_000;
  room._tick();
  r = await room.call('wait', g, { timeout_seconds: 0 });
  assert.ok(r.new_messages.some((m) => /seems to be away/.test(m.text)));
  await room.call('send', lead, { text: 'back!' });
  r = await room.call('wait', g, { timeout_seconds: 0 });
  assert.ok(r.new_messages.some((m) => /lead \(Claude\) is back/.test(m.text)));
  room.close();
});

test('only the lead or the human can do lead things', async () => {
  const { room, members: [, g] } = await setup('Claude', 'Gemini');
  await assert.rejects(room.call('set_brief', g, { brief: 'x' }), /Only the lead/);
  await room.call('set_lead', HUMAN, { name: 'Gemini' });
  assert.equal(room.leadStatus().name, 'Gemini');
  await assert.rejects(room.call('update_settings', g, { commands: 'auto' }), /Only the human/);
  room.close();
});

test('an active member name cannot be taken over; an inactive one can rejoin', async () => {
  const { room, members: [a] } = await setup('Claude');
  await assert.rejects(room.call('join', null, { name: 'claude' }), /already in the room/);
  // The same app coming back (new chat, restarted app) takes its seat back instead of "Claude 2".
  a.client = { name: 'claude-code' };
  assert.equal((await room.call('join', null, { name: 'Claude', client: { name: 'claude-code' } })).your_token, a.token);
  a.lastSeen = Date.now() - 10 * 60_000;
  const r = await room.call('join', null, { name: 'Claude', app: 'new chat' });
  assert.equal(r.your_token, a.token);
  room.close();
});

test('commands need the human: ask -> approve runs it; deny; off', async () => {
  const { room, members: [, g] } = await setup('Claude', 'ChatGPT');
  const pending = room.call('run_command', g, { command: 'echo crewroom-ok', wait_seconds: 10 });
  await new Promise((r) => setTimeout(r, 50));
  const c = room.s.commands.at(-1);
  assert.equal(c.status, 'pending');
  await room.call('approve_command', HUMAN, { command_id: c.id, approve: true });
  const result = await pending;
  assert.equal(result.status, 'finished');
  assert.equal(result.exit_code, 0);
  assert.match(result.stdout, /crewroom-ok/);

  const pending2 = room.call('run_command', g, { command: 'echo nope', wait_seconds: 10 });
  await new Promise((r) => setTimeout(r, 50));
  await room.call('approve_command', HUMAN, { command_id: room.s.commands.at(-1).id, approve: false });
  assert.equal((await pending2).status, 'denied');

  await room.call('update_settings', HUMAN, { commands: 'off' });
  await assert.rejects(room.call('run_command', g, { command: 'echo x' }), /turned off/);
  room.close();
});

test('nothing is written after close(), even with a command still waiting for approval', async () => {
  const { room, members: [, g] } = await setup('Claude', 'ChatGPT');
  await room.call('run_command', g, { command: 'echo hi', wait_seconds: 0 });
  room.close();
  assert.equal(JSON.parse(fs.readFileSync(room.stateFile, 'utf8')).commands.at(-1).status, 'expired');
  fs.rmSync(room.dataDir, { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(fs.existsSync(room.stateFile), false);
});

test('flood guard slows down a chatty agent', async () => {
  const { room, members: [a] } = await setup('A');
  for (let i = 0; i < 25; i++) await room.call('send', a, { text: `m${i}` });
  await assert.rejects(room.call('send', a, { text: 'too many' }), /Slow down/);
  room.close();
});

test('state survives a restart (same code, members, transient fields not saved)', async () => {
  const { room, members: [a] } = await setup('A');
  a._waiting = 3;
  room.close();
  const again = new Room({ projectRoot: room.projectRoot });
  assert.equal(again.code, room.code);
  assert.equal(again.memberByName('A').token, a.token);
  assert.equal(again.memberByName('A')._waiting, undefined);
  again.close();
});

test('focus mode: members get what concerns them, chatter becomes a count; the lead gets everything', async () => {
  const { room, members: [lead, b, c] } = await setup('Claude', 'Gemini', 'Codex');
  await room.call('send', c, { text: 'general chatter from Codex' });
  await room.call('send', c, { text: 'hey @Gemini, check the colors' });
  await room.call('send', c, { text: 'direct to Gemini', to: 'Gemini' });
  await room.call('send', lead, { text: 'lead says hi' });
  await room.call('send', HUMAN, { text: 'human says hi' });
  await room.call('claim_file', c, { path: 'index.js' }); // quiet update
  const r = await room.call('wait', b, { timeout_seconds: 0 });
  assert.deepEqual(r.new_messages.map((m) => m.text), ['hey @Gemini, check the colors', 'direct to Gemini', 'lead says hi', 'human says hi']);
  assert.deepEqual(r.other_messages, { count: 1, between: ['Codex'] });
  assert.ok(b.traffic.saved > 0, 'skipped chatter counts as saved');
  const l = await room.call('wait', lead, { timeout_seconds: 0 });
  assert.ok(l.new_messages.some((m) => m.text === 'general chatter from Codex'));
  // Routine notices (someone is editing a file) never wake anyone, not even the lead.
  assert.ok(!l.new_messages.some((m) => /is editing index.js/.test(m.text)));
  await room.call('set_focus', b, { mode: 'all' });
  await room.call('send', c, { text: 'more chatter' });
  assert.equal((await room.call('wait', b, { timeout_seconds: 0 })).new_messages.at(-1).text, 'more chatter');
  room.close();
});

test('a focus member is not woken by chatter, only by something that concerns it', async () => {
  const { room, members: [lead, b, c] } = await setup('Claude', 'Gemini', 'Codex');
  const started = Date.now();
  const pending = room.call('wait', b, { timeout_seconds: 3 });
  setTimeout(() => room.call('send', c, { text: 'chatter' }), 50);
  setTimeout(() => room.call('send', lead, { text: 'work for everyone' }), 400);
  const r = await pending;
  assert.ok(Date.now() - started >= 350, 'did not wake on chatter');
  assert.equal(r.new_messages.at(-1).text, 'work for everyone');
  room.close();
});

test('wait delivers at most 25 messages at a time and trims long ones', async () => {
  const { room, members: [, b, c] } = await setup('Claude', 'Gemini', 'Codex');
  for (let i = 0; i < 30; i++) await room.call('send', HUMAN, { text: `m${i}` });
  const first = await room.call('wait', b, { timeout_seconds: 0 });
  assert.equal(first.new_messages.length, 25);
  assert.equal(first.queued, 5);
  assert.match(first.guidance, /5 more message\(s\) are queued/);
  const second = await room.call('wait', b, { timeout_seconds: 0 });
  assert.deepEqual(second.new_messages.map((m) => m.text), ['m25', 'm26', 'm27', 'm28', 'm29']);

  // Chatter is trimmed; what matters to you (the human, the lead, direct, @you, your tasks) is not.
  await room.call('set_focus', b, { mode: 'all' });
  const long = 'x'.repeat(3000);
  const { seq } = await room.call('send', c, { text: long });
  await room.call('send', HUMAN, { text: `y${long}` });
  const w = await room.call('wait', b, { timeout_seconds: 0 });
  assert.match(w.new_messages[0].text, /read_message \d+ for the rest/);
  assert.equal(w.new_messages[1].text, `y${long}`);
  assert.equal((await room.call('read_message', b, { seq })).message.text, long);
  room.close();
});

test('oversized text is rejected (not silently cut) and control characters are stripped with a warning', async () => {
  const { room, members: [a] } = await setup('A');
  await assert.rejects(room.call('send', a, { text: 'y'.repeat(20_001) }), /20,001 characters; the limit is 20,000/);
  const r = await room.call('send', a, { text: 'use \u0007ddon_type and\ttabs and C:\\path "quotes" ünïcødé' });
  assert.match(r.warning, /Removed 1 control character/);
  const stored = room.s.messages.at(-1).text;
  assert.equal(stored, 'use ddon_type and\ttabs and C:\\path "quotes" ünïcødé');
  room.close();
});

test('summary: newcomers start from it, and the lead is nudged when the chat gets long', async () => {
  const { room, members: [lead] } = await setup('Claude');
  for (let i = 0; i < 85; i++) await room.call('send', HUMAN, { text: `m${i}` });
  assert.match((await room.call('wait', lead, { timeout_seconds: 0 })).guidance, /write a short summary/);
  await room.call('set_summary', lead, { text: 'Goal: todo app. Done: layout. Left: tests.' });
  const joined = await room.call('join', null, { name: 'Late' });
  assert.match(joined.summary, /Goal: todo app/);
  assert.equal(room.memberByName('Late').cursor, room.s.seq - 10);
  assert.doesNotMatch((await room.call('wait', lead, { timeout_seconds: 0 })).guidance, /write a short summary/);
  room.close();
});

test('presence: listening, working, idle with last contact, then not connected; unread counts', async () => {
  const { room, members: [lead, b] } = await setup('Claude', 'Gemini');
  const status = () => room.snapshot().members.find((m) => m.name === 'Gemini');
  const pending = room.call('wait', b, { timeout_seconds: 2 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(status().status, 'listening');
  await room.call('send', lead, { text: 'go' });
  await pending;
  assert.equal(status().status, 'working');
  b.lastSeen = Date.now() - 6 * 60_000; // thinking for a while without touching the room
  assert.equal(status().status, 'idle');
  b.lastSeen = Date.now() - 31 * 60_000;
  assert.equal(status().status, 'offline');
  await room.call('send', lead, { text: 'are you there?' });
  assert.equal(status().unread, 1);
  room.close();
});

test('usage from local logs is matched to members by app; models from logs win over self-reports', async () => {
  const { room, members: [claude, codex] } = await setup('Claude', 'Codex');
  claude.app = 'Claude Code';
  codex.app = 'Codex app';
  codex.model = 'self-reported-model';
  room.applyUsage([
    { source: 'codex', sessionId: 'c1', model: 'gpt-x-codex', contextPct: 40, limits: { session: { used: 91, minutes: 300 }, weekly: { used: 50, minutes: 10080 } }, updatedAt: Date.now() },
    { source: 'claude-code', sessionId: 'k1', model: 'claude-model', contextPct: 12, updatedAt: Date.now() },
  ]);
  const snap = room.snapshot().members;
  const cx = snap.find((m) => m.name === 'Codex');
  assert.equal(cx.model, 'gpt-x-codex');
  assert.equal(cx.source, 'logs');
  assert.equal(cx.usage.session.used, 91);
  assert.equal(snap.find((m) => m.name === 'Claude').usage.contextPct, 12);
  const st = await room.call('status', claude);
  assert.equal(st.members.find((m) => m.name === 'Codex').usage.session_limit, '91%');
  room.close();
});

test('ask to "auto:<skill>" picks an able, free teammate with usage headroom; several names fan out', async () => {
  const room = new Room({ projectRoot: tmpProject() });
  const join = async (name, capabilities, lead) => room.memberByToken((await room.call('join', null, { name, capabilities, lead })).your_token);
  const lead = await join('Claude', ['terminal'], true);
  const gpt = await join('ChatGPT', ['image-generation', 'web-search']);
  const gem = await join('Gemini', ['image-generation']);
  await join('Codex', ['terminal']);
  gpt._usage = { source: 'codex', limits: { session: { used: 95 } } }; // nearly out
  const r = await room.call('ask', lead, { to: 'auto:image', title: 'Make an icon', kind: 'asset' });
  assert.equal(r.task.assigned_to, 'Gemini');
  await assert.rejects(room.call('ask', lead, { to: 'auto:video-editing', title: 'x' }), /Nobody available can do "video-editing"/);
  const multi = await room.call('ask', lead, { to: 'Gemini, Codex', title: 'Review app.js', kind: 'review' });
  assert.deepEqual(multi.tasks.map((t) => t.assigned_to), ['Gemini', 'Codex']);
  assert.ok(gem);
  room.close();
});

test('ask with wait_seconds returns the result in the same call', async () => {
  const { room, members: [lead, b] } = await setup('Claude', 'Gemini');
  const pending = room.call('ask', lead, { to: 'Gemini', title: 'Quick question', kind: 'question', wait_seconds: 5 });
  await new Promise((r) => setTimeout(r, 50));
  const id = Object.keys(room.s.tasks).at(-1);
  await room.call('finish_task', b, { task_id: id, result: 'Use Inter, 16px.' });
  const r = await pending;
  assert.equal(r.task.status, 'done');
  assert.equal(r.task.result, 'Use Inter, 16px.');
  assert.match(r.note, /Finished/);
  room.close();
});

test('update_me sets avatar, model, focus and activity in one call; bad avatar styles are explained', async () => {
  const { room, members: [, b] } = await setup('Claude', 'Gemini');
  assert.deepEqual(b.avatar, { style: 'bottts', seed: 'Gemini' }, 'everyone gets a default avatar');
  const r = await room.call('update_me', b, { avatar: 'lorelei:sunny', model: 'gemini-2.5-pro', focus: 'all', activity: 'drawing' });
  assert.equal(r.avatar, 'lorelei:sunny');
  const snap = room.snapshot().members.find((m) => m.name === 'Gemini');
  assert.match(snap.avatar, /\/avatar\/gemini\.svg\?v=lorelei%3Asunny/);
  assert.equal(snap.model, 'gemini-2.5-pro');
  assert.equal(snap.listen, 'all');
  assert.equal(snap.activity, 'drawing');
  await assert.rejects(room.call('update_me', b, { avatar: 'unicorn' }), /Unknown avatar style "unicorn"\. Choose one of: bottts/);
  room.close();
});

test('@everyone reaches focus members; a lead near its limit is told to hand over', async () => {
  const { room, members: [lead, b, c] } = await setup('Claude', 'Gemini', 'Codex');
  await room.call('send', c, { text: '@everyone standup in 5' });
  assert.equal((await room.call('wait', b, { timeout_seconds: 0 })).new_messages.at(-1).text, '@everyone standup in 5');
  lead._usage = { source: 'claude-code', limits: { session: { used: 92 } } };
  await room.call('send', HUMAN, { text: 'status?' });
  assert.match((await room.call('wait', lead, { timeout_seconds: 0 })).guidance, /92% of a usage limit: update the summary .* hand the lead/);
  c._usage = { source: 'codex', limits: { weekly: { used: 90 } } };
  lead._usage = null;
  await room.call('send', HUMAN, { text: 'next?' });
  assert.match((await room.call('wait', lead, { timeout_seconds: 0 })).guidance, /Codex is near a usage limit/);
  room.close();
});

test('the lead can pause, stop and resume one member; a paused member cannot change anything', async () => {
  const { room, members: [lead, b, c] } = await setup('Claude', 'Gemini', 'Codex');
  await room.call('ask', lead, { to: 'Codex', title: 'Write tests', files: ['index.js'] });
  await room.call('claim_file', c, { path: 'index.js' });
  await assert.rejects(room.call('control_member', b, { name: 'Codex', action: 'pause' }), /Only the lead or the human/);

  await room.call('control_member', lead, { name: 'Gemini', action: 'pause', reason: 'wrong direction' });
  await assert.rejects(room.call('write_file', b, { path: 'a.txt', content: 'x' }), /You are paused by Claude \(wrong direction\)/);
  await room.call('send', b, { text: 'ok, pausing' }); // can still talk
  const w = await room.call('wait', b, { timeout_seconds: 0 });
  assert.ok(w.new_messages.some((m) => /PAUSED you: wrong direction/.test(m.text)));
  assert.match(w.guidance, /You are PAUSED by Claude/);
  assert.equal(room.snapshot().members.find((m) => m.name === 'Gemini').paused.by, 'Claude');
  await room.call('control_member', HUMAN, { name: 'Gemini', action: 'resume' });
  await room.call('write_file', b, { path: 'a.txt', content: 'x' });

  const stop = await room.call('control_member', lead, { name: 'Codex', action: 'stop', reason: 'tests are wrong' });
  assert.deepEqual(stop.reopened_tasks, ['T1']);
  assert.equal(room.s.tasks.T1.status, 'open');
  assert.equal(room.s.claims['index.js'], undefined);
  await assert.rejects(room.call('take_task', c, { task_id: 'T1' }), /You are paused/);
  room.close();
});

test('memory: remember facts, recall only the best matches, private entries stay private', async () => {
  const { room, members: [lead, b] } = await setup('Claude', 'Gemini');
  await room.call('remember', lead, { text: 'Tests use node:test, run with npm test', tags: ['testing'] });
  await room.call('remember', lead, { text: 'Brand color is #3b6fd8', kind: 'decision' });
  await room.call('remember', b, { text: 'The deploy key lives in 1Password vault Crew', tags: ['deploy'] });
  await room.call('remember', b, { text: 'I prefer Inter for UI text', kind: 'preference', private: true });
  for (let i = 0; i < 20; i++) await room.call('remember', lead, { text: `filler fact number ${i} about nothing` });

  const r = await room.call('recall', b, { query: 'how do I run the tests' });
  assert.equal(r.memories[0].text, 'Tests use node:test, run with npm test');
  assert.ok(r.memories.length <= 5);
  assert.equal((await room.call('recall', b, { query: 'brand color' })).memories[0].kind, 'decision');
  assert.equal((await room.call('recall', lead, { query: 'Inter font' })).memories.length, 0, 'private memory hidden from others');
  assert.equal((await room.call('recall', b, { query: 'Inter' })).memories[0].private, true);
  assert.equal((await room.call('recall', b, { tags: 'deploy' })).memories.length, 1);
  const id = (await room.call('recall', b, { query: 'deploy key' })).memories[0].id;
  await assert.rejects(room.call('forget', HUMAN, { id: 'M999' }), /No memory/);
  await room.call('forget', b, { id });
  assert.equal((await room.call('recall', b, { query: 'deploy key' })).memories.length, 0);
  assert.match((await room.call('join', null, { name: 'Late' })).memory, /shared memories: use recall/);
  room.close();
});

test('a quiet wait is one short line; after a few empty checks the AI is told to rest', async () => {
  const { room, members: [, gpt] } = await setup('Claude', 'ChatGPT');
  let r;
  for (let i = 0; i < 3; i++) r = await room.call('wait', gpt, { timeout_seconds: 0 });
  assert.equal(r.quiet, true);
  assert.match(formatWait(r), /^nothing new\. next: /);
  assert.doesNotMatch(formatWait(r), /\n/);
  assert.match(r.guidance, /crewroom wait --as ChatGPT --timeout 3600` in the project folder as a background command, then end your turn/);
  assert.deepEqual(gpt.stats, { checks: 4, empty: 3 }); // the first check (in setup) had the join news
  // Anything that concerns it resets the streak.
  await room.call('send', room.memberByName('Claude'), { text: '@ChatGPT review app.js please' });
  r = await room.call('wait', gpt, { timeout_seconds: 0 });
  assert.equal(r.quiet, undefined);
  assert.equal(gpt._empty, 0);
  // A long wait split into back-to-back calls (CLI, bridge) counts as one check.
  for (let i = 0; i < 3; i++) await room.call('wait', gpt, { timeout_seconds: 0.05 });
  assert.equal(gpt.stats.checks, 6);
});

test('a cancelled wait keeps messages unread for the next one', async () => {
  const { room, members: [claude, gpt] } = await setup('Claude', 'ChatGPT');
  const ac = new AbortController();
  const pending = room.call('wait', gpt, { timeout_seconds: 30, signal: ac.signal });
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(pending, /cancelled/);
  await room.call('send', claude, { text: '@ChatGPT are you there?' });
  const r = await room.call('wait', gpt, { timeout_seconds: 0 });
  assert.equal(r.new_messages.length, 1);
  // A signal that is not a real AbortSignal (e.g. from JSON) is ignored.
  assert.equal((await room.call('wait', gpt, { timeout_seconds: 0, signal: {} })).quiet, true);
});

test('new chapter: archives the chat, keeps what is still unread for someone, and members resume with a checkpoint', async () => {
  const { room, members: [claude, gpt, gemini] } = await setup('Claude', 'ChatGPT', 'Gemini');
  for (let i = 0; i < 5; i++) await room.call('send', claude, { text: `progress note ${i}` });
  await room.call('send', claude, { text: '@Gemini make the icon' });
  for (const m of [claude, gpt]) await room.call('wait', m, { timeout_seconds: 0 });
  await assert.rejects(room.call('new_chapter', gpt, { summary: 'x' }), /Only the lead/);
  await assert.rejects(room.call('new_chapter', claude, {}), /summary/);
  await room.call('update_me', gpt, { checkpoint: 'Reviewing app.js; next: storage tests' });
  await room.call('ask', claude, { to: 'ChatGPT', title: 'Review app.js' });
  await room.call('wait', gpt, { timeout_seconds: 0 });

  const r = await room.call('new_chapter', claude, { summary: 'Goal: todo app. Gemini: icon. ChatGPT: review.' });
  assert.equal(r.chapter, 2);
  assert.equal(room.snapshot().chapter, 2);
  // Gemini has not read its request yet: it survives the reset; the progress notes do not.
  const texts = room.s.messages.map((m) => m.text);
  assert.ok(texts.includes('@Gemini make the icon'));
  assert.ok(!texts.some((t) => t.startsWith('progress note')));
  assert.match(room.chapterText(1), /progress note 4/);
  assert.match(room.chapterText(1), /Summary at the end:\nGoal: todo app/);
  assert.throws(() => room.chapterText('../x'), /No such chapter/);
  assert.deepEqual((await room.call('chapters', claude)).archived, [1]);
  const forGemini = await room.call('wait', gemini, { timeout_seconds: 0 });
  assert.ok(forGemini.new_messages.some((m) => m.text === '@Gemini make the icon'));
  assert.ok(forGemini.new_messages.some((m) => /Chapter 2 started/.test(m.text)));

  // ChatGPT continues in a fresh conversation: its token brings back what it needs.
  const back = await room.call('join', null, { token: gpt.token, name: 'whatever' });
  assert.equal(back.your_checkpoint, 'Reviewing app.js; next: storage tests');
  assert.equal(back.your_tasks[0].title, 'Review app.js');
  assert.match(back.summary, /Goal: todo app/);
  assert.match(back.next_step, /You are back/);
});

test('fresh-chat prompt carries the member token; checkpoint can be cleared', async () => {
  const { room, members: [, gpt] } = await setup('Claude', 'ChatGPT');
  const { invitePrompt } = await import('../src/invite.js');
  const p = invitePrompt(room, { links: { invite: 'http://x/join' }, member: gpt });
  assert.match(p, new RegExp(`call join_room with token "${gpt.token}"`));
  assert.match(p, /You are: ChatGPT/);
  await room.call('update_me', gpt, { checkpoint: 'something' });
  assert.equal((await room.call('update_me', gpt, { checkpoint: '' })).checkpoint, 'cleared');
  assert.equal(gpt.checkpoint, undefined);
});

test('seen: a message counts as seen only once it was delivered to that AI', async () => {
  const { room, members: [claude, gpt, gemini] } = await setup('Claude', 'ChatGPT', 'Gemini');
  await room.call('send', gpt, { text: 'chatter between members' });
  await room.call('send', claude, { text: '@Gemini please make the icon' });
  const seenOf = (text) => room.dashboardMessages().find((m) => m.text === text).seenBy;
  assert.equal(seenOf('@Gemini please make the icon'), undefined);
  await room.call('wait', gemini, { timeout_seconds: 0 });
  // Gemini (focus) got the @mention; the chatter only arrived as a count.
  assert.deepEqual(seenOf('@Gemini please make the icon'), ['Gemini']);
  assert.equal(seenOf('chatter between members'), undefined);
  await room.call('wait', claude, { timeout_seconds: 0 }); // the lead gets everything
  assert.deepEqual(seenOf('chatter between members'), ['Claude']);
  await room.call('read_messages', gemini, {});
  assert.deepEqual(seenOf('chatter between members'), ['Claude', 'Gemini']);
  // Senders don't "see" their own messages, and the AIs never get the list.
  assert.deepEqual(seenOf('@Gemini please make the icon'), ['Gemini']);
  assert.equal((await room.call('read_message', gpt, { seq: room.s.seq })).message.seenBy, undefined);
});

test('the human has a name; room rules reach every AI, and @Name lines only that AI', async () => {
  const { room, members: [claude, gpt, gemini] } = await setup('Claude', 'ChatGPT', 'Gemini');
  await room.call('update_settings', HUMAN, { humanName: 'Lucian', rules: 'Never push to main.\n- @Gemini images are 1024px PNG\n@lead review every change' });
  assert.equal(room._nameOf('human'), 'Lucian');
  await assert.rejects(room.call('join', null, { name: 'Lucian' }), /reserved/);
  await room.call('send', gpt, { text: 'question for you', to: 'Lucian' });
  assert.equal(room.s.messages.at(-1).to, 'human');
  const forGemini = await room.call('wait', gemini, { timeout_seconds: 0 });
  const rulesMsg = forGemini.new_messages.find((m) => /updated the room rules/.test(m.text));
  assert.match(rulesMsg.text, /Never push to main\.\n- images are 1024px PNG|Never push to main\.\n- @Gemini images are 1024px PNG/);
  assert.doesNotMatch(rulesMsg.text, /review every change/);
  assert.deepEqual(room._rulesFor(claude), ['Never push to main.', '@lead review every change']);
  assert.deepEqual(room._rulesFor(gpt), ['Never push to main.']);
  const back = await room.call('join', null, { token: gemini.token });
  assert.deepEqual(back.room_rules, ['Never push to main.', '@Gemini images are 1024px PNG']);
  assert.match(back.human, /^Lucian/);
});

test('reactions: free acknowledgements that ride along with the next real update', async () => {
  const { room, members: [claude, gpt] } = await setup('Claude', 'ChatGPT');
  await room.call('send', claude, { text: '@ChatGPT please review app.js' });
  const seq = room.s.seq;
  await room.call('react', gpt, { seq, emoji: '👍' });
  await assert.rejects(room.call('react', gpt, { seq, emoji: 'ok' }), /one emoji/);
  assert.deepEqual(room.dashboardMessages().find((m) => m.seq === seq).reactions, { '👍': ['ChatGPT'] });
  // Claude is not woken for a reaction...
  const quiet = await room.call('wait', claude, { timeout_seconds: 0 });
  assert.equal(quiet.quiet, true);
  assert.equal(quiet.reactions, undefined);
  // ...it hears about it with its next real update.
  await room.call('send', gpt, { text: '@Claude done' });
  const r = await room.call('wait', claude, { timeout_seconds: 0 });
  assert.deepEqual(r.reactions, [`#${seq} 👍 ChatGPT`]);
  assert.match(formatWait(r), /reactions to your messages: #\d+ 👍 ChatGPT/);
  await room.call('react', gpt, { seq, emoji: '👍' }); // again = undo
  assert.equal(room.dashboardMessages().find((m) => m.seq === seq).reactions, undefined);
});

test('taking a task reserves its files; others see who does what; finishing frees them', async () => {
  const { room, members: [claude, gpt, gemini] } = await setup('Claude', 'ChatGPT', 'Gemini');
  const { task } = await room.call('ask', claude, { to: 'ChatGPT', title: 'Fix the parser', files: ['index.js'] });
  const took = await room.call('take_task', gpt, { task_id: task.id });
  assert.deepEqual(took.reserved_files, ['index.js']);
  await assert.rejects(room.call('claim_file', gemini, { path: 'index.js' }), /being edited by ChatGPT/);
  await room.call('send', claude, { text: '@Gemini what about the icon?' });
  const r = await room.call('wait', gemini, { timeout_seconds: 0 });
  assert.match(r.team_now, /ChatGPT: T\d+ Fix the parser; editing index\.js/);
  assert.match(formatWait(r), /team now: ChatGPT:/);
  // Unchanged: not repeated.
  await room.call('send', claude, { text: '@Gemini and the colors?' });
  assert.equal((await room.call('wait', gemini, { timeout_seconds: 0 })).team_now, undefined);
  await room.call('finish_task', gpt, { task_id: task.id, result: 'fixed' });
  assert.equal(room.s.claims['index.js'], undefined);
});

test('memory stays tidy: duplicates merge, files import as memories, entries can be edited', async () => {
  const { room, members: [claude, gpt] } = await setup('Claude', 'ChatGPT');
  const a = await room.call('remember', claude, { text: 'The API server runs on port 8080 in development' });
  assert.equal((await room.call('remember', gpt, { text: 'the API server runs on port 8080 in development!' })).saved, a.saved);
  const upd = await room.call('remember', gpt, { text: 'The API server runs on port 8080 in local development' });
  assert.equal(upd.updated, a.saved);
  assert.equal(room.s.memory.length, 1);
  const r = await room.call('import_memory', claude, { text: '---\nname: notes\n---\n# Database\n- We use Postgres 16 with Prisma migrations\n- Never edit generated prisma client code\n# Style\n1. Components live in src/components by feature\nok\n- The API server runs on port 8080 in development' });
  assert.deepEqual(r, { added: 3, merged: 1, skipped: 1 });
  const db = room.s.memory.find((e) => /Postgres/.test(e.text));
  assert.deepEqual(db.tags, ['imported', 'database']);
  assert.equal((await room.call('recall', gpt, { query: 'prisma' })).memories.length, 2);
  await room.call('edit_memory', HUMAN, { id: db.id, text: 'We use Postgres 17 with Prisma migrations', kind: 'decision' });
  assert.equal(db.kind, 'decision');
  await assert.rejects(room.call('edit_memory', gpt, { id: db.id, text: 'x y z w' }), /Only its author/);
});

test('project knowledge files are pointed out to everyone who joins', async () => {
  const { room, members: [claude] } = await setup('Claude');
  await assert.rejects(room.call('set_knowledge', claude, { files: ['missing.md'] }), /Not found/);
  await room.call('set_knowledge', claude, { files: ['index.js'] });
  const j = await room.call('join', null, { name: 'Newbie' });
  assert.match(j.project_knowledge, /index\.js/);
});

const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); assert.ok(fn(), 'condition not reached'); };

test('a task check runs on finish: pass = result with diff to the asker, fail = back to the doer with the output', async () => {
  const { room, members: [claude, gpt] } = await setup('Claude', 'ChatGPT');
  room.s.settings.commands = 'auto';
  const fsx = await import('node:fs');
  const file = path.join(room.projectRoot, 'index.js');
  const node = JSON.stringify(process.execPath);
  const check = `${node} -e "process.exit(require('fs').readFileSync('index.js','utf8').includes('fixed') ? 0 : 1)"`;
  const { task } = await room.call('ask', claude, { to: 'ChatGPT', title: 'Fix index.js', files: ['index.js'], done_when: 'index.js says fixed', check });
  await room.call('take_task', gpt, { task_id: task.id });
  // First attempt: forgot the fix -> the check fails and the task comes back.
  const r1 = await room.call('finish_task', gpt, { task_id: task.id, result: 'done!' });
  assert.match(r1.note, /Running the check/);
  await until(() => room.s.tasks[task.id].status === 'assigned');
  const back = await room.call('wait', gpt, { timeout_seconds: 0 });
  assert.ok(back.new_messages.some((m) => /check failed/.test(m.text)));
  assert.equal(room.s.claims['index.js'].memberId, gpt.id); // files reserved again
  // Second attempt: fixed -> passes, the asker gets the result with what changed.
  fsx.writeFileSync(file, 'console.log("fixed");\n');
  await room.call('finish_task', gpt, { task_id: task.id, result: 'really done' });
  await until(() => room.s.tasks[task.id].status === 'done');
  const forClaude = await room.call('wait', claude, { timeout_seconds: 0 });
  const result = forClaude.new_messages.find((m) => m.kind === 'result');
  assert.match(result.text, /Changed: index\.js \(\+1 −1\)/);
  assert.match(result.text, /✓ Check passed/);
  assert.match((await room.call('task_diff', claude, { task_id: task.id })).diff, /\+console\.log\("fixed"\);/);
  const rank = room._rankOf(gpt);
  assert.equal(rank.passed, 1);
  assert.equal(rank.failed, 1);
});

test('a check needs the human unless its command is an approved toolbox tool', async () => {
  const { room, members: [claude, gpt] } = await setup('Claude', 'ChatGPT');
  const ok = `${JSON.stringify(process.execPath)} -e "process.exit(0)"`;
  await room.call('toolbox', gpt, { action: 'add', name: 'ok', command: ok, description: 'always passes' });
  assert.equal(room.s.toolbox.ok.approved, undefined);
  const { task } = await room.call('ask', claude, { to: 'ChatGPT', title: 'Something', check: 'ok' });
  await room.call('take_task', gpt, { task_id: task.id });
  await room.call('finish_task', gpt, { task_id: task.id, result: 'x' });
  await until(() => room.s.tasks[task.id].checkResult?.status === 'waiting for approval');
  await room.call('approve_command', HUMAN, { command_id: room.s.tasks[task.id].checkResult.commandId, approve: true });
  await until(() => room.s.tasks[task.id].status === 'done');
  // Approved once in the toolbox: runs without asking from then on.
  await room.call('approve_tool', HUMAN, { name: 'ok' });
  const t2 = (await room.call('ask', claude, { to: 'ChatGPT', title: 'Another', check: 'ok' })).task;
  await room.call('take_task', gpt, { task_id: t2.id });
  await room.call('finish_task', gpt, { task_id: t2.id, result: 'y' });
  await until(() => room.s.tasks[t2.id].status === 'done');
  assert.equal(room.s.tasks[t2.id].checkResult.status, 'passed');
  assert.match((await room.call('toolbox', claude, { action: 'list' })).tools[0].command, /process\.exit\(0\)/);
});

test('reviews: approve with stars or send back; ranks follow the track record and can be set by the lead', async () => {
  const { room, members: [claude, gpt, gemini] } = await setup('Claude', 'ChatGPT', 'Gemini');
  const finish = async (who, title) => {
    const { task } = await room.call('ask', claude, { to: who.name, title });
    await room.call('take_task', who, { task_id: task.id });
    await room.call('finish_task', who, { task_id: task.id, result: 'ok' });
    return task.id;
  };
  const t1 = await finish(gpt, 'One');
  await assert.rejects(room.call('review_task', gpt, { task_id: t1, verdict: 'approve' }), /own task/);
  await room.call('review_task', claude, { task_id: t1, verdict: 'changes', note: 'Missing tests' });
  assert.equal(room.s.tasks[t1].status, 'assigned');
  const msgs = (await room.call('wait', gpt, { timeout_seconds: 0 })).new_messages;
  assert.ok(msgs.some((m) => /changes requested.*\n.*Missing tests/s.test(m.text)));
  await room.call('finish_task', gpt, { task_id: t1, result: 'with tests' });
  await room.call('review_task', claude, { task_id: t1, verdict: 'approve', rating: 5 });
  for (const n of ['Two', 'Three', 'Four', 'Five']) await room.call('review_task', claude, { task_id: await finish(gpt, n), verdict: 'approve', rating: 5 });
  assert.equal(room._rankOf(gpt).title, 'Senior');
  // It knows: the change rides along with its next real update.
  await room.call('send', claude, { text: '@ChatGPT great work' });
  const upd = await room.call('wait', gpt, { timeout_seconds: 0 });
  assert.ok(upd.notes.some((n) => /Your rank is now Senior \(was Mid\)/.test(n)));
  assert.match(formatWait(upd), /🏅 Your rank is now Senior/);
  assert.match((await room.call('join', null, { token: gemini.token })).your_rank, /^New\. Everyone is ranked by results/);
  assert.equal(room._rankOf(gemini).title, 'New');
  await room.call('set_rank', claude, { name: 'Gemini', rank: 'mid' });
  assert.deepEqual([room._rankOf(gemini).title, room._rankOf(gemini).manual], ['Mid', true]);
  // auto routing: hard work goes to the senior, easy work to the lower rank.
  assert.equal((await room.call('ask', claude, { to: 'auto', title: 'Hard one', difficulty: 'hard' })).task.assigned_to, 'ChatGPT');
  const easy = await room.call('ask', claude, { to: 'auto', title: 'Easy one', difficulty: 'easy' });
  assert.equal(easy.task.assigned_to, 'Gemini');
  // A thin task for a junior: the lead is told to spell it out.
  await room.call('set_rank', claude, { name: 'Gemini', rank: 'junior' });
  const thin = await room.call('ask', claude, { to: 'Gemini', title: 'Fix the footer' });
  assert.match(thin.coaching, /Gemini is Junior: give step-by-step instructions/);
  assert.match(room.s.messages.at(-1).text, /ask before guessing/);
  // The ledger remembers who did what.
  const log = await room.call('team_log', claude, { about: 'ChatGPT' });
  assert.ok(log.entries.some((e) => /ChatGPT: finished T\d+: One/.test(e)));
  assert.ok((await room.call('team_log', claude, { about: t1 })).entries.some((e) => /Claude: asked for changes on/.test(e)));
});

test('context warnings ride along once: from app logs, or after many checks in one conversation', async () => {
  const { room, members: [claude, gpt] } = await setup('Claude', 'ChatGPT');
  await room.call('update_settings', HUMAN, { humanName: 'Lucian' });
  await room.call('update_me', gpt, { context_used_percent: 80 });
  await room.call('send', claude, { text: '@ChatGPT next step' });
  const r = await room.call('wait', gpt, { timeout_seconds: 0 });
  assert.match(r.context_warning, /80% full: save a checkpoint.*ask Lucian to run \/compact or open a fresh chat/);
  await room.call('send', claude, { text: '@ChatGPT and another' });
  assert.equal((await room.call('wait', gpt, { timeout_seconds: 0 })).context_warning, undefined);
});

test('a burst of messages arrives in one call; routine notices wake nobody', async () => {
  const { room, members: [claude, gpt, gemini] } = await setup('Claude', 'ChatGPT', 'Gemini');
  const pending = room.call('wait', claude, { timeout_seconds: 10 });
  await new Promise((r) => setTimeout(r, 50));
  await room.call('send', gpt, { text: 'one' });
  await new Promise((r) => setTimeout(r, 100));
  await room.call('send', gemini, { text: 'two' });
  await room.call('join', null, { token: gpt.token }); // "reconnected": quiet
  const r = await pending;
  assert.deepEqual(r.new_messages.map((m) => m.text), ['one', 'two']);
});

test('claims: several files and globs at once, a list, and release by glob', async () => {
  const { room, members: [claude, gpt] } = await setup('Claude', 'ChatGPT');
  for (const l of ['en', 'fr', 'de']) {
    fs.mkdirSync(path.join(room.projectRoot, 'locale', l), { recursive: true });
    fs.writeFileSync(path.join(room.projectRoot, 'locale', l, 'quest.txt'), 'x');
  }
  await room.call('claim_file', claude, { path: 'locale/fr/quest.txt' });
  const r = await room.call('claim_file', gpt, { paths: ['locale/*/quest.txt', 'index.js'] });
  assert.deepEqual(r.claimed.sort(), ['index.js', 'locale/de/quest.txt', 'locale/en/quest.txt']);
  assert.deepEqual(r.busy, ['locale/fr/quest.txt (Claude)']);
  assert.equal((await room.call('claim_file', gpt, {})).claims.length, 4);
  assert.equal((await room.call('release_file', gpt, { path: 'locale/**' })).released.length, 2);
});

test('manual check, my work now, unread on rejoin, delete and merge', async () => {
  const { room, members: [claude, gpt] } = await setup('Claude', 'ChatGPT');
  const { task } = await room.call('ask', claude, { to: 'ChatGPT', title: 'Deploy to the VPS', check: 'manual' });
  assert.match(room.s.messages.at(-1).text, /Claude verifies it by hand/);
  await room.call('take_task', gpt, { task_id: task.id });
  const f = await room.call('finish_task', gpt, { task_id: task.id, result: 'deployed' });
  assert.match(f.note, /verifies this one by hand/);
  assert.equal(room.s.tasks[task.id].checkResult.status, 'manual');
  assert.match((await room.call('wait', claude, { timeout_seconds: 0 })).new_messages.at(-1).text, /Needs manual verification/);

  await room.call('send', HUMAN, { text: 'Everyone pause please' });
  const now = await room.call('my_work', gpt);
  assert.match(now.latest_from_human, /Everyone pause please/);
  assert.match(now.paused, /formal pause is off/);
  assert.match(now.unread_for_you, /unread/);
  const back = await room.call('join', null, { token: gpt.token });
  assert.ok(back.unread_preview.some((x) => /Everyone pause please/.test(x)));
  assert.equal(back.latest_seq, room.s.seq);

  const { seq } = await room.call('send', gpt, { text: 'oops wrong room' });
  await assert.rejects(room.call('delete_message', claude, { seq }), /only delete your own/);
  await room.call('delete_message', gpt, { seq });
  assert.equal(room.dashboardMessages().find((m) => m.seq === seq).deleted, true);
  assert.ok(!(await room.call('wait', claude, { timeout_seconds: 0 })).new_messages.some((m) => m.seq === seq));

  const dup = room.memberByToken((await room.call('join', null, { name: 'ChatGPT 2' })).your_token);
  await room.call('claim_file', dup, { path: 'index.js' });
  await room.call('merge_member', HUMAN, { from: 'ChatGPT 2', into: 'ChatGPT' });
  assert.equal(room.memberByName('ChatGPT 2'), null);
  assert.equal(room.s.claims['index.js'].memberId, gpt.id);
});

test('share_file reads outside the project only for local apps', async () => {
  const { room, members: [claude] } = await setup('Claude');
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crewroom-o-')), 'syserr.txt');
  fs.writeFileSync(outside, 'boom');
  await assert.rejects(room.call('share_file', claude, { path: outside }), /outside|project/i);
  const r = await room.call('share_file', claude, { path: outside, allowOutside: true, message: false });
  assert.equal(r.asset.name, 'syserr.txt');
});

test('apps that can wait in the background are told to, right away and after finishing a task', async () => {
  const room = new Room({ projectRoot: tmpProject() });
  const lead = room.memberByToken((await room.call('join', null, { name: 'Claude', via: 'mcp (local)', lead: true })).your_token);
  const j = await room.call('join', null, { name: 'Gemini', via: 'mcp (local)', client: { name: 'antigravity' } });
  assert.match(j.how_to_wait, /crewroom wait --as Gemini --timeout 3600/);
  const gem = room.memberByToken(j.your_token);
  await room.call('wait', gem, { timeout_seconds: 0 });
  const quiet = await room.call('wait', gem, { timeout_seconds: 0 });
  assert.match(quiet.guidance, /^Nothing for you right now\. Wait for free/);
  const { task } = await room.call('ask', lead, { to: 'Gemini', title: 'Draw it' });
  await room.call('take_task', gem, { task_id: task.id });
  assert.match((await room.call('finish_task', gem, { task_id: task.id, result: 'drawn' })).next, /wait for free/);
  // An app that cannot (no terminal) is not told to.
  const web = room.memberByToken((await room.call('join', null, { name: 'Web', via: 'mcp (public link)', client: { name: 'perplexity' } })).your_token);
  await room.call('wait', web, { timeout_seconds: 0 });
  assert.doesNotMatch((await room.call('wait', web, { timeout_seconds: 0 })).guidance, /background/);
  room.close();
});
