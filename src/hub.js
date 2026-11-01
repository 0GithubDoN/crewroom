// The hub: one small background server per computer. It hosts every project's
// room, the dashboard, the REST API, the MCP endpoints and the optional public
// link. It listens on 127.0.0.1 only, so nothing outside this computer can
// reach it unless you turn on a public link.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Room, RoomError, HUMAN } from './room.js';
import { createMcpServer } from './mcp.js';
import { inviteText, invitePrompt } from './invite.js';
import { savedDiff } from './taskdiff.js';
import { AgentRunner, PROVIDERS } from './agents.js';
import { startTunnel } from './tunnel.js';
import { collectUsage, parseClaudeStatusline } from './usage.js';
import { avatarSvg } from './avatars.js';
import { homeDir, hubFile, readJson, writeJson, secret, normalizeCode, DEFAULT_PORT, VERSION } from './util.js';

const DASHBOARD = new URL('../public/dashboard.html', import.meta.url);
const MAX_BODY = 40 * 1024 * 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class Hub {
  constructor({ home = homeDir(), port = DEFAULT_PORT, host = '127.0.0.1', publicUrl = null, quiet = false } = {}) {
    this.home = home;
    this.requestedPort = port;
    this.host = host;
    this.quiet = quiet;
    this.rooms = new Map(); // code -> Room
    this.sessions = new Map(); // mcp session id -> { transport, server, lastUsed }
    this.badCodes = new Map(); // ip -> [timestamps] of unknown-room hits from outside
    this.tunnel = { state: publicUrl ? 'custom' : 'off', url: publicUrl ? publicUrl.replace(/\/+$/, '') : null, error: null, handle: null };
    this.id = randomUUID();
    this.key = secret(24);
    this.registryFile = path.join(home, 'rooms.json');
    this.statusline = new Map(); // Claude Code status line reports by session id
  }

  log(...args) {
    if (!this.quiet) console.log(new Date().toISOString().slice(11, 19), ...args);
  }

  // ---------------- rooms ----------------

  openRoom(projectRoot, { name, resetAccess = false } = {}) {
    const root = path.resolve(projectRoot);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new RoomError(`Folder not found: ${root}`, 404);
    let room = [...this.rooms.values()].find((r) => r.projectRoot === root);
    if (!room) {
      room = new Room({ projectRoot: root, name });
      room.agents = new AgentRunner(room, { log: (m) => this.log(m) });
      room.agents.startAll();
      this.rooms.set(room.code, room);
      this.log(`opened room ${room.code} for ${root}`);
    } else if (name && name !== room.s.name) {
      room.s.name = name;
      room._changed('settings');
    }
    if (resetAccess) {
      this.rooms.delete(room.code);
      room.resetAccess();
      this.rooms.set(room.code, room);
    }
    this._saveRegistry();
    return room;
  }

  closeRoom(code) {
    const room = this.rooms.get(code);
    if (!room) return false;
    room.close();
    this.rooms.delete(code);
    this._saveRegistry();
    this.log(`closed room ${code}`);
    return true;
  }

  room(code) {
    return this.rooms.get(normalizeCode(code)) || null;
  }

  roomForFolder(projectRoot) {
    const root = path.resolve(projectRoot);
    return [...this.rooms.values()].find((r) => r.projectRoot === root) || null;
  }

  listRooms() {
    return [...this.rooms.values()];
  }

  findMember(token) {
    if (!token) return null;
    for (const room of this.rooms.values()) {
      const member = room.memberByToken(token);
      if (member) return { room, member };
    }
    return null;
  }

  _saveRegistry() {
    writeJson(this.registryFile, [...this.rooms.values()].map((r) => ({ projectRoot: r.projectRoot, name: r.s.name })));
  }

  _loadRegistry() {
    for (const entry of readJson(this.registryFile, [])) {
      try {
        if (fs.existsSync(entry.projectRoot)) this.openRoom(entry.projectRoot);
      } catch (err) {
        this.log(`could not reopen ${entry.projectRoot}: ${err.message}`);
      }
    }
  }

  get localBase() {
    return `http://127.0.0.1:${this.port}`;
  }

  links(room) {
    const local = `${this.localBase}/r/${room.code}`;
    const pub = this.tunnel.url ? `${this.tunnel.url}/r/${room.code}` : null;
    return {
      code: room.code,
      project: room.projectRoot,
      name: room.s.name,
      dashboard: `${local}/dashboard?key=${room.adminKey}`,
      invite: `${local}/join`,
      mcp: `${local}/mcp`,
      public_invite: pub ? `${pub}/join` : null,
      public_mcp: pub ? `${pub}/mcp` : null,
      tunnel: { state: this.tunnel.state, error: this.tunnel.error },
    };
  }

  // ---------------- public link ----------------

  async setTunnel(on) {
    if (on) {
      if (this.tunnel.state === 'on' || this.tunnel.state === 'custom' || this.tunnel.state === 'starting') return this.tunnel;
      this.tunnel = { state: 'starting', url: null, error: null, handle: null };
      this._broadcast();
      try {
        const handle = await startTunnel({ home: this.home, localUrl: this.localBase, log: (m) => this.log(m) });
        this.tunnel = { state: 'on', url: handle.url, error: null, handle };
        handle.proc.on('exit', () => {
          if (this.tunnel.handle === handle) {
            this.tunnel = { state: 'error', url: null, error: 'The public link stopped. Turn it on again.', handle: null };
            this._broadcast();
          }
        });
        this.log(`public link: ${handle.url}`);
      } catch (err) {
        this.tunnel = { state: 'error', url: null, error: err.message, handle: null };
        this.log(`public link failed: ${err.message}`);
      }
    } else if (this.tunnel.handle || this.tunnel.state !== 'custom') {
      const h = this.tunnel.handle;
      this.tunnel = { state: 'off', url: null, error: null, handle: null };
      h?.stop();
    }
    this._broadcast();
    return this.tunnel;
  }

  _broadcast() {
    for (const room of this.rooms.values()) room.emit('change', 'links');
  }

  get publicHost() {
    try {
      return this.tunnel.url ? new URL(this.tunnel.url).host : null;
    } catch {
      return null;
    }
  }

  // ---------------- lifecycle ----------------

  async start() {
    this._loadRegistry();
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.requestTimeout = 0; // long-polling waits
    this.server.headersTimeout = 60_000;
    this.port = await this._listen(this.requestedPort);
    writeJson(hubFile(this.home), { app: 'crewroom', version: VERSION, hubId: this.id, key: this.key, port: this.port, pid: process.pid, startedAt: new Date().toISOString() }, { mode: 0o600 });
    this._gc = setInterval(() => this._cleanup(), 10 * 60_000);
    this._usageTimer = setInterval(() => this.refreshUsage(), 20_000);
    this._usageTimer.unref();
    this.refreshUsage();
    this._gc.unref();
    this.log(`Crewroom hub ${VERSION} listening on ${this.localBase} (${this.rooms.size} room(s))`);
    return this;
  }

  async _listen(port) {
    for (let attempt = 0; attempt < 15; attempt++) {
      const p = port === 0 ? 0 : port + attempt;
      try {
        await new Promise((resolve, reject) => {
          const onErr = (err) => { this.server.off('listening', onOk); reject(err); };
          const onOk = () => { this.server.off('error', onErr); resolve(); };
          this.server.once('error', onErr);
          this.server.once('listening', onOk);
          this.server.listen(p, this.host);
        });
        return this.server.address().port;
      } catch (err) {
        if (err.code !== 'EADDRINUSE' || port === 0) throw err;
        // Our own hub already running there (same home folder)? Then we are not needed.
        const other = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).catch(() => null);
        if (other?.app === 'crewroom' && other.hubId && other.hubId === readJson(hubFile(this.home))?.hubId) {
          const e = new Error(`A Crewroom hub is already running on port ${p}.`);
          e.code = 'HUB_RUNNING';
          throw e;
        }
      }
    }
    throw new Error(`No free port found near ${port}.`);
  }

  /** Read token usage from local app logs (usage.js) and attach it to room members. */
  refreshUsage() {
    if (process.env.CREWROOM_NO_USAGE === '1') return;
    const cutoff = Date.now() - 3 * 3600_000;
    for (const [id, r] of this.statusline) if (r.updatedAt < cutoff) this.statusline.delete(id);
    for (const room of this.rooms.values()) {
      if (room.s.settings.readUsage === false) {
        room.applyUsage([]);
        continue;
      }
      try {
        room.applyUsage(collectUsage(room.projectRoot, { statusline: [...this.statusline.values()] }));
      } catch (err) {
        this.log(`usage read failed for ${room.code}: ${err.message}`);
      }
    }
  }

  _cleanup() {
    // Long: an AI that rests for hours (to save tokens) should find its session still there.
    const cutoff = Date.now() - 24 * 3600_000;
    for (const [sid, s] of this.sessions) {
      if (s.lastUsed < cutoff) {
        s.transport.close().catch(() => {});
        this.sessions.delete(sid);
      }
    }
    for (const [ip, hits] of this.badCodes) if (!hits.some((t) => t > Date.now() - 600_000)) this.badCodes.delete(ip);
  }

  async stop() {
    clearInterval(this._gc);
    clearInterval(this._usageTimer);
    this.tunnel.handle?.stop();
    for (const s of this.sessions.values()) await s.transport.close().catch(() => {});
    for (const room of this.rooms.values()) room.close();
    const info = readJson(hubFile(this.home));
    if (info?.hubId === this.id) fs.rmSync(hubFile(this.home), { force: true });
    await new Promise((resolve) => {
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }

  // ---------------- HTTP ----------------

  _isLocal(req) {
    const ra = req.socket.remoteAddress || '';
    const loopback = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
    const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    return loopback && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'] && LOCAL_HOSTS.has(host);
  }

  _hostAllowed(req) {
    if (!['127.0.0.1', 'localhost', '::1'].includes(this.host)) return true; // LAN mode, the user chose this
    const host = (req.headers.host || '').toLowerCase();
    const bare = host.replace(/:\d+$/, '');
    // Blocks DNS-rebinding: random websites cannot talk to the hub through your browser.
    return LOCAL_HOSTS.has(bare) || (this.publicHost && host === this.publicHost.toLowerCase());
  }

  async _handle(req, res) {
    try {
      if (!this._hostAllowed(req)) return sendText(res, 403, 'Forbidden host.\n');
      await this._route(req, res);
    } catch (err) {
      const status = err instanceof RoomError ? err.status : err.status || 500;
      if (status >= 500) this.log(err.stack || err);
      if (!res.headersSent) sendJson(res, status, { error: err.message });
      else res.end();
    }
  }

  async _route(req, res) {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    const local = this._isLocal(req);

    if (url.pathname === '/health') return sendJson(res, 200, local ? { ok: true, app: 'crewroom', version: VERSION, hubId: this.id, rooms: this.rooms.size } : { ok: true, app: 'crewroom' });

    if (url.pathname === '/') {
      if (!local) return sendText(res, 200, 'Crewroom. Ask your human for an invite link.\n');
      return sendHtml(res, homePage(this));
    }

    if (parts[0] === 'hub') {
      if (!local || req.headers['x-hub-key'] !== this.key) throw new RoomError('Forbidden', 403);
      return this._hubApi(req, res, parts.slice(1));
    }

    if (url.pathname === '/mcp') return this._mcp(req, res, { roomCode: null, local, ...mcpOptions(url) });

    if (parts[0] === 'r' && parts[1]) {
      const room = this.room(parts[1]);
      if (!room) {
        if (!local) this._countBadCode(req);
        throw new RoomError('This room is not open. If you are the human: run "crewroom start" in the project folder.', 404);
      }
      return this._roomRoute(req, res, room, parts.slice(2), url, local);
    }

    throw new RoomError('Not found.', 404);
  }

  _countBadCode(req) {
    const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress);
    const hits = (this.badCodes.get(ip) || []).filter((t) => t > Date.now() - 600_000);
    hits.push(Date.now());
    this.badCodes.set(ip, hits);
    if (hits.length > 30) throw new RoomError('Too many wrong room codes. Try again later.', 429);
  }

  async _hubApi(req, res, parts) {
    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    const [what, sub] = parts;
    if (what === 'rooms' && req.method === 'GET') return sendJson(res, 200, { rooms: this.listRooms().map((r) => this.links(r)) });
    if (what === 'rooms' && !sub && req.method === 'POST') {
      const room = this.openRoom(body.projectRoot, { name: body.name, resetAccess: !!body.resetAccess });
      return sendJson(res, 200, this.links(room));
    }
    if (what === 'rooms' && sub === 'close') {
      const room = body.code ? this.room(body.code) : this.roomForFolder(body.projectRoot || '');
      if (!room) throw new RoomError('No such room is open.', 404);
      this.closeRoom(room.code);
      return sendJson(res, 200, { closed: room.code });
    }
    if (what === 'usage') {
      // Posted by `crewroom statusline` (Claude Code status line) with Claude Code's own numbers.
      const entry = parseClaudeStatusline(body);
      if (entry.sessionId) this.statusline.set(entry.sessionId, entry);
      this.refreshUsage();
      return sendJson(res, 200, { ok: true });
    }
    if (what === 'tunnel') {
      await this.setTunnel(!!body.on);
      return sendJson(res, 200, { state: this.tunnel.state, url: this.tunnel.url, error: this.tunnel.error, rooms: this.listRooms().map((r) => this.links(r)) });
    }
    if (what === 'shutdown') {
      // Save and close every room before answering, so "crewroom stop" returns only when all data is on disk.
      this.tunnel.handle?.stop();
      for (const room of this.rooms.values()) room.close();
      this.rooms.clear();
      sendJson(res, 200, { ok: true });
      setTimeout(() => this.stop().then(() => process.exit(0)), 50);
      return;
    }
    throw new RoomError('Not found.', 404);
  }

  async _roomRoute(req, res, room, sub, url, local) {
    const isAdmin = (k) => k && k === room.adminKey;

    if (sub.length === 0 || sub[0] === 'join') {
      return sendText(res, 200, inviteText(room, { links: this.links(room), viaPublic: !local }));
    }

    if (sub[0] === 'prompt') {
      if (!isAdmin(url.searchParams.get('key'))) throw new RoomError('Forbidden', 403);
      const name = url.searchParams.get('name') || undefined;
      // ?resume=1: a member continues in a fresh conversation (its token is in the prompt).
      const member = url.searchParams.get('resume') && name ? room.memberByName(name) : undefined;
      if (url.searchParams.get('resume') && !member) throw new RoomError(`No member named "${name}".`, 404);
      return sendText(res, 200, invitePrompt(room, { links: this.links(room), name, role: url.searchParams.get('role') || 'member', member }));
    }

    if (sub[0] === 'dashboard') {
      if (!isAdmin(url.searchParams.get('key'))) return sendText(res, 403, 'Wrong or missing dashboard key. Run "crewroom open" in the project folder to open the dashboard.\n');
      const html = fs.readFileSync(DASHBOARD, 'utf8').replaceAll('__ROOM_CODE__', room.code);
      return sendHtml(res, html);
    }

    if (sub[0] === 'avatar' && sub[1]) {
      const m = room.s.members[decodeURIComponent(sub[1].replace(/\.svg$/, ''))];
      if (!m?.avatar) throw new RoomError('No avatar.', 404);
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' });
      return res.end(avatarSvg(m.avatar));
    }

    if (sub[0] === 'history') {
      if (!isAdmin(url.searchParams.get('key'))) throw new RoomError('Forbidden', 403);
      return sendJson(res, 200, { messages: room.dashboardMessages({ before: Number(url.searchParams.get('before')) || undefined, limit: 100 }) });
    }

    // Always-on API members: added by the human from the dashboard, on this computer only.
    if (sub[0] === 'agents') {
      if (!isAdmin(req.headers['x-admin-key'] || url.searchParams.get('key'))) throw new RoomError('Forbidden', 403);
      if (req.method === 'GET') return sendJson(res, 200, { providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, baseUrl: p.baseUrl, model: p.model, noKey: !!p.noKey })) });
      if (!local) throw new RoomError('API members can only be added on this computer.', 403);
      const body = await readJsonBody(req);
      try {
        return sendJson(res, 200, await room.agents.add(body));
      } catch (err) {
        throw err instanceof RoomError ? err : new RoomError(err.message);
      }
    }

    if (sub[0] === 'log') {
      if (!isAdmin(url.searchParams.get('key'))) throw new RoomError('Forbidden', 403);
      return sendJson(res, 200, await room.call('team_log', HUMAN, { about: url.searchParams.get('q') || undefined, limit: 200 }));
    }

    if (sub[0] === 'taskdiff' && sub[1]) {
      if (!isAdmin(url.searchParams.get('key'))) throw new RoomError('Forbidden', 403);
      const t = room.s.tasks[String(sub[1]).toUpperCase()];
      if (!t) throw new RoomError('No such task.', 404);
      return sendText(res, 200, savedDiff(room.dataDir, t.id) || 'No changes were recorded for this task.');
    }

    if (sub[0] === 'archive' && sub[1]) {
      if (!isAdmin(url.searchParams.get('key'))) throw new RoomError('Forbidden', 403);
      return sendText(res, 200, room.chapterText(sub[1]));
    }

    if (sub[0] === 'events') {
      if (!isAdmin(url.searchParams.get('key'))) throw new RoomError('Forbidden', 403);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      // First push sends recent messages; later pushes only the new ones, so a long chat stays cheap.
      let lastSeq = 0;
      let chapter = room.s.chapter || 1;
      const seenSent = new Map(); // seq -> seen/reactions signature this dashboard has
      const push = () => {
        // A new chapter replaced the chat: start the dashboard's feed over.
        if ((room.s.chapter || 1) !== chapter) {
          chapter = room.s.chapter || 1;
          lastSeq = 0;
        }
        const messages = room.dashboardMessages({ after: lastSeq, limit: lastSeq ? 500 : 200 });
        const reset = lastSeq === 0;
        if (reset) seenSent.clear();
        // "Seen by" and reaction changes on messages the dashboard already has: only what changed.
        const meta = {};
        for (const m of room.s.messages.slice(-500)) {
          const sig = m.seenBy?.length || m.reactions || m.deleted ? `${m.seenBy?.length || 0}|${JSON.stringify(m.reactions || {})}|${m.deleted ? 1 : 0}` : '';
          if (sig === (seenSent.get(m.seq) || '')) continue;
          seenSent.set(m.seq, sig);
          if (m.seq <= lastSeq && !reset) meta[m.seq] = { seenBy: room.seenNames(m) || null, reactions: room.reactionNames(m) || null, deleted: m.deleted || undefined };
        }
        if (messages.length) lastSeq = messages[messages.length - 1].seq;
        else if (reset) lastSeq = room.s.seq;
        res.write(`data: ${JSON.stringify({ ...room.snapshot({ messageLimit: 0 }), messages, meta, reset, links: this.links(room) })}\n\n`);
      };
      let timer = null;
      const onChange = () => { if (!timer) timer = setTimeout(() => { timer = null; push(); }, 120); };
      push();
      room.on('change', onChange);
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      const end = () => { room.off('change', onChange); room.off('closed', end); clearInterval(ping); clearTimeout(timer); res.end(); };
      req.on('close', end);
      room.once('closed', end);
      return;
    }

    if (sub[0] === 'assets' && sub[1] && req.method === 'GET') {
      const a = room.assetFile(sub[1]);
      if (!a || !fs.existsSync(a.file)) throw new RoomError('No such file.', 404);
      const safeName = a.name.replace(/"/g, '');
      // SVG/HTML could run scripts: serve those as downloads, everything else inline.
      const inline = /^image\/(png|jpeg|gif|webp|avif)$|^text\/plain$|^application\/pdf$|^audio\/|^video\//.test(a.mime);
      res.writeHead(200, {
        'content-type': inline || a.mime === 'image/svg+xml' ? a.mime : 'application/octet-stream',
        'content-length': fs.statSync(a.file).size,
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:",
        'x-content-type-options': 'nosniff',
      });
      return fs.createReadStream(a.file).pipe(res);
    }

    if (sub[0] === 'upload' && req.method === 'POST') {
      if (!isAdmin(req.headers['x-admin-key'])) throw new RoomError('Forbidden', 403);
      const buffer = await readBody(req);
      const name = url.searchParams.get('name') || 'upload';
      const result = await room.call('share_file', HUMAN, {
        base64: buffer.toString('base64'), name, mime: req.headers['content-type'],
        message: url.searchParams.get('silent') ? false : url.searchParams.get('message') || `Shared ${name}`, to: url.searchParams.get('to') || undefined,
      });
      return sendJson(res, 200, result);
    }

    if (sub[0] === 'tunnel' && req.method === 'POST') {
      if (!isAdmin(req.headers['x-admin-key']) || !local) throw new RoomError('Forbidden', 403);
      const body = await readJsonBody(req);
      await this.setTunnel(!!body.on);
      return sendJson(res, 200, this.links(room));
    }

    if (sub[0] === 'api' && sub[1]) {
      if (req.method !== 'POST') throw new RoomError('Use POST with a JSON body.', 405);
      const args = await readJsonBody(req);
      const action = sub[1];
      const auth = req.headers.authorization || '';
      const tok = auth.startsWith('Bearer ') ? auth.slice(7).trim() : args.token;
      delete args.token;
      delete args.allowOutside;
      if (action === 'share_file' && local) args.allowOutside = true; // only for apps on this computer
      if (req.headers['x-admin-key']) {
        if (!isAdmin(req.headers['x-admin-key'])) throw new RoomError('Wrong dashboard key.', 403);
        return sendJson(res, 200, await room.call(action, HUMAN, args));
      }
      if (action === 'join') return sendJson(res, 200, await room.call('join', null, { via: local ? 'cli' : 'http (public link)', ...args, token: tok }));
      const member = room.memberByToken(tok);
      if (!member) throw new RoomError('Missing or unknown token. Join first.', 401);
      // A CLI wait that gets killed (e.g. a background command) must not swallow messages.
      if (action === 'wait') {
        const ac = new AbortController();
        res.on('close', () => { if (!res.writableEnded) ac.abort(); });
        args.signal = ac.signal;
      }
      const result = JSON.stringify(await room.call(action, member, args));
      room.account(member, JSON.stringify(args).length, result.length);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(result);
    }

    if (sub[0] === 'mcp') return this._mcp(req, res, { roomCode: room.code, local, ...mcpOptions(url) });

    throw new RoomError('Not found.', 404);
  }

  async _mcp(req, res, { roomCode, local, profile, defaultWait }) {
    const sid = req.headers['mcp-session-id'];
    let body;
    if (req.method === 'POST') {
      const raw = await readBody(req);
      try {
        body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
      } catch {
        return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      }
    }

    if (sid) {
      const s = this.sessions.get(sid);
      if (!s) return sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
      s.lastUsed = Date.now();
      return s.transport.handleRequest(req, res, body);
    }

    const initializing = req.method === 'POST' && (Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body));
    const server = createMcpServer({ hub: this, roomCode, local, profile, defaultWait });
    let transport;
    if (initializing) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => this.sessions.set(id, { transport, server, lastUsed: Date.now() }),
      });
      transport.onclose = () => { if (transport.sessionId) this.sessions.delete(transport.sessionId); };
    } else {
      // Clients without sessions: answer statelessly (tools accept a token).
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    }
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}

