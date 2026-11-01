// `crewroom mcp`: a stdio MCP server that apps launch locally (Claude desktop,
// Codex, Antigravity, Cursor, VS Code, Gemini CLI...). It forwards everything
// to the local hub's /mcp endpoint, starting the hub if needed, and reconnects
// transparently if the hub restarts.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { ensureHub } from './client.js';
import { homeDir } from './util.js';

const REINIT_ID = '__crewroom_reinit__';
const REJOIN_ID = '__crewroom_rejoin__';
const CHUNK_SECONDS = Number(process.env.CREWROOM_WAIT_CHUNK) || 270; // env: tests only
const KEEPALIVE_MS = Number(process.env.CREWROOM_KEEPALIVE_MS) || 20_000; // env: tests only
const log = (...a) => process.stderr.write(`[crewroom] ${a.join(' ')}\n`);

export async function runBridge({ home = homeDir(), lite = false, minimal = false, wait } = {}) {
  const query = new URLSearchParams();
  if (minimal) query.set('profile', 'minimal');
  else if (lite) query.set('profile', 'lite');
  if (wait) query.set('wait', String(wait));
  const qs = query.size ? `?${query}` : '';
  const pending = new Map(); // internal request id -> resolve
  const longWaits = new Map(); // app request id -> { current internal id, cancelled }
  // While a wait is open, a small progress signal every 20s tells apps that honour it not to
  // time the call out. It costs no tokens: nothing reaches the model until the wait returns.
  const keepAlive = new Map(); // app request id -> interval
  const startKeepAlive = (msg) => {
    const token = msg.params?._meta?.progressToken;
    if (token === undefined || keepAlive.has(msg.id)) return;
    let n = 0;
    keepAlive.set(msg.id, setInterval(() => {
      stdio.send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++n, message: 'waiting for the team' } }).catch(() => {});
    }, KEEPALIVE_MS));
  };
  const stopKeepAlive = (id) => {
    clearInterval(keepAlive.get(id));
    keepAlive.delete(id);
  };
  const stdio = new StdioServerTransport();
  let http = null;
  let initRequest = null;
  let initialized = false;
  let reconnecting = null;
  let token = null; // remembered from join_room, so a reconnect restores the member identity
  const joinIds = new Set();

  const connect = async () => {
    const info = await ensureHub({ home });
    const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${info.port}/mcp${qs}`));
    t.onmessage = (m) => {
      if (m.id === REINIT_ID || m.id === REJOIN_ID) return;
      if (pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
        return;
      }
      if (keepAlive.has(m.id)) stopKeepAlive(m.id);
      if (joinIds.has(m.id)) {
        joinIds.delete(m.id);
        try {
          token = JSON.parse(m.result?.content?.[0]?.text || '{}').your_token || token;
        } catch {}
      }
      stdio.send(m).catch(() => {});
    };
    t.onerror = (err) => log('connection:', err.message);
    await t.start();
    return t;
  };

  const reconnect = () => {
    reconnecting ||= (async () => {
      log('hub connection lost, reconnecting...');
      await http?.close().catch(() => {});
      http = await connect();
      if (initRequest) await http.send({ ...initRequest, id: REINIT_ID });
      if (initialized) await http.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      if (token) await http.send({ jsonrpc: '2.0', id: REJOIN_ID, method: 'tools/call', params: { name: 'join_room', arguments: { token, name: 'rejoin' } } });
    })().finally(() => { reconnecting = null; });
    return reconnecting;
  };

  const send = async (msg) => {
    try {
      if (reconnecting) await reconnecting;
      await http.send(msg);
    } catch (err) {
      await reconnect();
      await http.send(msg);
    }
  };
  const request = (msg) => new Promise((resolve, reject) => {
    pending.set(msg.id, resolve);
    send(msg).catch((err) => {
      pending.delete(msg.id);
      reject(err);
    });
  });

  // One long wait for the app = several shorter calls to the hub (each HTTP request must end
  // within ~5 minutes). Empty answers in between are swallowed: the app is only woken once.
  const longWait = async (msg, seconds) => {
    const deadline = Date.now() + Math.min(seconds, 3600) * 1000;
    const state = { id: null, cancelled: false };
    longWaits.set(msg.id, state);
    try {
      for (let n = 0; ; n++) {
        const chunk = Math.max(1, Math.min(Math.ceil((deadline - Date.now()) / 1000), CHUNK_SECONDS));
        state.id = `__crewroom_wait_${msg.id}_${n}`;
        const reply = await request({ ...msg, id: state.id, params: { ...msg.params, arguments: { ...msg.params.arguments, timeout_seconds: chunk } } });
        if (state.cancelled) return;
        const text = reply.result?.content?.[0]?.text || '';
        if (reply.error || reply.result?.isError || !text.startsWith('nothing new') || deadline - Date.now() < 500) {
          await stdio.send({ ...reply, id: msg.id });
          return;
        }
      }
    } finally {
      longWaits.delete(msg.id);
      stopKeepAlive(msg.id);
    }
  };

  const forward = async (msg) => {
    if (msg.method === 'notifications/cancelled' && longWaits.has(msg.params?.requestId)) {
      const state = longWaits.get(msg.params.requestId);
      state.cancelled = true;
      msg = { ...msg, params: { ...msg.params, requestId: state.id } };
    }
    if (msg.method === 'tools/call' && msg.params?.name === 'wait_for_updates') {
      startKeepAlive(msg);
      const seconds = Number(msg.params.arguments?.timeout_seconds ?? wait ?? 45);
      if (seconds > CHUNK_SECONDS) return longWait(msg, seconds);
    }
    if (isInitializeRequest(msg)) initRequest = msg;
    if (msg.method === 'tools/call' && msg.params?.name === 'join_room') joinIds.add(msg.id);
    if (msg.method === 'notifications/initialized') initialized = true;
    try {
      if (reconnecting) await reconnecting;
      await http.send(msg);
    } catch (err) {
      if (msg === initRequest) throw err;
      await reconnect();
      await http.send(msg);
    }
  };

  http = await connect();
  stdio.onmessage = (msg) => {
    forward(msg).catch((err) => {
      log('request failed:', err.message);
      if (msg.id !== undefined) {
        stdio.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `Crewroom hub unreachable: ${err.message}` } }).catch(() => {});
      }
    });
  };
  const quit = () => {
    http?.close().catch(() => {});
    process.exit(0);
  };
  stdio.onclose = quit;
  process.stdin.on('end', quit);
  await stdio.start();
}
