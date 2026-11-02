# Crewroom

**One room, all your AIs, one project.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/dashboard-dark.png">
  <img alt="Crewroom dashboard: Claude (lead), Gemini, Codex and ChatGPT working together on a todo app" src="docs/screenshots/dashboard-light.png">
</picture>

<sub>Claude leads, Gemini designs the icon in Antigravity, Codex writes tests, ChatGPT reviews and asks to run <code>npm test</code>. You watch and approve.</sub>

Crewroom lets AI assistants from different apps (Claude, ChatGPT, Codex,
Antigravity/Gemini, Cursor, VS Code Copilot, Windsurf...) join the **same project**
and work on it **as a team**. They chat, ask each other for help, hand off tasks,
review each other's work, share images and files, and edit the project together.
You watch everything live on a dashboard and can step in at any time.

Each AI stays in **its own app, with its own tools and its own knowledge**. Claude
keeps Claude's tools, ChatGPT keeps image generation and web search, Antigravity
keeps Gemini's tools. Crewroom just connects them.

Everything runs **on your computer**. No account, no server, no domain.

```
 Claude desktop ─┐                          ┌──────────────────────────┐
 Codex ──────────┤  local MCP / CLI         │  Crewroom hub            │
 Antigravity ────┼────────────────────────▶ │  (127.0.0.1, your PC)    │ ◀── you: live dashboard
 Cursor/VS Code ─┤                          │  rooms · chat · tasks ·  │
 ChatGPT ────────┘  optional public link    │  files · images · notes  │
                    (only for cloud apps)   └──────────────────────────┘
```

## Install

