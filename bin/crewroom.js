#!/usr/bin/env node
// crewroom: a room where AI assistants from different apps work on one project together.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { homeDir, readJson, writeJson, normalizeCode, openInBrowser, VERSION, CLI_PATH, identityPath } from '../src/util.js';
import { ensureHub, runningHub, hubApi, findProjectRoot } from '../src/client.js';
import { formatWait, formatMessage as fmtMsg, formatTask } from '../src/format.js';

const BOOLEAN_FLAGS = new Set(['lead', 'all', 'json', 'decision', 'away', 'back', 'public', 'open', 'yes', 'y', 'list', 'off', 'new-code', 'help', 'h', 'remove', 'stdin', 'private', 'lite', 'resume', 'minimal', 'check', 'force']);

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      const [k, inline] = a.replace(/^--?/, '').split(/=(.*)/s);
      if (inline !== undefined) flags[k] = inline;
      else if (BOOLEAN_FLAGS.has(k)) flags[k] = true;
      else flags[k] = argv[++i];
    } else pos.push(a);
  }
  return { flags, pos };
}

const HELP = `crewroom ${VERSION}: one room, all your AIs, one project.

SET UP (once per computer)
  crewroom connect              add Crewroom to your installed AI apps
                                (Claude desktop, Claude Code, Codex, Antigravity, Cursor,
                                 Windsurf, VS Code, Gemini CLI). --list shows status.
  crewroom disconnect           remove it again

START A ROOM (in your project folder)
  crewroom start [--name "My App"] [--open] [--public]
                                prints the dashboard link (for you) and the invite
                                link/code (for your AIs). Runs in the background.
  crewroom open                 open the dashboard in your browser
  crewroom links                show the links again
  crewroom invite [--name Gemini] [--lead]   a ready-to-paste prompt that gets an AI into the room
  crewroom invite --resume --name Gemini     a prompt to continue as Gemini in a fresh conversation (saves tokens)
  crewroom public [--off]       public link for cloud AIs (ChatGPT, Claude.ai web)
  crewroom stop [--all]         close this project's room (--all: stop Crewroom)
  crewroom start --new-code     new room code, everyone removed (if a link leaked)
  crewroom doctor               check that everything works
  crewroom update [--check]     update Crewroom to the latest version (--check: only look)

FOR AI AGENTS WITH A TERMINAL (run in the project folder)
  crewroom join --name Claude --app "Claude Code" --caps "terminal,local-files" [--lead]
  crewroom wait --as Claude [--timeout 90]
  crewroom say --as Claude [--to Gemini] "message"      (or --stdin / --file msg.md for long or code-heavy text)
  crewroom ask --as Claude [--to ChatGPT | --to "Gemini, Codex" | --to auto:image-generation]
               [--kind task|review|fix|question|asset|research] [--details "..."] [--files a.js,b.js]
               [--wait 120] "title"          (--wait: get the result back in the same call)
  crewroom take --as Gemini T2           crewroom done --as Gemini T2 "result" [--status blocked] [--attach id]
  crewroom claim --as Claude src/app.js  crewroom release --as Claude src/app.js
  crewroom share --as Gemini icon.png [--to Claude] ["message"]
  crewroom save --as Claude <fileId> public/icon.png
  crewroom status | tasks | history | assets | notes | changes  --as Claude
  crewroom note --as Claude [--decision] "text"
  crewroom away --as Claude ["reason"]   crewroom back --as Claude
  crewroom summary --as Claude ["text"]  show or write the room summary (saves everyone tokens)
  crewroom focus --as Claude focus|all   what you receive: only what concerns you, or everything
  crewroom read --as Claude <#>          one message in full
  crewroom remember --as Claude "fact" [--tags a,b] [--kind decision|preference|lesson] [--private]
  crewroom recall --as Claude "a few words"     only the best matches (cheap)   |  crewroom forget --as Claude M12
  crewroom me --as Claude [--avatar lorelei:sunny] [--model "..."] [--focus all|focus] ["activity"]
  crewroom checkpoint --as Claude "doing X; next Y"   saved for when you rejoin in a fresh conversation
  crewroom react --as Claude 12 👍                    acknowledge message #12 without a reply (free)
  crewroom now --as Claude                            my tasks, claims, unread, latest from the human/lead
  crewroom claim --as Codex "locale/*/*.txt" a.js     several files or globs at once; no args = list claims
  crewroom delete --as Claude 12                      delete your own message
  crewroom merge --as Claude "Claude 2" Claude        (lead) fold a dead duplicate into the real member
  crewroom ask ... --done-when "tests pass" --check "npm test" [--difficulty easy|normal|hard]
  crewroom review --as Claude T3 approve|changes [--rating 4] ["note"]   crewroom diff --as Claude T3
  crewroom log --as Claude [Codex | T3 | src/app.js]   the team ledger: who did what
  crewroom tool --as Codex add lint npm run lint [--desc "..."] | run lint | list | remove lint
  crewroom rank --as Claude --name Codex senior|mid|junior|trainee|auto   (lead)
  crewroom import-memory --as Claude --file notes.md  share a memory file with the room (bullets -> memories)
  crewroom knowledge --as Claude CLAUDE.md docs/x.md  (lead) files every AI reads first
  crewroom chapter --as Claude "where we are"         (lead) archive the chat and start a new chapter
  crewroom brief | lead <Name> | pause | resume  --as Claude      (lead only)
  crewroom pause | resume --as Claude --name Codex ["reason"]      (lead: pause or resume one AI)
  crewroom halt --as Claude --name Codex ["reason"]                (lead: stop it, free its files, reopen its tasks)
  Options: --as <Name> (saved by join), --token, --url <invite link> to use another room.

ADVANCED
  crewroom hub [--port 7777] [--host 127.0.0.1] [--public-url URL]   run the hub in the foreground
  crewroom mcp [--lite|--minimal] [--wait 600]   stdio MCP server (what apps launch; set up by "connect").
                                --lite: no file tools (for apps with their own); --minimal: 6 core
                                tools for small models (fewer mistakes); --wait: default
                                wait in seconds (long waits are split for the hub; fewer checks)
  crewroom statusline           Claude Code status line: shows model/context/limits and sends them
                                to the dashboard (set up by "crewroom connect claude-code")
`;

