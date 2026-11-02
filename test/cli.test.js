import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'crewroom.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const home = tmp('crewroom-h-');
const fakeUserHome = tmp('crewroom-u-');
const project = tmp('crewroom-p-');
const env = { ...process.env, CREWROOM_HOME: home, CREWROOM_PORT: '0', HOME: fakeUserHome, USERPROFILE: fakeUserHome, CREWROOM_NO_UPDATE_CHECK: '1' };
const cli = (args, opts = {}) => run(process.execPath, [CLI, ...args], { cwd: project, env, ...opts });

before(() => fs.writeFileSync(path.join(project, 'README.md'), '# demo\n'));
after(async () => { await cli(['stop', '--all']).catch(() => {}); });

test('start runs the hub in the background and prints links; agents talk through the CLI', async () => {
  const { stdout } = await cli(['start', '--name', 'Demo', '--json']);
  const links = JSON.parse(stdout);
  assert.match(links.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.match(links.dashboard, /dashboard\?key=/);
  assert.ok(fs.existsSync(path.join(project, '.crewroom', 'room.json')));
  assert.equal(fs.readFileSync(path.join(project, '.crewroom', '.gitignore'), 'utf8').includes('*'), true);

  assert.match((await cli(['join', '--name', 'Claude', '--app', 'Claude Code', '--lead'])).stdout, /Role: lead/);
  await cli(['join', '--name', 'Codex', '--app', 'Codex', '--caps', 'terminal']);
  await cli(['wait', '--as', 'Codex', '--timeout', '0']);
  await cli(['ask', '--as', 'Claude', '--to', 'Codex', '--kind', 'review', 'Review README.md']);
  const w = await cli(['wait', '--as', 'Codex', '--timeout', '3']);
  assert.match(w.stdout, /\[T1 · review for Codex\] Review README.md/);
  assert.match(w.stdout, /--- your new\/changed tasks ---\n  T1 \[review, assigned, NEW\/CHANGED\] from Claude: Review README.md\nnext:/);
  await cli(['done', '--as', 'Codex', 'T1', 'Looks good']);
  const w2 = await cli(['wait', '--as', 'Claude', '--timeout', '3']);
  assert.match(w2.stdout, /\[T1 done\] Review README.md\n\s+Looks good/);

  // Running from a subfolder finds the room too.
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  const st = await cli(['status', '--as', 'Claude'], { cwd: path.join(project, 'src') });
  assert.equal(JSON.parse(st.stdout).room, 'Demo');
});

test('stdio bridge: an app joins with the code, and survives a hub restart', async () => {
  const links = JSON.parse((await cli(['links', '--json'])).stdout);
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env, stderr: 'pipe' });
  const client = new Client({ name: 'claude-desktop-sim', version: '1.0.0' });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, r.content?.[0]?.text);
    return JSON.parse(r.content[0].text);
  };
  const joined = await call('join_room', { invite: links.code, name: 'ChatGPT', app: 'ChatGPT desktop' });
  await call('send_message', { text: 'hello via stdio' });

  // Restart the hub underneath the bridge.
  await cli(['stop', '--all']);
  await new Promise((r) => setTimeout(r, 300));
  // The bridge rejoins with the remembered token by itself.
  const st = await call('room_status', {});
  assert.equal(st.you, 'ChatGPT');
  assert.equal(st.room, 'Demo');
  await client.close();
});