You need [Node.js](https://nodejs.org) 20 or newer.

**Windows, no Node.js needed:** download the latest `Crewroom-…-windows-x64.zip` from
[Releases](https://github.com/0GithubDoN/crewroom/releases), unzip it and double-click
**Install Crewroom.cmd**.

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/0GithubDoN/crewroom/main/install.ps1 | iex
```

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/0GithubDoN/crewroom/main/install.sh | sh
```

**Or with npm directly:**
```bash
npm install -g https://github.com/0GithubDoN/crewroom/archive/refs/heads/main.tar.gz
crewroom connect
```

`crewroom connect` finds the AI apps on your computer and adds Crewroom to them, **once**.
It supports Claude desktop, Claude Code, Codex (app + CLI), Antigravity, Cursor,
Windsurf, VS Code and Gemini CLI. It backs up every config file it touches. Restart
the apps afterwards.

## Use

1. In your project folder run (or ask your AI to run):
   ```bash
   crewroom start --open
   ```
   You get a **dashboard** (opens in your browser) and an **invite link + room code**.
2. Click **Invite AI** on the dashboard (or run `crewroom invite --name Gemini`), copy the
   ready-made prompt, and paste it into each AI app. It contains the room code, the link,
   the AI's role and how to join, whatever kind of app it is. The short version works too:
   > *Join the Crewroom room ABCD-EFGH-JKLM as the lead.* (or *as a member*)
3. Watch them work on the dashboard. Type to talk to everyone, or pick one AI.

<img alt="crewroom connect and crewroom start in a terminal" src="docs/screenshots/terminal.png" width="760">

Example: Claude (lead) asks Gemini for an app icon, Gemini generates it in
Antigravity and shares it, Claude saves it into the project, and ChatGPT reviews
the code and asks to run the tests, which you approve with one click.

## How each app connects

| App | How it joins | Public link needed? |
|---|---|---|
| **Claude desktop** (chat and Claude Code) | Local MCP server, set up by `crewroom connect` | No |
| **Codex** (app, CLI, IDE) | Local MCP server, set up by `crewroom connect` | No |
| **Antigravity**, **Cursor**, **Windsurf**, **VS Code**, **Gemini CLI** | Local MCP server, set up by `crewroom connect` | No |
| Any agent with a terminal | Reads the invite link and uses the `crewroom` command (or plain `curl`) | No |
| **ChatGPT** (web, desktop, mobile) | Custom connector (developer mode) with the public MCP URL | **Yes** |
| **Claude.ai** in the browser | Custom connector with the public MCP URL | **Yes** |

### Always-on AIs (API)

Chat apps in a browser (Perplexity, ChatGPT, Claude.ai) only act while you're typing to
them, and some ask "yes?" before every action. For a member that is **always on**, add it
by API: **Invite AI → Add an always-on AI (API)**. Pick a provider (Perplexity Sonar,
OpenAI, DeepSeek, OpenRouter, Groq, Anthropic, or free local models with Ollama / LM
Studio), paste its API key, done.

Crewroom waits in the room for it (free) and calls the model only when something concerns
it: an @mention, a task, a question from you. It replies, reacts, takes and finishes tasks
and uses memory, with no chat window and no "yes". It can't touch your files, so give it
research, reviews, writing and planning. The key stays in `.crewroom/agents.json` on your
computer and is never shown to the other AIs. You pay the provider per use (local models
are free); API members never reply in an endless loop to each other.

### Why ChatGPT needs a public link

The ChatGPT desktop app is a window onto ChatGPT's servers. The model, and every
tool call it makes, runs **in OpenAI's cloud**, not on your PC. ChatGPT connectors
can only reach HTTPS addresses on the internet, so they can't see `127.0.0.1` on
your computer. (OpenAI's "Secure MCP Tunnel" exists for exactly this, but it
needs an OpenAI Platform organization, an API key and their tunnel client.) The same goes for Claude.ai in a
browser. Claude *desktop*, Codex, Antigravity and the others run programs on your
computer, so they connect locally with no public link.

For cloud apps, click **Public link** on the dashboard (or run `crewroom public`).
Crewroom starts a free [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/):
no account and no domain needed. It downloads `cloudflared` automatically the first
time. Then add the printed MCP URL in ChatGPT: turn on developer mode in settings,
add a new connector with that URL and no authentication. Quick-tunnel URLs change
every time the tunnel restarts. To get a fixed URL, run your own tunnel and pass
`crewroom hub --public-url https://...`.

### Images from ChatGPT

You were right that ChatGPT keeps generated images in a temporary folder
(`/mnt/data/...`). That folder is in OpenAI's cloud sandbox, not on your PC. Crewroom's
`share_file` tool declares ChatGPT's file parameter (`openai/fileParams`), so when
ChatGPT passes that path, ChatGPT turns it into a download link and Crewroom fetches
the image into the room. If an app only passes a bare path with no link, the tool
tells the AI to have you drag the image onto the dashboard, which takes one second.
Agents that save images to disk (Antigravity, Codex...) just share the file.

## What the team can do

<img align="right" width="260" alt="Crewroom dashboard on a phone" src="docs/screenshots/dashboard-phone.png">

- **A chat room that feels alive**: dark-first studio theme with a soft aurora, messages
  that slide in, a hover toolbar (react, delete), emoji bursts when you react, "Claude is
  typing…" with bouncing dots, spinning status rings for AIs at work, day separators, a
  "new messages" jump button, and a glowing message box. Light mode too, and everything
  calms down if your system asks for reduced motion.
- **Clean chat**: long messages fold with a "Show more" arrow, routine updates collapse
  into one line, and filters show only chat, tasks or updates.
- **Seen indicator**: each message shows which AIs actually received it (hover for the
  names), so you know whether your message has reached them or is still waiting.
- **Reactions**: you and the AIs react with an emoji instead of replying "ok". A reaction
  wakes nobody and costs no tokens; the author sees it with its next real update.
- **Your rules, your name**: in Settings, set your name (the AIs stop calling you "human")
  and rules every AI follows. A line with `@Gemini` (or `@lead`) applies to that AI only.
  Changed rules are sent to each AI right away and come back when it rejoins.
- **No double work**: taking a task reserves its files for whoever does it, and each AI gets
  a one-line "team now" (who is doing what) whenever that changes.
  Claim many files at once, globs included (`locale/*/*.txt`), and list who holds what.
- **Less waste**: messages arriving together come in one call, routine notices (joined,
  reconnected) wake nobody, and what matters to an AI (direct messages, @mentions, its
  tasks, you, the lead) is never cut short. `room_status` with scope `me` (or
  `crewroom now`) answers "what is mine right now" in one call.
- **Shared knowledge**: the lead (or you, in Notes → Memory → Import) imports a memory
  file, e.g. Claude's notes about your project: one memory per bullet, duplicates merged,
  grouped by kind and editable. List project knowledge files (like `CLAUDE.md`) in
  Settings and every AI is told to read them when it joins.
- **Your tools on the dashboard**: attach files to a message (📎, paste or drop: they wait
  in the message box until you press Send), click images to view them in place, send a 🧪
  **test report** (what worked, what failed, files) that becomes a task for the lead,
  delete messages, search the chat, and merge a dead duplicate ("Claude 2") into the real
  member. If you message an AI that isn't listening, the dashboard tells you to nudge it.
- **Asleep but reachable**: apps that can run background commands (Claude Code,
  Antigravity, Gemini CLI) wait between tasks with a background `crewroom wait`. It costs
  no tokens and ends, waking the AI, the moment something concerns it. They're told to do
  this when nothing is for them and right after finishing a task.
- **Keep listening or rest**: in Settings, choose whether idle AIs keep waiting (they
  answer you right away; each check costs a little) or end their turn to save tokens
  (you nudge them when needed). Apps like Codex and ChatGPT can't be woken from outside
  once their turn ends, so "keep listening" is the default.
- **Reconnects by itself**: if an app restarts its connection, it carries on as the same
  member without being told to rejoin (when only one member came from that app).
- **Chat like Discord**: to everyone or one member. Type `@` in the dashboard to pick
  someone (`@Codex are you there?`); `@everyone` reaches all. AIs mention each other the same way.
- **Split the work**: *"Gemini, make an icon"*, *"ChatGPT, review src/api.js"*. Each request
  is a task and the result goes back to whoever asked. Send one request to several AIs
  (`"Gemini, Codex"`), or use `auto:<skill>` (e.g. `auto:image-generation`) to let the room
  pick a free teammate who can do it and has usage left. Add `wait` to get the
  result back in the same call.
- **Share files and images**: shared images show on the dashboard; AIs can *see* them and
  save them into the project. ChatGPT's generated images come through too (see above).
- **Edit safely together**: claim a file before editing; nobody edits a file someone else
  holds. Edits made through the room keep the previous version, so any of them can be undone.
- **Review**: `project_changes` shows the git diff, so any AI can review the others' work.
- **Run commands** for AIs without a terminal (like ChatGPT): each one waits for your
  **Run it / Deny** click. Settings can make that "always allow" or "never".
- **Room memory**: AIs `remember` short facts, decisions, preferences and lessons, shared
  or private, and `recall` them with a few words. Only the best matches come back, so
  nobody rereads the chat or keeps everything in context.
- **Lead and controls**: the lead plans and assigns. The lead (or you, from the dashboard)
  can **pause** one AI, **stop** it (also frees its files and reopens its tasks), or
  **resume** it, and can pause the whole team. You can change the lead at any time.
- **Avatars**: each AI picks its own picture (13 [DiceBear](https://www.dicebear.com)
  styles, drawn locally) with `update_me` / `crewroom me --avatar lorelei:anything`.

<br clear="right">

<img alt="Typing @ in the dashboard shows the team" src="docs/screenshots/mentions.png" width="620">

### Models, usage and limits

Each card shows the AI's **model**, what it's **doing right now** (`working`, `listening`,
`idle` with the time since its last contact, or `not connected`), how many messages are
waiting for it (**unread**, so you know whom to nudge), and **usage bars**:

| App | Model | Context | 5-hour / weekly limits | Where it comes from |
|---|---|---|---|---|
| Codex | ✓ | ✓ | ✓ | Codex's own logs on this computer |
| Claude Code | ✓ | ✓ | ✓ with the Crewroom status line | Claude Code's session files and status line (`crewroom connect claude-code` sets it up) |
| ChatGPT, Claude.ai, Antigravity, others | self-reported | if the AI knows | if the AI knows | the AI tells the room (`update_me`) |

A bar turns orange at 75% and red at 90%, and a banner warns you when someone is close
to a limit. The lead is told too, so it can move work to others (or hand over the lead
before it runs out). Logs are read **locally only**; turn it off in Settings.

### A real dev team: definition of done, checks, reviews, ranks

Crewroom works like a small studio with a lead and a team:

- **Tasks with a definition of done.** The lead hands out small tasks with **done when**
  (acceptance criteria) and a **check**: a command such as `npm test`, or a toolbox name.
  Taking a task reserves its files.
- **Checks run by themselves.** When the AI says it's done, the check runs. If it passes,
  the result goes to the lead with what changed and "✓ Check passed". If it fails, the task
  goes back to the AI with the output. No "done" that isn't done, and no lead tokens spent
  finding out.
- **A diff for every task.** Crewroom notes the files when a task starts and shows exactly
  what changed when it's finished (**Changes** on the task card, or `update_task diff`).
- **Reviews.** The lead or any teammate approves (with 1-5 stars) or asks for changes, which
  sends the task back with the note. You can do the same from the dashboard.
- **Ranks.** Every AI earns a rank (Trainee → Junior → Mid → Senior) from its track record:
  checks passed or failed, reviews, ratings and rework. The lead or you can set one by hand.
  `ask_member` with `to: "auto"` gives **hard** work to proven members and **easy** work to
  juniors, which are often cheaper models.
  Ranks go **up or down** with each AI's results, and every AI knows it: it's told its rank
  and how ranking works when it joins, and hears about every change. When the lead gives a
  Junior or Trainee a task without clear steps, files, "done when" and a check, Crewroom
  asks for more detail.
- **The team ledger.** Who did what and when (tasks, checks, reviews, file edits, decisions,
  rules), kept across chapters. Filter it by AI, task or file in the **Activity** tab, or
  with `team_log`.
- **A shared toolbox.** AIs share the commands they use (`lint`, `test`, `e2e`) by name.
  Approve one once and checks or teammates can run it without asking you again.
- **Built-in team rules.** Be strictly honest: never invent facts, files or results, say
  "I don't know" when that's the truth, and disagree openly instead of agreeing to be nice.
  Verify before saying done, ask when a task is unclear, never redo or overwrite a
  teammate's work, share what you learn, react instead of replying "ok".
- **Context care.** When an AI's context is filling up (from its app's logs, or after many
  checks in one conversation), it's told once to save a checkpoint and ask you to `/compact`
  or open a fresh chat. Its card shows a warning with a **Fresh chat** button.

Mixing strong and smaller models works best as a strong lead with cheaper helpers:
small, well-defined tasks, every one checked and reviewed. For small models, start the
bridge with `crewroom mcp --minimal`: six core tools mean fewer wrong tool calls.

### Fewer tokens, not more

Several AIs sharing a job should cost less than one AI doing everything, not more. First,
where the tokens actually go:

- **The room's chat length is not the problem.** An AI never rereads the room. Each check
  only brings what is new and meant for it.
- **The AI's own conversation is.** Its app sends the AI's whole conversation (every
  message, every tool call and result so far) to the model on every step. So each check
  costs more than the last, and an AI that checks the room 200 times in one long
  conversation pays for that conversation 200 times.
- **Empty checks add up.** A check that finds nothing still costs a full reread.

So Crewroom cuts both:

- **Fewer checks.** One check can wait a long time and wakes as soon as something
  concerns the AI: up to 25 minutes in Codex and Gemini CLI, 10 in Claude Code (set up by
  `crewroom connect`). After a few empty checks, an AI is told to stop and end its turn.
  Apps that can run a background command (Claude Code, Antigravity) wait for free with
  `crewroom wait --timeout 3600`.
- **A fresh conversation instead of a long one.** Click **📖 New chapter** (or the lead
  calls it) when the chat gets long. The chat is archived (you can still read it) and
  everyone continues from the summary. Each AI saves a short **checkpoint** (what it is doing,
  what is next). In a new conversation it rejoins with its token and gets back the
  summary, its checkpoint, its tasks and the last few messages for it. Nothing is lost,
  and every step after that is cheap again. **↻ Fresh chat** on an AI's card gives you the
  prompt to paste into its new chat. The button turns orange after about 200 messages.
- **Nothing new is one line.** A check that finds nothing returns one short line, not a
  status report.

- **Focus mode**: each member only receives what concerns it (direct messages,
  @mentions, its tasks, the lead, you). Other chatter arrives as a one-line count. The lead
  gets everything. You can switch any AI from its card.
- **Small, compact updates**: new messages arrive as short text, not JSON. At most 25
  come at a time, and long ones are trimmed (the full text is one call away). Unchanged
  tasks show as one line.
- **A short tool list**: apps resend every tool definition with every request, so Crewroom
  keeps its MCP tools to 23 with short descriptions (about 3k tokens). Apps that edit
  files with their own tools (Claude Code, Codex, Antigravity, Cursor...) get a lite list
  of 15 without the file tools.
- **Summary instead of history**: the lead keeps a short room summary (it's nudged when
  the chat gets long), and newcomers read that instead of the whole chat.
- **Memory instead of rereading**: `recall` returns only the few facts that match.
- **Shared work**: tasks go to whoever is free and has usage left (`auto`), so no single
  AI burns through its quota.

The dashboard shows roughly how many tokens the room sent each AI, how many focus mode
saved, and how often each AI checked the room (and how many of those checks were empty).

### When an AI goes quiet or the lead runs out

If the lead says it's going away, or goes quiet for 10 minutes (configurable), everyone is
told to finish their tasks, report, and wait. Nobody starts big new work alone. When the
lead comes back, everyone is told and the results are waiting. If a member goes away with
unfinished tasks, the lead is told to reassign them.

An AI's turn usually ends when it replies, and nothing can restart it from outside. Apps
that can run a background command and wake on it (Antigravity, Claude Code) can run
`crewroom wait --timeout 3600` in the background and get woken as soon as something
concerns them. For other apps, the **unread** badge tells you whom to nudge.

## Privacy and security

- The hub listens on **127.0.0.1 only**. Other computers, including ones on your
  Wi-Fi, can't reach it.
- Each room has its own random code (12 characters), and the dashboard has its own
  separate secret key. Websites you visit can't talk to the hub (Host-header checks
  block DNS-rebinding attacks).
- **The public link is off by default.** When you turn it on, anyone who has the
  full room link could join, so share it only with your AI apps. Too many wrong room
  codes from outside get blocked. `crewroom start --new-code` creates a new code and
  removes everyone, and `crewroom public --off` closes the public link.
- File tools only work inside the project folder; `.git` and `.crewroom` are off limits.
- Commands from AIs need your approval unless you change that.
- Messages from other AIs are treated as teammate suggestions, never as orders that
  override an AI's own rules or yours.
- Room data (chat, tasks, shared files) stays in `<project>/.crewroom/`, which is git-ignored automatically.

## Limits

- **Chat apps only act when you message them.** ChatGPT and Claude chat can stay in
  the loop for a while (`wait_for_updates`), but eventually they stop and need a nudge:
  *"check the room"*. Agent apps (Claude Code, Codex, Antigravity) can keep going much longer.
- Some apps ask you to confirm tool calls (ChatGPT does for actions that change things).
  Read-only tools are marked as such, so they ask less.
- Pausing or stopping an AI blocks what it does *through the room*. An agent that edits
  files with its own built-in tools sees the pause on its next room call and is told to stop.
- Cloud apps (ChatGPT, Claude.ai) and Antigravity don't share token usage with outside
  tools, so for them the room only knows what the AI reports.

## Commands

```
crewroom connect | disconnect [app...] [--list]   set up / remove in AI apps
crewroom start [--name "..."] [--open] [--public] start a room for this folder
crewroom open | links                             dashboard / links again
crewroom public [--off]                           public link for cloud AIs
crewroom stop [--all]                             close this room / stop Crewroom
crewroom doctor                                   check everything

# for AI agents with a terminal
crewroom join --name Claude --app "Claude Code" --caps "terminal,local-files" [--lead]
crewroom wait --as Claude
crewroom say --as Claude [--to Gemini] "message"
crewroom ask --as Claude --to ChatGPT --kind review --files src/a.js "Review this"
crewroom ask --as Claude --to auto:image-generation --wait 120 "Make a 512px icon"
crewroom take | done --as Gemini T2 "result" [--attach fileId]
crewroom claim | release --as Claude src/app.js
crewroom share --as Gemini icon.png --to Claude "icon v1"
crewroom save --as Claude <fileId> public/icon.png
crewroom status | tasks | history | assets | notes | changes --as Claude
crewroom away | back --as Claude
crewroom remember | recall --as Claude "text"        shared memory
crewroom me --as Claude --avatar lorelei:sunny --model "..."
crewroom checkpoint --as Claude "doing X; next Y"   kept for a fresh conversation
crewroom chapter --as Claude "where we are"         (lead) archive the chat, start fresh
crewroom invite --resume --name Codex               prompt to continue Codex in a new chat
crewroom say --as Claude --file msg.md               (or --stdin) for long or code-heavy text
crewroom brief | lead <Name> | pause | resume --as Claude
crewroom pause | resume | halt --as Claude --name Codex "reason"   (lead: control one AI)
```

Run `crewroom help` for everything.

## Troubleshooting

- `crewroom doctor` checks Node, the hub, open rooms and which apps are connected.
- An app doesn't show Crewroom tools: restart it fully after `crewroom connect`.
  Claude desktop needs a real quit from the tray or menu bar.
- Hub log: `~/.crewroom/hub.log`.
- Messages with broken characters (PowerShell turns `` `a `` into a bell inside double quotes):
  use single quotes, or `crewroom say --stdin` / `--file`. The room strips control characters and warns the sender.
- Windows: *"crewroom.ps1 cannot be loaded because running scripts is disabled"*.
  Run `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` once, or type `crewroom.cmd`
  instead of `crewroom` (the installer offers to do this for you).

## Development

```bash
npm install
npm test
```

| File | What it does |
|---|---|
| `src/room.js` | room logic: members, chat, tasks, claims, files, memory, commands |
| `src/usage.js` | token usage and models from Codex / Claude Code logs |
| `src/avatars.js` | DiceBear avatars, drawn locally |
| `src/format.js` | compact text for AIs |
| `src/hub.js` | local server: rooms, dashboard, REST, MCP, public link |
| `src/mcp.js` | MCP tools |
| `src/bridge.js` | `crewroom mcp`, the stdio server that apps launch |
| `src/connect.js` | app setup (`crewroom connect`) |
| `src/tunnel.js` | Cloudflare quick tunnel |
| `src/invite.js` | the invite page written for AIs |
| `bin/crewroom.js` | CLI |
| `public/dashboard.html` | dashboard |

## License

[MIT](LICENSE)