// ---------------- helpers ----------------

/** ?profile=lite and ?wait=<seconds> on the MCP URL (set by `crewroom connect` per app). */
function mcpOptions(url) {
  const profile = ['lite', 'minimal'].includes(url.searchParams.get('profile')) ? url.searchParams.get('profile') : undefined;
  const wait = Number(url.searchParams.get('wait'));
  return { profile, defaultWait: Number.isFinite(wait) && wait > 0 ? wait : undefined };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new RoomError('Request too large.', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try {
    const v = JSON.parse(raw.toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new RoomError('Body must be JSON.');
  }
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj, null, 2));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function sendHtml(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
  res.end(html);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function homePage(hub) {
  const rooms = hub.listRooms().map((r) => {
    const l = hub.links(r);
    const s = r.snapshot({ messageLimit: 0 });
    const online = s.members.filter((m) => m.status !== 'offline').length;
    return `<li><a href="${esc(l.dashboard)}"><b>${esc(r.s.name)}</b></a> <span class="m">${esc(r.code)} · ${s.members.length} member(s), ${online} active · ${esc(r.projectRoot)}</span></li>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Crewroom</title>
<style>:root{--bg:#f6f7f9;--fg:#1d2228;--m:#6b7480;--a:#3b6fd8}@media (prefers-color-scheme:dark){:root{--bg:#111418;--fg:#e6e9ed;--m:#8d96a1;--a:#6b9bff}}
body{margin:0;padding:32px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:760px;margin:auto}a{color:var(--a)}li{margin:10px 0}.m{color:var(--m);font-size:13px;display:block}code{background:rgba(127,127,127,.15);padding:1px 5px;border-radius:4px}</style></head>
<body><main><h1>Crewroom</h1><p class="m">Hub ${esc(VERSION)} on ${esc(hub.localBase)} · public link: ${esc(hub.tunnel.state)}</p>
<h2>Open rooms</h2>${rooms ? `<ul>${rooms}</ul>` : '<p class="m">No rooms yet. Run <code>crewroom start</code> in a project folder.</p>'}
<h2>Connect your AI apps (once)</h2><p>Run <code>crewroom connect</code> in a terminal. It sets up Claude desktop, Claude Code, Codex, Antigravity, Cursor, Windsurf, VS Code and Gemini CLI.</p></main></body></html>`;
}
