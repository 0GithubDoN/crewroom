import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Hub } from '../src/hub.js';
import { HUMAN } from '../src/room.js';
import { newer, installKind } from '../src/update.js';

process.env.CREWROOM_NO_UPDATE_CHECK = '1'; // no network in tests

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

let hub;
let room;
let project;
let imageServer;
let imageUrl;

before(async () => {
  project = tmp('crewroom-p-');
  fs.writeFileSync(path.join(project, 'index.js'), 'console.log("hello");\n');
  fs.writeFileSync(path.join(project, 'logo.png'), PNG);
  hub = new Hub({ home: tmp('crewroom-h-'), port: 0, quiet: true });
  await hub.start();
  room = hub.openRoom(project, { name: 'Test Project' });
  imageServer = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); });
  await new Promise((r) => imageServer.listen(0, '127.0.0.1', r));
  imageUrl = `http://127.0.0.1:${imageServer.address().port}/generated.png`;
});

after(async () => {
  await hub.stop();
  imageServer.close();
});

async function mcpClient(url) {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const call = async (name, args = {}, { ok = true } = {}) => {
    const r = await client.callTool({ name, arguments: args });
    if (ok) assert.ok(!r.isError, r.content?.[0]?.text);
    return r;
  };
  return { client, call, json: (r) => JSON.parse(r.content[0].text) };
}

