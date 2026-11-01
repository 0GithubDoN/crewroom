// Always-on members driven by an API (Perplexity, OpenAI, DeepSeek, OpenRouter, Groq, local
// Ollama / LM Studio, Anthropic). The hub waits in the room for them, which costs nothing, and
// calls the model only when something concerns them: no chat window, no "yes" prompts.

import fs from 'node:fs';
import path from 'node:path';
import { formatWait } from './format.js';

export const PROVIDERS = {
  perplexity: { label: 'Perplexity (Sonar API)', baseUrl: 'https://api.perplexity.ai', model: 'sonar', caps: ['web-search', 'research'] },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', caps: [] },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', caps: [] },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', caps: [] },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', caps: [] },
  ollama: { label: 'Ollama (local, free)', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1', caps: [], noKey: true },
  lmstudio: { label: 'LM Studio (local, free)', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', caps: [], noKey: true },
  anthropic: { label: 'Anthropic (Claude API)', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5', caps: [], anthropic: true },
  custom: { label: 'Other OpenAI-compatible API', baseUrl: '', model: '', caps: [] },
};

const MIN_GAP_MS = 4000; // between two calls of the same member
const HISTORY = 10; // recent messages it already saw, for continuity

const INSTRUCTIONS = `You are a member of a Crewroom: several AI assistants and their human work on one project together.
You only see what is in this prompt (no files, no terminal). You are called when something concerns you.
Answer with ONE JSON object and nothing else:
{"say": [{"text": "...", "to": "name (optional, default everyone)"}],
 "react": [{"seq": 12, "emoji": "👍"}],
 "take": ["T3"],
 "done": [{"task": "T3", "result": "what you did or found", "status": "done|blocked"}],
 "remember": ["a short fact the team should keep"]}
Every field is optional; {} means nothing to do. Rules: be strictly honest, never invent facts, files or results, and say when you do not know.
Do not agree just to be nice. Keep messages short. React instead of replying "ok". Do not reply to messages that do not need you.
Only take tasks you can do from here (research, review of text you were given, writing, planning).`;

export class AgentRunner {
  constructor(room, { log = () => {} } = {}) {
    this.room = room;
    this.log = log;
    this.loops = new Map(); // memberId -> { stop }
    this.keysFile = path.join(room.dataDir, 'agents.json');
    // A removed (kicked or merged) member stops, and its key is deleted.
    room.on('change', () => {
      for (const id of [...this.loops.keys()]) if (!room.s.members[id]) this.remove(id);
    });
  }

  _keys() {
    try { return JSON.parse(fs.readFileSync(this.keysFile, 'utf8')); } catch { return {}; }
  }

  _saveKey(memberId, apiKey) {
    const keys = this._keys();
    if (apiKey) keys[memberId] = apiKey; else delete keys[memberId];
    fs.mkdirSync(path.dirname(this.keysFile), { recursive: true });
    fs.writeFileSync(this.keysFile, JSON.stringify(keys, null, 2), { mode: 0o600 });
  }

  /** Human: add an always-on member. Returns its public info (never the key). */
  async add({ name, provider = 'custom', model, baseUrl, apiKey, capabilities, lead = false }) {
    const preset = PROVIDERS[provider];
    if (!preset) throw new Error(`Unknown provider "${provider}".`);
    const url = String(baseUrl || preset.baseUrl || '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) throw new Error('A base URL (https://...) is required for this provider.');
    if (!apiKey && !preset.noKey) throw new Error('An API key is required for this provider.');
    const mdl = String(model || preset.model || '').trim();
    if (!mdl) throw new Error('Pick a model.');
    const caps = capabilities ? String(capabilities).split(',').map((c) => c.trim()).filter(Boolean) : preset.caps;
    const r = await this.room.call('join', null, { name, app: `${preset.label} API`, model: mdl, capabilities: caps, via: 'api (always on)', lead, listen: 'focus' });
    const member = this.room.memberByToken(r.your_token);
    member.agent = { provider, model: mdl, baseUrl: url, calls: 0, tokensIn: 0, tokensOut: 0 };
    // Start at the current message: answering old history would cost API money for nothing.
    member.cursor = this.room.s.seq;
    this._saveKey(member.id, apiKey || '');
    this.room._changed('member');
    this.start(member.id);
    return { name: member.name, provider, model: mdl };
  }

  remove(memberId) {
    this.stop(memberId);
    this._saveKey(memberId, null);
  }

  startAll() {
    for (const m of Object.values(this.room.s.members)) if (m.agent) this.start(m.id);
  }

  stopAll() {
    for (const id of [...this.loops.keys()]) this.stop(id);
  }

  stop(memberId) {
    const l = this.loops.get(memberId);
    if (l) l.stop();
    this.loops.delete(memberId);
  }

  start(memberId) {
    if (this.loops.has(memberId)) return;
    let stopped = false;
    const ac = new AbortController();
    this.loops.set(memberId, { stop: () => { stopped = true; ac.abort(); } });
    (async () => {
      let lastCall = 0;
      let failures = 0;
      let agentStreak = 0; // turns in a row triggered only by other API members
      while (!stopped && !this.room._closed) {
        const member = this.room.s.members[memberId];
        if (!member?.agent) break;
        let update;
        try {
          // Waiting in the room costs nothing; the model is only called when something concerns it.
          update = await this.room.call('wait', member, { timeout_seconds: 280, signal: ac.signal });
        } catch (err) {
          if (stopped || this.room._closed) break;
          await sleep(2000);
          continue;
        }
        if (stopped) break;
        if (update.quiet || member.paused || this.room.s.paused) continue;
        if (!update.new_messages.length && !update.your_tasks?.length) continue;
        // Two API members must not ping-pong forever: after a few turns started only by other
        // API members (no human, no task, nobody else), stay quiet until someone else speaks.
        const fromAgents = update.new_messages.every((m) => this.room.memberByName(m.from)?.agent);
        agentStreak = fromAgents && !update.your_tasks?.length ? agentStreak + 1 : 0;
        if (agentStreak > 3) continue;
        const wait = lastCall + MIN_GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
        lastCall = Date.now();
        try {
          await this._turn(member, update);
          failures = 0;
        } catch (err) {
          failures++;
          this.log(`agent ${member.name}: ${err.message}`);
          if (failures === 1 || failures % 10 === 0) {
            this.room._system(`⚠ ${member.name} (API) could not answer: ${String(err.message).slice(0, 300)}`, 'human');
          }
          await sleep(Math.min(60_000, 3000 * 2 ** Math.min(failures, 5)));
        }
      }
    })();
  }

  _prompt(member, update) {
    const room = this.room;
    const snap = room.snapshot({ messageLimit: 0 });
    const seen = room.s.messages.filter((m) => !m.deleted && m.seq < (update.new_messages[0]?.seq ?? Infinity) && room._relevantFor(member, m) && room._concerns(member, m)).slice(-HISTORY);
    const parts = [
      `Room: ${snap.name}. You are "${member.name}" (${member.agent.model}), rank ${room._rankOf(member).title}.`,
      `The human is ${room._nameOf('human')}. Lead: ${snap.lead?.name || 'none'}. Members: ${snap.members.map((m) => `${m.name} (${m.app})`).join(', ')}.`,
      snap.brief ? `Brief: ${snap.brief}` : '',
      snap.summary?.text ? `Summary so far: ${snap.summary.text}` : '',
      room._rulesFor(member).length ? `Room rules: ${room._rulesFor(member).join(' | ')}` : '',
      seen.length ? `Earlier messages (already seen):\n${seen.map((m) => `#${m.seq} ${room._nameOf(m.from)}: ${m.text.slice(0, 600)}`).join('\n')}` : '',
      `NOW:\n${formatWait(update)}`,
    ];
    return parts.filter(Boolean).join('\n\n');
  }

  async _turn(member, update) {
    const a = member.agent;
    const apiKey = this._keys()[member.id];
    const preset = PROVIDERS[a.provider] || {};
    const prompt = this._prompt(member, update);
    member.phase = 'working';
    member.lastAction = 'thinking';
    this.room._changed('member');
    const { text, usage } = preset.anthropic
      ? await callAnthropic(a, apiKey, prompt)
      : await callOpenAI(a, apiKey, prompt);
    a.calls = (a.calls || 0) + 1;
    a.tokensIn = (a.tokensIn || 0) + (usage.in || 0);
    a.tokensOut = (a.tokensOut || 0) + (usage.out || 0);
    await this._apply(member, text);
    member.phase = 'listening';
    this.room._changed('member');
  }

  async _apply(member, text) {
    const room = this.room;
    const plan = parsePlan(text);
    const tryCall = async (action, args) => {
      try { await room.call(action, member, args); } catch (err) { this.log(`agent ${member.name} ${action}: ${err.message}`); }
    };
    for (const r of plan.react || []) if (r?.seq && r?.emoji) await tryCall('react', { seq: r.seq, emoji: r.emoji });
    for (const id of plan.take || []) await tryCall('take_task', { task_id: id });
    for (const d of plan.done || []) if (d?.task) await tryCall('finish_task', { task_id: d.task, result: d.result || '', status: d.status === 'blocked' ? 'blocked' : 'done' });
    for (const f of plan.remember || []) if (f) await tryCall('remember', { text: String(f) });
    for (const m of plan.say || []) {
      if (!m?.text || !String(m.text).trim()) continue;
      await tryCall('send', { text: String(m.text).slice(0, 8000), to: m.to || undefined });
    }
  }
}

/** The model's JSON plan; plain text (a model that ignored the format) becomes one message. */
export function parsePlan(text) {
  const raw = String(text || '').trim();
  const fenced = raw.replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(fenced.slice(start, end + 1));
      if (obj && typeof obj === 'object') {
        if (typeof obj.say === 'string') obj.say = [{ text: obj.say }];
        return obj;
      }
    } catch {}
  }
  return raw ? { say: [{ text: raw.slice(0, 4000) }] } : {};
}

async function callOpenAI(a, apiKey, prompt) {
  const res = await fetch(`${a.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model: a.model, messages: [{ role: 'system', content: INSTRUCTIONS }, { role: 'user', content: prompt }], temperature: 0.3 }),
    signal: AbortSignal.timeout(180_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${data.error?.message || data.message || res.statusText}`);
  const text = data.choices?.[0]?.message?.content || '';
  return { text, usage: { in: data.usage?.prompt_tokens, out: data.usage?.completion_tokens } };
}

async function callAnthropic(a, apiKey, prompt) {
  const res = await fetch(`${a.baseUrl}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: a.model, max_tokens: 2000, system: INSTRUCTIONS, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(180_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${data.error?.message || res.statusText}`);
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { text, usage: { in: data.usage?.input_tokens, out: data.usage?.output_tokens } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