test('stdio bridge: one long wait spans several hub calls, wakes on news, and lite drops file tools', { timeout: 60_000 }, async (t) => {
  await cli(['start', '--json']);
  const links = JSON.parse((await cli(['links', '--json'])).stdout);
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp', '--lite', '--wait', '3'], env: { ...env, CREWROOM_WAIT_CHUNK: '1', CREWROOM_KEEPALIVE_MS: '400' }, stderr: 'pipe' });
  const client = new Client({ name: 'codex-sim', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close()); // a failed assert must not leave the bridge running
  const { tools } = await client.listTools();
  assert.ok(!tools.some((t) => t.name === 'write_file'));
  await client.callTool({ name: 'join_room', arguments: { invite: links.code, name: 'Waiter' } });
  await client.callTool({ name: 'wait_for_updates', arguments: { timeout_seconds: 0 } });

  // Nothing happens: the app gets one answer after ~3s (three 1s hub calls in between).
  let t0 = Date.now();
  let progress = 0;
  // Apps that pass a progress token get a signal every few seconds, so they don't time out.
  let r = await client.callTool({ name: 'wait_for_updates', arguments: {} }, undefined, { onprogress: () => progress++, resetTimeoutOnProgress: true, timeout: 2000 });
  assert.ok(Date.now() - t0 >= 2500, `waited ${Date.now() - t0}ms`);
  assert.ok(progress >= 3, `progress signals: ${progress}`);
  assert.match(r.content[0].text, /^nothing new/);

  // News during the second chunk wakes it right away.
  t0 = Date.now();
  setTimeout(() => cli(['say', '--as', 'Claude', '@Waiter ping']), 1500);
  r = await client.callTool({ name: 'wait_for_updates', arguments: { timeout_seconds: 20 } });
  assert.ok(Date.now() - t0 < 10_000);
  assert.match(r.content[0].text, /@Waiter ping/);
});

test('connect writes app configs (JSON + TOML), keeps other servers, and disconnect removes them', async () => {
  fs.mkdirSync(path.join(fakeUserHome, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(fakeUserHome, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  fs.mkdirSync(path.join(fakeUserHome, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(fakeUserHome, '.codex', 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "y"\n');

  const { stdout } = await cli(['connect', 'cursor', 'codex', '--yes']);
  assert.match(stdout, /✓ Cursor/);
  assert.match(stdout, /✓ Codex/);
  const cursor = JSON.parse(fs.readFileSync(path.join(fakeUserHome, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(cursor.mcpServers.other.command, 'x');
  assert.deepEqual(cursor.mcpServers.crewroom.args.slice(-2), ['mcp', '--lite']);
  const toml = fs.readFileSync(path.join(fakeUserHome, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /\[mcp_servers\.crewroom\]\ncommand = ".*"\nargs = \[".*crewroom\.js", "mcp", "--lite", "--wait", "1500"\]/);
  assert.match(toml, /tool_timeout_sec = 1800/);
  assert.match(toml, /\[mcp_servers\.other\]/);
  assert.ok(fs.existsSync(path.join(fakeUserHome, '.cursor', 'mcp.json.crewroom-backup')));

  // Running it twice does not duplicate anything.
  await cli(['connect', 'codex', '--yes']);
  assert.equal(fs.readFileSync(path.join(fakeUserHome, '.codex', 'config.toml'), 'utf8').split('[mcp_servers.crewroom]').length, 2);

  // A config we cannot parse is never overwritten.
  fs.mkdirSync(path.join(fakeUserHome, '.codeium', 'windsurf'), { recursive: true });
  fs.writeFileSync(path.join(fakeUserHome, '.codeium', 'windsurf', 'mcp_config.json'), '{ // comment\n}');
  const ws = await cli(['connect', 'windsurf', '--yes']);
  assert.match(ws.stdout, /✗ Windsurf: could not edit/);
  assert.equal(fs.readFileSync(path.join(fakeUserHome, '.codeium', 'windsurf', 'mcp_config.json'), 'utf8'), '{ // comment\n}');

  await cli(['disconnect', 'cursor', 'codex', '--yes']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fakeUserHome, '.cursor', 'mcp.json'), 'utf8')).mcpServers.crewroom, undefined);
  assert.doesNotMatch(fs.readFileSync(path.join(fakeUserHome, '.codex', 'config.toml'), 'utf8'), /crewroom/);
});

test('say --stdin keeps backticks, tabs, quotes, Windows paths and Unicode exactly; statusline prints a short line', async () => {
  const { spawn } = await import('node:child_process');
  await cli(['start', '--json']);
  await cli(['join', '--name', 'Quoter', '--app', 'PowerShell agent']);
  const text = 'Use `ddon_type` and\ttabs, "quotes", C:\\Users\\me\\app.js, ünïcødé ✓\nsecond line';
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, 'say', '--as', 'Quoter', '--stdin'], { cwd: project, env });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    p.stdin.end(`${text}\n`);
  });
  const hist = await cli(['history', '--as', 'Quoter', '--json']);
  assert.equal(JSON.parse(hist.stdout).messages.at(-1).text, text);

  const bell = await cli(['say', '--as', 'Quoter', 'bad \u0007escape']);
  assert.match(bell.stderr, /crewroom warning: Removed 1 control character/);

  const line = await new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'statusline'], { env });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.on('exit', () => resolve(out.trim()));
    p.stdin.end(JSON.stringify({ session_id: 'x', model: { display_name: 'Opus' }, context_window: { used_percentage: 12.4 }, rate_limits: { five_hour: { used_percentage: 3 } } }));
  });
  assert.equal(line, 'Opus · ctx 12% · 5h 3%');

  const inv = await cli(['invite', '--name', 'Codex']);
  assert.match(inv.stdout, /Join as: Codex \(a member\)/);
  assert.match(inv.stdout, /Room code: [A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/);
});