test('invite page, dashboard key, host check, hub API key', async () => {
  const base = `${hub.localBase}/r/${room.code}`;
  const invite = await (await fetch(`${base}/join`)).text();
  assert.match(invite, /CREWROOM INVITE/);
  assert.match(invite, new RegExp(room.code));
  assert.equal((await fetch(`${base}/dashboard`)).status, 403);
  assert.equal((await fetch(`${base}/dashboard?key=${room.adminKey}`)).status, 200);
  assert.equal((await fetch(`${hub.localBase}/r/AAAA-BBBB-CCCC/join`)).status, 404);
  // Lower-case code without dashes still works.
  assert.equal((await fetch(`${hub.localBase}/r/${room.code.replace(/-/g, '').toLowerCase()}/join`)).status, 200);
  assert.equal((await fetch(`${hub.localBase}/hub/rooms`)).status, 403);
  // DNS rebinding protection: a foreign Host header is refused.
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: hub.port, path: `/r/${room.code}/join`, headers: { host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(status, 403);
});

test('REST: join, send, wait, and the human through the admin key', async () => {
  const api = (action, body, headers = {}) => fetch(`${hub.localBase}/r/${room.code}/api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const j = await (await api('join', { name: 'Codex', app: 'Codex', capabilities: 'terminal,code-execution' })).json();
  assert.ok(j.your_token);
  const auth = { authorization: `Bearer ${j.your_token}` };
  await api('wait', { timeout_seconds: 0 }, auth);
  assert.equal((await api('send', { text: 'hello from the human' }, { 'x-admin-key': room.adminKey })).status, 200);
  const w = await (await api('wait', { timeout_seconds: 1 }, auth)).json();
  assert.equal(w.new_messages.at(-1).from, 'Human');
  assert.equal((await api('send', { text: 'x' })).status, 401);
  assert.equal((await api('send', { text: 'x' }, { 'x-admin-key': 'wrong' })).status, 403);
});

test('global MCP: join with an invite code, chat, edit files, view images', async () => {
  const { client, call, json } = await mcpClient(`${hub.localBase}/mcp`);
  const { tools } = await client.listTools();
  assert.ok(tools.length <= 25, `tool list stays small (${tools.length})`);
  assert.ok(JSON.stringify(tools).length < 14_000, 'tool definitions stay cheap in tokens');
  for (const name of ['join_room', 'wait_for_updates', 'ask_member', 'update_task', 'update_me', 'read_file', 'edit_file', 'share_file', 'get_asset', 'run_command', 'project_changes', 'lead_action']) {
    assert.ok(tools.some((t) => t.name === name), `missing tool ${name}`);
  }
  const share = tools.find((t) => t.name === 'share_file');
  assert.deepEqual(share._meta?.['openai/fileParams'], ['file']);
  assert.equal(tools.find((t) => t.name === 'read_file').annotations.readOnlyHint, true);

  const joined = json(await call('join_room', { invite: `http://127.0.0.1:7777/r/${room.code}/join`, name: 'ChatGPT', app: 'ChatGPT desktop', capabilities: ['image-generation'] }));
  assert.equal(joined.role, 'member');
  await call('send_message', { text: 'hi team' });
  const file = json(await call('read_file', { path: 'index.js' }));
  assert.match(file.content, /console\.log/);
  await call('claim_file', { path: 'index.js' });
  await call('edit_file', { path: 'index.js', old_text: 'console.log', new_text: 'console.info' });
  await call('claim_file', { path: 'index.js', release: true });
  assert.match(fs.readFileSync(path.join(project, 'index.js'), 'utf8'), /console\.info/);
  const img = await call('read_file', { path: 'logo.png' });
  assert.equal(img.content[0].type, 'image');
  const status = json(await call('room_status'));
  assert.ok(status.members.some((m) => m.name === 'ChatGPT'));
  await client.close();
});

test('ChatGPT-style file param: download_url is fetched; a bare sandbox path explains what to do', async () => {
  const { client, call, json } = await mcpClient(`${hub.localBase}/r/${room.code}/mcp`);
  await call('join_room', { name: 'GPT2', app: 'ChatGPT' });

  process.env.CREWROOM_ALLOW_PRIVATE_FETCH = '1';
  try {
    const shared = json(await call('share_file', { file: { download_url: imageUrl, file_id: 'file_123', mime_type: 'image/png', file_name: 'icon.png' }, message: 'icon v1' }));
    assert.equal(shared.asset.name, 'icon.png');
    const seen = await call('get_asset', { asset_id: shared.asset.id });
    assert.equal(seen.content[0].type, 'image');
    assert.equal(seen.content[0].mimeType, 'image/png');
  } finally {
    delete process.env.CREWROOM_ALLOW_PRIVATE_FETCH;
  }

  const bare = await call('share_file', { file: '/mnt/data/image.png' }, { ok: false });
  assert.ok(bare.isError);
  assert.match(bare.content[0].text, /drag the file onto the Crewroom dashboard/);

  // Private network URLs are refused by default.
  const priv = await call('share_file', { url: imageUrl }, { ok: false });
  assert.match(priv.content[0].text, /local\/private network/);
  await client.close();
});

test('a lost MCP session can continue with the token', async () => {
  const a = await mcpClient(`${hub.localBase}/mcp`);
  const joined = a.json(await a.call('join_room', { invite: room.code, name: 'Gemini', app: 'Antigravity' }));
  await a.client.close();
  const b = await mcpClient(`${hub.localBase}/mcp`);
  const denied = await b.call('room_status', {}, { ok: false });
  assert.match(denied.content[0].text, /Not joined/);
  const back = b.json(await b.call('join_room', { token: joined.your_token, name: 'ignored' }));
  assert.equal(back.your_token, joined.your_token);
  const st = b.json(await b.call('room_status', {}));
  assert.equal(st.you, 'Gemini');
  await b.client.close();
});

test('public link: hub reports public URLs, accepts the public host, refuses hub admin from outside', { skip: process.platform === 'win32' }, async () => {
  const fake = path.join(tmp('crewroom-cf-'), 'cloudflared');
  fs.writeFileSync(fake, '#!/usr/bin/env node\nconsole.error("INF |  https://test-words-here.trycloudflare.com  |");\nsetInterval(() => {}, 1000);\n', { mode: 0o755 });
  process.env.CREWROOM_CLOUDFLARED = fake;
  try {
    await hub.setTunnel(true);
    const links = hub.links(room);
    assert.equal(links.public_mcp, `https://test-words-here.trycloudflare.com/r/${room.code}/mcp`);
    const viaTunnel = (p, extra = {}) => new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: hub.port, path: p, headers: { host: 'test-words-here.trycloudflare.com', 'cf-connecting-ip': '203.0.113.9', ...extra } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
    });
    const inv = await viaTunnel(`/r/${room.code}/join`);
    assert.equal(inv.status, 200);
    assert.match(inv.body, /test-words-here\.trycloudflare\.com\/r\//);
    assert.equal((await viaTunnel('/hub/rooms', { 'x-hub-key': hub.key })).status, 403);
    assert.doesNotMatch((await viaTunnel('/')).body, /Open rooms/);
    for (let i = 0; i < 31; i++) await viaTunnel('/r/ZZZZ-ZZZZ-ZZZZ/join');
    assert.equal((await viaTunnel('/r/ZZZZ-ZZZZ-ZZZZ/join')).status, 429);
  } finally {
    delete process.env.CREWROOM_CLOUDFLARED;
    await hub.setTunnel(false);
  }
  assert.equal(hub.links(room).public_mcp, null);
});

test('single open room is auto-selected for local clients without an invite', async () => {
  const { client, call, json } = await mcpClient(`${hub.localBase}/mcp`);
  const r = json(await call('join_room', { name: 'Cursor', app: 'Cursor' }));
  assert.match(r.welcome, /Test Project/);
  await client.close();
});

test('MCP: wait returns compact text, the app name comes from the MCP handshake, tokens are counted', async () => {
  const { client, call, json } = await mcpClient(`${hub.localBase}/r/${room.code}/mcp`);
  const joined = json(await call('join_room', { name: 'Textie', model: 'some-model-1' }));
  assert.match(joined.listening, /^focus/);
  const r = await call('wait_for_updates', { timeout_seconds: 0 });
  assert.match(r.content[0].text, /^lead: /);
  assert.match(r.content[0].text, /\nnext: /);
  const me = room.memberByName('Textie');
  assert.equal(me.client.name, 'test-client');
  assert.equal(me.app, 'test-client');
  assert.ok(me.traffic.out > 0);
  const snapMe = room.snapshot().members.find((m) => m.name === 'Textie');
  assert.equal(snapMe.model, 'some-model-1');
  assert.equal(snapMe.source, 'self');
  await client.close();
});

test('Claude Code status line reports reach the matching member', async () => {
  const api = (action, body, headers = {}) => fetch(`${hub.localBase}/r/${room.code}/api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  await (await api('join', { name: 'CC', app: 'Claude Code' })).json();
  const res = await fetch(`${hub.localBase}/hub/usage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-key': hub.key },
    body: JSON.stringify({ session_id: 'cc-1', workspace: { current_dir: project }, model: { display_name: 'Opus' }, context_window: { used_percentage: 37 }, rate_limits: { five_hour: { used_percentage: 88 }, seven_day: { used_percentage: 41 } } }),
  });
  assert.equal(res.status, 200);
  const cc = room.snapshot().members.find((m) => m.name === 'CC');
  assert.equal(cc.model, 'Opus');
  assert.equal(cc.usage.session.used, 88);
  assert.equal(cc.usage.weekly.used, 41);
  assert.equal(cc.usage.source, 'Claude Code status line');
});