class CliExit extends Error {}
// No process.exit(): on Windows it can trip a libuv assertion while fetch sockets are closing.
// Set the exit code and unwind; Node exits on its own when nothing is left to do.
function die(msg) {
  console.error(`crewroom: ${msg}`);
  process.exitCode = 1;
  throw new CliExit(msg);
}

// ---------------- room connection for agent commands ----------------

async function roomConnection(flags) {
  const invite = flags.url || process.env.CREWROOM_URL;
  if (invite) {
    const m = String(invite).match(/^(https?:\/\/[^/]+)\/r\/([^/]+)/);
    if (!m) die('--url must be an invite link like http://127.0.0.1:7777/r/ABCD-EFGH-JKLM/join');
    return { base: `${m[1]}/r/${normalizeCode(m[2])}`, code: normalizeCode(m[2]) };
  }
  const root = findProjectRoot();
  if (!root) die('No room in this folder. Run "crewroom start" here first, or pass --url <invite link>.');
  const hub = await ensureHub();
  const links = await hubApi(hub, 'rooms', { projectRoot: root });
  return { base: `http://127.0.0.1:${hub.port}/r/${links.code}`, code: links.code, root, hub, links };
}

const identityFile = (code, name) => identityPath(homeDir(), code, name);

function tokenFor(flags, conn) {
  if (flags.token) return flags.token;
  const name = flags.as || process.env.CREWROOM_AS;
  if (name) {
    const saved = readJson(identityFile(conn.code, name));
    if (!saved) die(`No saved identity for "${name}" in this room. Run: crewroom join --name ${name} --app "<your app>"`);
    return saved.token;
  }
  if (process.env.CREWROOM_TOKEN) return process.env.CREWROOM_TOKEN;
  die('Who are you? Add --as <YourName> (the name you joined with).');
}