test('dashboard events are incremental, and older messages can be paged in', async () => {
  const events = [];
  const req = http.get({ host: '127.0.0.1', port: hub.port, path: `/r/${room.code}/events?key=${room.adminKey}` });
  const got = new Promise((resolve) => {
    req.on('response', (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)));
          if (events.length >= 2) resolve();
        }
      });
    });
  });
  await new Promise((r) => setTimeout(r, 200));
  await room.call('send', { id: 'human', name: 'Human' }, { text: 'incremental hello' });
  await got;
  req.destroy();
  assert.equal(events[0].reset, true);
  assert.ok(events[0].messages.length > 1);
  assert.equal(events[1].reset, false);
  assert.deepEqual(events[1].messages.map((m) => m.text), ['incremental hello']);
  const firstSeq = events[0].messages.at(-1).seq;
  const hist = await (await fetch(`${hub.localBase}/r/${room.code}/history?key=${room.adminKey}&before=${firstSeq}`)).json();
  assert.ok(hist.messages.every((m) => m.seq < firstSeq));
  assert.equal((await fetch(`${hub.localBase}/r/${room.code}/history`)).status, 403);
});

test('avatars are drawn locally as SVG', async () => {
  const api = (action, body) => fetch(`${hub.localBase}/r/${room.code}/api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await (await api('join', { name: 'Pic', avatar: 'pixel-art:hello' })).json();
  const snap = room.snapshot().members.find((m) => m.name === 'Pic');
  const res = await fetch(`${hub.localBase}${snap.avatar}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  assert.match(await res.text(), /^<svg/);
  assert.equal((await fetch(`${hub.localBase}/r/${room.code}/avatar/nobody.svg`)).status, 404);
});

test('invite prompt: ready to paste, with code, role and how to join', async () => {
  const res = await fetch(`${hub.localBase}/r/${room.code}/prompt?key=${room.adminKey}&name=Gemini&role=lead`);
  const prompt = await res.text();
  assert.match(prompt, new RegExp(`Room code: ${room.code}`));
  assert.match(prompt, /Join as: Gemini \(the LEAD\)/);
  assert.match(prompt, /call join_room with invite "[A-Z0-9-]+", name "Gemini", lead true/);
  assert.match(prompt, /crewroom join --name "Gemini" .* --lead/);
  assert.match(prompt, /You lead:/);
  assert.equal((await fetch(`${hub.localBase}/r/${room.code}/prompt`)).status, 403);
});

test('lite profile drops the file tools; ?wait sets the default wait; public waits stay under the tunnel limit', async () => {
  const full = await mcpClient(`${hub.localBase}/r/${room.code}/mcp`);
  const lite = await mcpClient(`${hub.localBase}/r/${room.code}/mcp?profile=lite&wait=600`);
  const fullTools = (await full.client.listTools()).tools;
  const liteTools = (await lite.client.listTools()).tools;
  assert.equal(fullTools.length - liteTools.length, 8);
  assert.ok(!liteTools.some((t) => ['read_file', 'write_file', 'edit_file', 'run_command'].includes(t.name)));
  assert.ok(liteTools.some((t) => t.name === 'share_file'));
  assert.ok(JSON.stringify(liteTools).length < JSON.stringify(fullTools).length * 0.8, 'lite list is smaller');
  assert.match(liteTools.find((t) => t.name === 'wait_for_updates').inputSchema.properties.timeout_seconds.description, /Default 600/);
  const minimal = await mcpClient(`${hub.localBase}/r/${room.code}/mcp?profile=minimal`);
  assert.deepEqual((await minimal.client.listTools()).tools.map((t) => t.name).sort(), ['join_room', 'memory', 'read_messages', 'send_message', 'update_task', 'wait_for_updates']);
  await minimal.client.close();
  await full.client.close();
  await lite.client.close();
});

test('the team ledger and task diffs are on the dashboard API (human only)', async () => {
  const log = await (await fetch(`${hub.localBase}/r/${room.code}/log?key=${room.adminKey}`)).json();
  assert.ok(Array.isArray(log.entries));
  assert.equal((await fetch(`${hub.localBase}/r/${room.code}/log`)).status, 403);
  assert.equal((await fetch(`${hub.localBase}/r/${room.code}/taskdiff/T999?key=${room.adminKey}`)).status, 404);
});

test('fresh-chat prompt and archived chapters are available to the human only', async () => {
  const api = (action, body) => fetch(`${hub.localBase}/r/${room.code}/api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': room.adminKey }, body: JSON.stringify(body) }).then((r) => r.json());
  const joined = await fetch(`${hub.localBase}/r/${room.code}/api/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Fresh' }) }).then((r) => r.json());
  const prompt = await (await fetch(`${hub.localBase}/r/${room.code}/prompt?key=${room.adminKey}&name=Fresh&resume=1`)).text();
  assert.match(prompt, new RegExp(`join_room with token "${joined.your_token}"`));
  assert.equal((await fetch(`${hub.localBase}/r/${room.code}/prompt?key=${room.adminKey}&name=Nobody&resume=1`)).status, 404);

  const before = room.s.chapter || 1;
  await api('send', { text: 'before the new chapter' });
  const r = await api('new_chapter', { summary: 'Where we are: testing chapters.' });
  assert.equal(r.chapter, before + 1);
  const text = await (await fetch(`${hub.localBase}/r/${room.code}/archive/${before}?key=${room.adminKey}`)).text();
  assert.match(text, /before the new chapter/);
  assert.equal((await fetch(`${hub.localBase}/r/${room.code}/archive/${before}`)).status, 403);
  assert.equal((await fetch(`${hub.localBase}/r/${room.code}/archive/99?key=${room.adminKey}`)).status, 404);
});

test('dashboard events carry "seen by" changes for messages already on screen', async () => {
  const events = [];
  const req = http.get({ host: '127.0.0.1', port: hub.port, path: `/r/${room.code}/events?key=${room.adminKey}` });
  req.on('response', (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)));
      }
    });
  });
  const until = async (fn) => { for (let i = 0; i < 50 && !fn(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(fn()); };
  const r = await room.call('join', null, { name: 'Seer' });
  const seer = room.memberByToken(r.your_token);
  await room.call('wait', seer, { timeout_seconds: 0 });
  await until(() => events.length);
  await room.call('send', { id: 'human', name: 'Human' }, { text: '@Seer did you see this?' });
  await until(() => events.some((e) => e.messages.some((m) => m.text === '@Seer did you see this?')));
  const msg = events.flatMap((e) => e.messages).find((m) => m.text === '@Seer did you see this?');
  assert.equal(msg.seenBy, undefined);
  await room.call('wait', seer, { timeout_seconds: 0 });
  await until(() => events.some((e) => e.meta?.[msg.seq]));
  assert.deepEqual(events.find((e) => e.meta?.[msg.seq]).meta[msg.seq].seenBy, ['Seer']);
  await room.call('react', seer, { seq: msg.seq, emoji: '👍' });
  await until(() => events.some((e) => e.meta?.[msg.seq]?.reactions));
  assert.deepEqual(events.find((e) => e.meta?.[msg.seq]?.reactions).meta[msg.seq].reactions, { '👍': ['Seer'] });
  req.destroy();
});