async function api(conn, action, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${conn.base}/api/${action}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  } catch (err) {
    die(`Cannot reach the room (${err.cause?.code || err.message}).`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------- output ----------------

function printLinks(l, { header = true } = {}) {
  if (header) console.log(`\nCrewroom is ready: "${l.name}"   (${l.project})\n`);
  console.log(`  Dashboard (only for you):   ${l.dashboard}`);
  console.log(`  Invite link for your AIs:   ${l.invite}`);
  console.log(`  Room code:                  ${l.code}`);
  if (l.public_mcp) {
    console.log(`\n  Public link (for ChatGPT / Claude.ai web connectors):`);
    console.log(`  MCP URL:                    ${l.public_mcp}`);
    console.log(`  Public invite page:         ${l.public_invite}`);
  } else if (l.tunnel?.state === 'error') {
    console.log(`\n  Public link failed: ${l.tunnel.error}`);
  }
}

function nextSteps(l) {
  console.log(`
Next:
  • Get a ready-to-paste prompt for each AI:  crewroom invite --name Gemini   (add --lead for the lead)
    or click "Invite AI" on the dashboard. Short version: paste the code ${l.code} and say "join this room".
  • AI apps not set up yet? Run once:  crewroom connect
  • ChatGPT or Claude.ai on the web?  Run:  crewroom public   (or use the button on the dashboard)
Crewroom keeps running in the background. "crewroom stop" closes this room.`);
}

// ---------------- commands ----------------

async function cmdStart(flags) {
  const root = path.resolve(flags.project || process.cwd());
  const hub = await ensureHub({ port: flags.port ? Number(flags.port) : undefined });
  let links = await hubApi(hub, 'rooms', { projectRoot: root, name: flags.name, resetAccess: !!flags['new-code'] });
  if (flags.public) {
    console.log('Starting the public link (first time downloads cloudflared, ~20 MB)...');
    const t = await hubApi(hub, 'tunnel', { on: true });
    links = t.rooms.find((r) => r.code === links.code) || links;
  }
  if (flags.json) return console.log(JSON.stringify(links, null, 2));
  printLinks(links);
  nextSteps(links);
  if (flags.open) openInBrowser(links.dashboard);
}

async function cmdLinks(flags, { open = false } = {}) {
  const root = findProjectRoot();
  if (!root) die('No room in this folder. Run "crewroom start" first.');
  const hub = await ensureHub();
  const links = await hubApi(hub, 'rooms', { projectRoot: root });
  if (open) {
    openInBrowser(links.dashboard);
    return console.log(`Opening ${links.dashboard}`);
  }
  if (flags.json) return console.log(JSON.stringify(links, null, 2));
  printLinks(links, { header: false });
}

async function cmdPublic(flags) {
  const hub = await ensureHub();
  if (!flags.off) console.log('Starting the public link (first time downloads cloudflared, ~20 MB)...');
  const t = await hubApi(hub, 'tunnel', { on: !flags.off });
  if (flags.off) return console.log('Public link is off. Only apps on this computer can reach your rooms.');
  if (t.state !== 'on' && t.state !== 'custom') die(`Could not start the public link: ${t.error}`);
  const root = findProjectRoot();
  const rooms = root ? t.rooms.filter((r) => r.project === root) : t.rooms;
  for (const r of rooms) {
    console.log(`\n"${r.name}"  MCP URL: ${r.public_mcp}`);
  }
  console.log(`
Add the MCP URL as a connector:
  ChatGPT: Settings → Apps & Connectors → Advanced → Developer mode on → Create → paste the URL (no auth).
  Claude.ai: Settings → Connectors → Add custom connector → paste the URL.
Then say "join the Crewroom room ${rooms[0]?.code || ''}".
The link changes each time the public link restarts. Turn it off with: crewroom public --off`);
}

async function cmdStop(flags) {
  const hub = await runningHub();
  if (!hub) return console.log('Crewroom is not running.');
  if (flags.all) {
    await hubApi(hub, 'shutdown', {});
    return console.log('Crewroom stopped.');
  }
  const root = findProjectRoot();
  if (!root) die('No room in this folder. Use --all to stop Crewroom completely.');
  await hubApi(hub, 'rooms/close', { projectRoot: root }).catch((e) => die(e.message));
  console.log('Room closed. Its history is kept in .crewroom/; "crewroom start" reopens it.');
}

async function cmdHub(flags) {
  const { Hub } = await import('../src/hub.js');
  const hub = new Hub({ port: flags.port !== undefined ? Number(flags.port) : Number(process.env.CREWROOM_PORT || 7777), host: flags.host || '127.0.0.1', publicUrl: flags['public-url'] });
  try {
    await hub.start();
  } catch (err) {
    if (err.code === 'HUB_RUNNING') {
      console.log(err.message);
      process.exit(0);
    }
    throw err;
  }
  if (flags.public) hub.setTunnel(true);
  const stop = () => hub.stop().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function cmdConnect(pos, flags, { remove = false } = {}) {
  const { APPS, appStatus, configureApp } = await import('../src/connect.js');
  const status = appStatus();
  if (flags.list) {
    console.log('App                                   Installed  Crewroom');
    for (const s of status) console.log(`${s.app.label.padEnd(38)}${(s.installed ? 'yes' : 'no').padEnd(11)}${s.configured === null ? '?' : s.configured ? 'connected' : '-'}`);
    return;
  }
  let targets;
  if (pos.length) {
    targets = pos.map((id) => APPS.find((a) => a.id === id) || die(`Unknown app "${id}". Known: ${APPS.map((a) => a.id).join(', ')}`));
  } else {
    targets = status.filter((s) => s.installed && (remove ? s.configured !== false : true)).map((s) => s.app);
    if (!targets.length) {
      console.log(remove ? 'Crewroom is not set up in any app.' : 'No supported AI apps found on this computer.');
      if (!remove) console.log(`You can still use Crewroom from any agent with a terminal (see "crewroom help"),\nor add this MCP server by hand in your app:\n  command: ${process.execPath}\n  args:    ${CLI_PATH} mcp`);
      return;
    }
    console.log(`${remove ? 'Remove Crewroom from' : 'Set up Crewroom in'}:\n${targets.map((a) => `  • ${a.label}`).join('\n')}`);
    if (process.stdin.isTTY && !flags.yes && !flags.y) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question('Continue? [Y/n] ')).trim().toLowerCase();
      rl.close();
      if (answer && !answer.startsWith('y')) return console.log('Nothing changed.');
    }
  }
  const afters = [];
  for (const app of targets) {
    for (const r of configureApp(app, { remove })) console.log(`${r.ok ? '✓' : '✗'} ${app.label}: ${r.message}`);
    if (!remove && app.after) afters.push(`  • ${app.label}: ${app.after}`);
  }
  if (remove) return;
  console.log(`\nAlmost done. Restart the apps so they load Crewroom:\n${afters.join('\n')}`);
  console.log(`
Then in any of them: start a room ("crewroom start" in your project, or ask your AI to),
paste the invite link or code into the chat, and say "join this room".

ChatGPT and Claude.ai (web) run in the cloud and cannot start programs on your PC.
For them run "crewroom public" and add the MCP URL it prints as a connector.`);
}

/**
 * Claude Code status line: Claude Code pipes its session JSON (model, context, 5-hour and
 * weekly limits) to this command on every update. We print a short line for Claude Code
 * and forward the numbers to the local hub so the Crewroom dashboard can show them.
 */
async function cmdStatusline() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let j = {};
  try { j = JSON.parse(raw); } catch {}
  const p = (v) => (typeof v === 'number' ? `${Math.round(v)}%` : null);
  const parts = [j.model?.display_name || j.model?.id || 'Claude'];
  if (p(j.context_window?.used_percentage)) parts.push(`ctx ${p(j.context_window.used_percentage)}`);
  if (p(j.rate_limits?.five_hour?.used_percentage)) parts.push(`5h ${p(j.rate_limits.five_hour.used_percentage)}`);
  if (p(j.rate_limits?.seven_day?.used_percentage)) parts.push(`week ${p(j.rate_limits.seven_day.used_percentage)}`);
  console.log(parts.join(' · '));
  // Never start the hub or slow Claude Code down from here: only report if it is already running.
  const info = readJson(path.join(homeDir(), 'hub.json'));
  if (!info?.port || !j.session_id) return;
  try {
    await fetch(`http://127.0.0.1:${info.port}/hub/usage`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-key': info.key }, body: raw, signal: AbortSignal.timeout(800) });
  } catch {}
}

async function cmdUpdate(flags) {
  const { latestVersion, newer, install, installKind } = await import('../src/update.js');
  let latest;
  try {
    latest = await latestVersion();
  } catch (err) {
    die(`Could not check for updates (${err.message}). Check your internet connection.`);
  }
  if (!newer(latest, VERSION) && !flags.force) return console.log(`Crewroom ${VERSION} is up to date.`);
  console.log(newer(latest, VERSION) ? `Update available: ${VERSION} → ${latest}` : `Reinstalling ${latest}...`);
  if (flags.check) return console.log('Run "crewroom update" to install it.');
  const kind = installKind();
  // Stop the background hub first, so its files can be replaced. Rooms are saved and reopen.
  const hub = await runningHub().catch(() => null);
  if (hub) await hubApi(hub, 'shutdown', {}).catch(() => {});
  console.log(kind === 'portable' ? 'Downloading the Windows package...' : 'Installing with npm...');
  try {
    await install(kind);
  } catch (err) {
    die(`Update failed: ${err.message}`);
  }
  if (kind === 'npm') {
    // The new version re-adds Crewroom to your apps (settings can change between versions).
    const { spawn } = await import('node:child_process');
    await new Promise((resolve) => {
      const child = spawn(process.platform === 'win32' ? 'crewroom.cmd' : 'crewroom', ['connect'], { stdio: 'inherit', shell: process.platform === 'win32' });
      child.on('exit', resolve);
      child.on('error', resolve);
    });
  }
  console.log(`\nUpdated to ${latest}. Restart your AI apps; your rooms open again with "crewroom start" (or "crewroom open").`);
}

async function cmdDoctor() {
  const ok = (b, msg) => console.log(`${b ? '✓' : '✗'} ${msg}`);
  const major = Number(process.versions.node.split('.')[0]);
  ok(major >= 20, `Node.js ${process.versions.node}${major >= 20 ? '' : ' (need 20 or newer)'}`);
  ok(true, `Crewroom ${VERSION} at ${CLI_PATH}`);
  if (/_npx[\\/]/.test(CLI_PATH)) console.log('  ! Running from a temporary npx folder. Install globally so app configs keep working: npm i -g crewroom');
  let hub = await runningHub();
  ok(!!hub, hub ? `hub running on http://127.0.0.1:${hub.port} (pid ${hub.pid})` : 'hub not running (it starts automatically when needed)');
  if (!hub) {
    try {
      hub = await ensureHub();
      ok(true, `hub started on port ${hub.port}`);
    } catch (err) {
      ok(false, err.message);
    }
  }
  if (hub) {
    const { rooms } = await hubApi(hub, 'rooms', null, 'GET');
    ok(true, `${rooms.length} open room(s)${rooms.length ? `: ${rooms.map((r) => `${r.name} (${r.code})`).join(', ')}` : ''}`);
  }
  const root = findProjectRoot();
  console.log(root ? `  this folder belongs to the room in ${root}` : '  no room in this folder (run "crewroom start" here)');
  const { appStatus } = await import('../src/connect.js');
  for (const s of appStatus()) if (s.installed) ok(s.configured !== false, `${s.app.label}: ${s.configured === null ? 'installed (run "crewroom connect claude-code" to be sure)' : s.configured ? 'connected' : 'not connected (run "crewroom connect")'}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseArgs(rest);
  if (!cmd || ['help', '--help', '-h'].includes(cmd) || flags.help) return console.log(HELP);
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') return console.log(VERSION);

  switch (cmd) {
    case 'start': return cmdStart(flags);
    case 'links': return cmdLinks(flags);
    case 'invite': {
      const root = findProjectRoot();
      if (!root) die('No room in this folder. Run "crewroom start" first.');
      const hub = await ensureHub();
      const links = await hubApi(hub, 'rooms', { projectRoot: root });
      const params = new URLSearchParams({ key: new URL(links.dashboard).searchParams.get('key'), role: flags.lead ? 'lead' : 'member' });
      if (flags.name || pos[0]) params.set('name', flags.name || pos[0]);
      if (flags.resume) params.set('resume', '1');
      const res = await fetch(`${links.dashboard.replace(/\/dashboard\?.*$/, '')}/prompt?${params}`);
      return console.log(await res.text());
    }
    case 'open': return cmdLinks(flags, { open: true });
    case 'public': return cmdPublic(flags);
    case 'stop': return cmdStop(flags);
    case 'hub': return cmdHub(flags);
    case 'mcp': {
      const { runBridge } = await import('../src/bridge.js');
      return runBridge({ lite: !!flags.lite, minimal: !!flags.minimal, wait: flags.wait ? Number(flags.wait) : undefined });
    }
    case 'statusline': return cmdStatusline();
    case 'connect':
    case 'setup': return cmdConnect(pos, flags);
    case 'disconnect': return cmdConnect(pos, flags, { remove: true });
    case 'doctor': return cmdDoctor();
    case 'update':
    case 'upgrade': return cmdUpdate(flags);
  }

  // ---- agent commands ----
  const conn = await roomConnection(flags);
  const text = pos.join(' ');

  if (cmd === 'join') {
    const name = flags.name || flags.as || pos[0];
    if (!name) die('Usage: crewroom join --name <YourName> --app "<your app>" [--caps a,b] [--lead]');
    const file = identityFile(conn.code, name);
    const old = readJson(file)?.token;
    const r = await api(conn, 'join', { name, app: flags.app, model: flags.model, capabilities: flags.caps, avatar: flags.avatar, lead: !!flags.lead }, old);
    const joinedAs = r.welcome.match(/"([^"]+)"/)?.[1] || name;
    writeJson(identityFile(conn.code, joinedAs), { name: joinedAs, token: r.your_token }, { mode: 0o600 });
    console.log(`${r.welcome} Role: ${r.role}. Lead: ${r.lead.name || 'nobody yet'}.`);
    console.log(`Project folder: ${r.project_folder}`);
    console.log(`Brief: ${r.brief}`);
    console.log(`Members: ${r.members.map((m) => `${m.name}${m.role === 'lead' ? ' [lead]' : ''} (${m.app}${m.capabilities?.length ? `; ${m.capabilities.join(', ')}` : ''})`).join(', ')}`);
    if (r.summary) console.log(`Summary: ${r.summary}`);
    if (r.your_checkpoint) console.log(`\nYour checkpoint: ${r.your_checkpoint}`);
    if (r.your_tasks?.length) console.log(`Your open tasks: ${r.your_tasks.map((t) => `${t.id} [${t.kind}, ${t.status}] ${t.title}`).join('; ')}`);
    if (r.recent_for_you?.length) console.log(`Recent for you:\n${r.recent_for_you.map((m) => `  #${m.seq} ${m.from}: ${String(m.text).split('\n')[0]}`).join('\n')}`);
    console.log(`\nRules:\n${r.rules.map((x) => `- ${x}`).join('\n')}`);
    console.log(`\nSaved your identity. Add --as ${joinedAs} to every command.`);
    if (r.your_checkpoint || r.your_tasks?.length || r.recent_for_you?.length) console.log(`Next: continue from your checkpoint/tasks, then   crewroom wait --as ${joinedAs}`);
    else console.log(`Next: crewroom say --as ${joinedAs} "hi, I'm ${joinedAs}; I can ..."   then   crewroom wait --as ${joinedAs}`);
    return;
  }

  const token = tokenFor(flags, conn);
  const call = async (action, body) => {
    const r = await api(conn, action, body, token);
    if (r?.warning) console.error(`crewroom warning: ${r.warning}`);
    return r;
  };
  const out = (r) => console.log(flags.json ? JSON.stringify(r, null, 2) : typeof r === 'string' ? r : JSON.stringify(r, null, 2));
  // Long or code-heavy text: --stdin or --file avoids shell quoting problems (e.g. PowerShell backticks).
  const longText = async (fallback) => {
    if (flags.stdin) {
      let raw = '';
      for await (const chunk of process.stdin) raw += chunk;
      return raw.replace(/\r?\n$/, '');
    }
    if (flags.file) return fs.readFileSync(path.resolve(String(flags.file)), 'utf8');
    return fallback;
  };

  switch (cmd) {
    case 'wait': {
      let remaining = Number(flags.timeout ?? 90);
      let r;
      do {
        const chunk = Math.min(remaining, 280);
        r = await call('wait', { timeout_seconds: chunk, include_history: Number(flags.history || 0) });
        remaining -= chunk;
      } while (!r.new_messages.length && !r.your_tasks?.length && remaining > 0);
      return flags.json ? out(r) : console.log(formatWait(r));
    }
    case 'say':
    case 'send': {
      const body = await longText(text);
      if (!body) die('Nothing to say. Give the text, or use --stdin / --file <path>.');
      return out(await call('send', { text: body, to: flags.to, attachments: flags.attach }));
    }
    case 'ask': {
      if (!text) die('Usage: crewroom ask --to <member> "title" [--details "..." | --stdin | --file <path>]');
      const details = flags.stdin || flags.file ? await longText() : flags.details;
      return out(await call('ask', { title: text, to: flags.to, kind: flags.kind, details, files: flags.files, wait_seconds: flags.wait ? Number(flags.wait) : undefined, done_when: flags['done-when'], check: flags.check, difficulty: flags.difficulty }));
    }
    case 'take':
      return out(await call('take_task', { task_id: pos[0] }));
    case 'done':
    case 'finish':
      return out(await call('finish_task', { task_id: pos[0], result: await longText(pos.slice(1).join(' ')), status: flags.status || 'done', attachments: flags.attach }));
    case 'tasks': {
      const r = await call('list_tasks', { include_done: !!flags.all });
      return flags.json ? out(r) : console.log(r.tasks.length ? r.tasks.map((t) => formatTask(t)).join('\n') : 'No tasks.');
    }
    case 'status':
      return out(await call('status', {}));
    case 'claim':
      if (!pos.length) return out(await call('claim_file', {}));
      return out(await call('claim_file', pos.length > 1 ? { paths: pos, note: flags.note } : { path: pos[0], note: flags.note }));
    case 'release':
      return out(await call('release_file', pos.length > 1 ? { paths: pos } : { path: pos[0] }));
    case 'now':
      return out(await call('my_work', {}));
    case 'delete':
      return out(await call('delete_message', { seq: Number(String(pos[0] || '').replace('#', '')) }));
    case 'merge':
      if (pos.length < 2) die('Usage: crewroom merge --as <lead> "Claude 2" Claude   (folds the first into the second)');
      return out(await call('merge_member', { from: pos[0], into: pos[1] }));
    case 'note':
      return out(await call('note', { text: await longText(text), kind: flags.decision ? 'decision' : 'note' }));
    case 'notes':
      return out(await call('notes', {}));
    case 'changes': {
      const r = await call('project_changes', { path: pos[0] });
      return flags.json || !r.git ? out(r) : console.log(`${r.status}\n\n${r.summary}\n\n${r.diff}`);
    }
    case 'read':
      return console.log(fmtMsg((await call('read_message', { seq: Number(pos[0]) })).message));
    case 'summary': {
      const summaryText = await longText(text);
      if (!summaryText) {
        const st = await call('status', {});
        return console.log(st.summary || 'No summary yet. Write one: crewroom summary --as <you> "goal, decisions, who does what, what is left"');
      }
      return out(await call('set_summary', { text: summaryText }));
    }
    case 'focus':
      if (!['all', 'focus'].includes(pos[0])) die('Usage: crewroom focus --as <you> focus|all [--name <member>]');
      return out(await call('set_focus', { mode: pos[0], name: flags.name }));
    case 'history': {
      const r = await call('read_messages', { limit: Number(flags.limit || 50) });
      return flags.json ? out(r) : console.log(r.messages.map(fmtMsg).join('\n'));
    }
    case 'share': {
      const file = pos[0];
      if (!file) die('Usage: crewroom share <file> [--to member] ["message"]');
      const abs = path.resolve(file);
      if (!fs.existsSync(abs)) die(`${file} not found.`);
      const message = pos.slice(1).join(' ') || undefined;
      const rel = conn.root ? path.relative(conn.root, abs) : null;
      const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.startsWith('.crewroom');
      const body = inside ? { path: rel, to: flags.to, message } : { base64: fs.readFileSync(abs).toString('base64'), name: path.basename(abs), to: flags.to, message };
      return out(await call('share_file', body));
    }
    case 'save':
      return out(await call('save_asset', { asset_id: pos[0], path: pos[1] }));
    case 'assets':
      return out(await call('list_assets', {}));
    case 'activity':
      return out(await call('set_activity', { activity: pos.length ? text : undefined, status: flags.away ? 'away' : flags.back ? 'online' : undefined }));
    case 'away':
      return out(await call('set_activity', { activity: text || undefined, status: 'away' }));
    case 'back':
      return out(await call('set_activity', { status: 'online' }));
    case 'brief':
      return out(await call('set_brief', { brief: text }));
    case 'lead':
      return out(await call('set_lead', { name: pos[0] }));
    case 'pause':
      if (flags.name) return out(await call('control_member', { name: flags.name, action: 'pause', reason: text || undefined }));
      return out(await call('pause', { paused: true, reason: text || undefined }));
    case 'resume':
      if (flags.name) return out(await call('control_member', { name: flags.name, action: 'resume', reason: text || undefined }));
      return out(await call('pause', { paused: false }));
    case 'halt':
      if (!flags.name) die('Usage: crewroom halt --as <lead> --name <member> ["reason"]   (pauses it, frees its files, reopens its tasks)');
      return out(await call('control_member', { name: flags.name, action: 'stop', reason: text || undefined }));
    case 'remember':
      return out(await call('remember', { text: await longText(text), tags: flags.tags, kind: flags.kind, private: !!flags.private }));
    case 'recall': {
      const r = await call('recall', { query: text, tags: flags.tags, limit: flags.limit ? Number(flags.limit) : undefined });
      return flags.json ? out(r) : console.log(r.memories.length ? r.memories.map((m) => `${m.id} ${m.kind ? `[${m.kind}] ` : ''}${m.text}${m.tags ? `  #${m.tags.join(' #')}` : ''}  (${m.by}${m.private ? ', private' : ''})`).join('\n') : `Nothing found (${r.total} memories).`);
    }
    case 'forget':
      return out(await call('forget', { id: pos[0] }));
    case 'review':
      if (!pos[0] || !['approve', 'changes'].includes(pos[1])) die('Usage: crewroom review --as Claude T3 approve|changes [--rating 4] ["note"]');
      return out(await call('review_task', { task_id: pos[0], verdict: pos[1], rating: flags.rating ? Number(flags.rating) : undefined, note: pos.slice(2).join(' ') || undefined }));
    case 'diff': {
      const r = await call('task_diff', { task_id: pos[0] });
      return flags.json ? out(r) : console.log(r.diff);
    }
    case 'log': {
      const r = await call('team_log', { about: text || undefined, limit: flags.limit ? Number(flags.limit) : 40 });
      return flags.json ? out(r) : console.log(r.entries.join('\n') || r.note);
    }
    case 'tool':
      return out(await call('toolbox', { action: pos[0] || 'list', name: pos[1], command: pos.slice(2).join(' ') || undefined, description: flags.desc, wait_seconds: flags.wait ? Number(flags.wait) : undefined }));
    case 'rank':
      return out(await call('set_rank', { name: flags.name || pos[0], rank: flags.name ? pos[0] : pos[1] }));
    case 'react':
      if (!pos[0] || !pos[1]) die('Usage: crewroom react --as Claude <message #> <emoji>');
      return out(await call('react', { seq: Number(String(pos[0]).replace('#', '')), emoji: pos[1] }));
    case 'import-memory':
      return out(await call('import_memory', { text: await longText(text), tags: flags.tags }));
    case 'knowledge':
      return out(await call('set_knowledge', { files: pos }));
    case 'me':
      return out(await call('update_me', { avatar: flags.avatar, model: flags.model, focus: flags.focus, checkpoint: flags.checkpoint !== undefined ? await longText(String(flags.checkpoint)) : undefined, activity: pos.length ? text : undefined }));
    case 'checkpoint':
      return out(await call('update_me', { checkpoint: await longText(text) }));
    case 'chapter':
      return out(await call('new_chapter', { summary: await longText(text) }));
    default:
      die(`Unknown command "${cmd}". Run: crewroom help`);
  }
}

main().catch((err) => {
  if (err instanceof CliExit) return;
  console.error(`crewroom: ${err.message}`);
  process.exitCode = 1;
});