test('an app that lost its connection is reconnected as the same member without a rejoin', async () => {
  const connectAs = async (name) => {
    const client = new Client({ name, version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${hub.localBase}/r/${room.code}/mcp`)));
    return client;
  };
  const first = await connectAs('solo-app');
  await first.callTool({ name: 'join_room', arguments: { name: 'Solo' } });
  await first.close();
  // A new connection from the same app (restart, new process): it just carries on.
  const second = await connectAs('solo-app');
  const r = await second.callTool({ name: 'room_status', arguments: {} });
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /^\(Reconnected you as Solo/);
  await second.close();
  // Two members from the same app: ambiguous, so it asks to rejoin instead of guessing.
  const a = await connectAs('twin-app');
  await a.callTool({ name: 'join_room', arguments: { name: 'TwinA' } });
  const b = await connectAs('twin-app');
  await b.callTool({ name: 'join_room', arguments: { name: 'TwinB' } });
  const c = await connectAs('twin-app');
  assert.match((await c.callTool({ name: 'room_status', arguments: {} })).content[0].text, /Not joined/);
  for (const x of [a, b, c]) await x.close();
});

test('an MCP join on this computer also saves the identity for terminal commands', async () => {
  const { client, call, json } = await mcpClient(`${hub.localBase}/r/${room.code}/mcp`);
  const joined = json(await call('join_room', { name: 'Termy' }));
  const file = path.join(hub.home, 'agents', room.code, 'termy.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, joined.your_token);
  const now = await call('room_status', { scope: 'me' });
  assert.match(now.content[0].text, /"you":"Termy"/);
  await client.close();
});

test('always-on API member: waits for free, answers when mentioned, key never leaves the server', { timeout: 30_000 }, async (t) => {
  const prompts = [];
  const fake = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const j = JSON.parse(body);
    prompts.push({ auth: req.headers.authorization, prompt: j.messages.at(-1).content });
    const seq = Number(j.messages.at(-1).content.match(/#(\d+) [^\n]*@Sonar/)?.[1]);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ say: [{ text: 'Found it: use the v2 API.' }], react: [{ seq, emoji: '👀' }] }) } }], usage: { prompt_tokens: 120, completion_tokens: 12 } }));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  t.after(() => { fake.closeAllConnections(); fake.close(); });
  const add = (body) => fetch(`${hub.localBase}/r/${room.code}/agents`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': room.adminKey }, body: JSON.stringify(body) });
  assert.equal((await add({ name: 'Sonar', provider: 'custom', model: 'm' })).status, 400); // no base URL / key
  const r = await add({ name: 'Sonar', provider: 'custom', baseUrl: `http://127.0.0.1:${fake.address().port}`, model: 'sonar-test', apiKey: 'sk-secret-123' });
  assert.equal(r.status, 200);
  await new Promise((r2) => setTimeout(r2, 100));
  assert.equal(prompts.length, 0, 'no API call while nothing concerns it');

  await room.call('send', HUMAN, { text: '@Sonar which API version should we use?' });
  const until = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r2) => setTimeout(r2, 50)); assert.ok(fn()); };
  await until(() => room.s.messages.some((m) => m.text === 'Found it: use the v2 API.'));
  assert.equal(prompts[0].auth, 'Bearer sk-secret-123');
  assert.match(prompts[0].prompt, /@Sonar which API version/);
  const asked = room.s.messages.find((m) => m.text === '@Sonar which API version should we use?');
  await until(() => asked.reactions?.['👀']);
  const sonar = room.snapshot().members.find((m) => m.name === 'Sonar');
  assert.deepEqual([sonar.agent.calls, sonar.agent.tokensIn], [1, 120]);
  assert.ok(!JSON.stringify(room.snapshot()).includes('sk-secret-123'));
  assert.ok(!fs.readFileSync(room.stateFile, 'utf8').includes('sk-secret-123'));
  // Removing the member stops it and deletes its key.
  await room.call('kick', HUMAN, { name: 'Sonar' });
  assert.ok(!fs.readFileSync(path.join(room.dataDir, 'agents.json'), 'utf8').includes('sk-secret-123'));
});

test('update: version comparison and how this copy was installed', () => {
  assert.equal(newer('1.0.10', '1.0.9'), true);
  assert.equal(newer('1.0.0', '1.0.0'), false);
  assert.equal(newer('0.9.1', '1.0.0'), false);
  assert.equal(installKind(path.join(process.cwd(), 'bin', 'crewroom.js')), 'git');
  assert.equal(installKind('/usr/lib/node_modules/crewroom/bin/crewroom.js'), 'npm');
});
