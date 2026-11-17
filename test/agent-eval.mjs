// Real-agent evaluation: an agent CLI completes everyday browser tasks using only Foxwright's
// tools, and an independent verifier checks the result in the browser.
//
//   node test/agent-eval.mjs [--agent claude|codex|opencode|qwen] [--trusted | --ask] [--only REGEX] [--model NAME] [--max-turns N] [--repeat N]
//
//   --agent    which agent CLI runs the tasks (default claude). codex = OpenAI's Codex CLI
//              (`codex exec`), opencode = OpenCode (`opencode run`, any provider, e.g.
//              --model deepseek/deepseek-flash), qwen = Qwen Code (`qwen`; --model deepseek/<model>
//              uses DeepSeek's OpenAI-compatible API with DEEPSEEK_API_KEY, anything else the
//              OPENAI_* variables). All are locked down so only Foxwright's tools can reach the web:
//              Claude without Bash, WebFetch, WebSearch, file tools, agents and Claude in Chrome;
//              Codex without its shell, browser, computer use, apps and web search (its code mode
//              has no network APIs) (read-only sandbox, your config.toml ignored); OpenCode with a
//              temporary config (your opencode.json and plugins ignored) denying bash, edit,
//              webfetch, websearch, task and skill; Qwen Code with a temporary HOME whose settings
//              register no built-in tools (no shell, web fetch, files or subagents). --max-turns
//              applies to Claude only.
//
//   --trusted  real input through WebDriver BiDi
//   --ask      Foxwright in "ask" mode: a scripted user answers every permission window (one-time
//              approval; Deny for the sites a task lists in `deny`). Adds the ask-only tasks.
//   --repeat N run every task N times and report pass@1 and pass@N
//
// Browser and agent on different machines (keep Firefox in Docker, the agent CLI and its login
// on your computer):
//   host:      FOXWRIGHT_AGENT_RUNNER_TOKEN=<secret> node test/agent-eval.mjs --serve 7801 --container <name>
//   container: FOXWRIGHT_AGENT_RUNNER_TOKEN=<secret> node test/agent-eval.mjs --runner http://host.docker.internal:7801 --agent ...
// The container runs Firefox, the harness and the verifiers; for each task it asks the host to run
// the agent CLI, whose Foxwright MCP server is started inside the container with `docker exec`, so
// the agent can only reach that Firefox. The host listens on 127.0.0.1 and runs one agent at a time.
//
// Uses the same throwaway-Firefox harness as the other tests (FOXWRIGHT_E2E_BUILD=store for the
// add-ons store build). Writes test/results/agent-eval-<mode>.{json,md} and one transcript per task.
// Exits 1 if any task failed. A full Claude run costs roughly $4 with Opus 5.5 (2026-11-08); less
// with a cheaper --model.
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TASKS } from './agent-tasks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TRUSTED = flag('--trusted');
const ASK = flag('--ask');
if (TRUSTED && ASK) {
  console.error('--ask needs the debugging port for its scripted user, so it only works without --trusted.');
  process.exit(2);
}
const ONLY = opt('--only') ? new RegExp(opt('--only'), 'i') : null;
let MODEL = opt('--model');
let MAX_TURNS = opt('--max-turns', '40');
const REPEAT = Number(opt('--repeat', '1'));
const CLAUDE = opt('--claude', 'claude');
let AGENT = opt('--agent', 'claude');
const SERVE = opt('--serve');
const CONTAINER = opt('--container');
const RUNNER = opt('--runner');
const TOKEN = process.env.FOXWRIGHT_AGENT_RUNNER_TOKEN || '';
const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex CLI', opencode: 'OpenCode', qwen: 'Qwen Code' };
if (!AGENT_NAMES[AGENT]) {
  console.error(`--agent must be one of ${Object.keys(AGENT_NAMES).join(', ')}.`);
  process.exit(2);
}
const AGENT_NAME = AGENT_NAMES[AGENT];
const agentCmd = (agent) => (agent === 'claude' ? CLAUDE : agent);
// Ask-only tasks need permission windows (e.g. one the scripted user denies).
const selectedTasks = TASKS.filter(task => (!ONLY || ONLY.test(task.id)) && (ASK || !task.askOnly));
// Reports and transcripts keep their old names for Claude, so earlier results stay comparable.
const MODE = (AGENT === 'claude' ? '' : `${AGENT}-`) + (TRUSTED ? 'trusted' : 'synthetic') + (ASK ? '-ask' : '');
const outDir = path.join(root, 'test', 'results');
const transcriptDir = path.join(outDir, 'agent');

const FOXWRIGHT_TOOLS = ['tabs_context_mcp', 'tabs_create_mcp', 'tabs_close_mcp', 'navigate', 'read_page', 'find', 'form_input', 'computer', 'get_page_text', 'javascript_tool', 'handle_dialog', 'read_console_messages', 'read_network_requests', 'resize_window', 'file_upload', 'browser_batch', 'gif_creator', 'upload_image'];
// Everything else is off, so the agent can't route around the browser (e.g. with WebFetch).
const BLOCKED = ['Bash', 'WebFetch', 'WebSearch', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Task', 'Agent', 'NotebookEdit'];

const helpCache = {};
function cliHelp(agent) {
  if (helpCache[agent] == null) {
    // Some CLIs (OpenCode) print their help on stderr.
    const r = spawnSync(agentCmd(agent), ['--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    helpCache[agent] = r.error || r.status !== 0 ? false : `${r.stdout}\n${r.stderr}`;
  }
  return helpCache[agent];
}

// { command, args, env } of the Foxwright MCP server the agent starts. Set per repetition (and,
// on a --serve host, per request, wrapped in `docker exec`).
let mcpServer = null;
const BROWSER_HINT = 'Do the task in the web browser using the Foxwright tools. Do not answer from memory. Leave task tabs open for the independent verifier; the test harness closes them after checking your work.';
const newMetrics = () => ({ calls: [], toolCalls: {}, toolErrors: 0, resultChars: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, seen: new Set(), idToTool: {}, final: null });
function countResult(m, tool, parts) {
  const r = m.resultChars[tool] || (m.resultChars[tool] = { chars: 0, images: 0 });
  for (const p of parts) {
    if (p.type === 'text')
      r.chars += (p.text || '').length;
    else if (p.type === 'image')
      r.images++;
  }
}
function recordCall(m, name, input, isError, parts) {
  name = String(name).replace(/^(mcp__)?foxwright(__|_|\.)/, '');
  m.toolCalls[name] = (m.toolCalls[name] || 0) + 1;
  m.calls.push({ name, input: input || {}, isError, resultText: parts.filter(p => p.type === 'text').map(p => p.text || '').join('\n') });
  if (isError)
    m.toolErrors++;
  countResult(m, name, parts);
}

/** Spawn an agent CLI, write its JSONL to the transcript and feed each event to onEvent(ev, m). */
function spawnAgent(cmd, args, opts, transcriptPath, onEvent) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // PWD too: OpenCode takes its project folder from it, not from the process's working directory.
    const env = { ...(opts.env || process.env), ...(opts.cwd ? { PWD: opts.cwd } : {}) };
    const child = spawn(cmd, args, { ...opts, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = fs.createWriteStream(transcriptPath);
    let buf = '', stderr = '';
    const m = newMetrics();
    const onLine = (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      onEvent(ev, m);
    };
    child.stdout.on('data', (d) => {
      out.write(d);
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (e) => {
      stderr += String(e);
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 8 * 60 * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf.trim())
        onLine(buf);
      out.end();
      resolve({ code, ms: Date.now() - t0, stderr, m });
    });
  });
}

/**
 * Claude Code's stream-json (Qwen Code writes the same format). Calls are recorded when their
 * result arrives, with the result text and error flag the feature verifiers check.
 */
function onClaudeStreamEvent(ev, m) {
  if (ev.type === 'assistant' && ev.message) {
    const msg = ev.message;
    for (const c of msg.content || []) {
      if (c.type === 'tool_use')
        m.idToTool[c.id] = { name: c.name, input: c.input };
    }
    if (msg.usage && !m.seen.has(msg.id)) {
      m.seen.add(msg.id);
      m.usage.input += msg.usage.input_tokens || 0;
      m.usage.output += msg.usage.output_tokens || 0;
      m.usage.cacheRead += msg.usage.cache_read_input_tokens || 0;
      m.usage.cacheWrite += msg.usage.cache_creation_input_tokens || 0;
    }
  } else if (ev.type === 'user' && ev.message) {
    for (const c of ev.message.content || []) {
      if (c.type !== 'tool_result')
        continue;
      const call = m.idToTool[c.tool_use_id] || { name: '?', input: {} };
      const parts = Array.isArray(c.content) ? c.content : [{ type: 'text', text: String(c.content ?? '') }];
      recordCall(m, call.name, call.input, !!c.is_error, parts);
    }
  } else if (ev.type === 'result') {
    m.final = ev;
  }
}

function runClaude(prompt, transcriptPath) {
  const help = cliHelp('claude') || '';
  const strict = help.includes('--strict-mcp-config');
  const mcpConfig = path.join(os.tmpdir(), `foxwright-agent-eval-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { foxwright: mcpServer } }));
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--mcp-config', mcpConfig, '--max-turns', MAX_TURNS,
    '--allowedTools', 'mcp__foxwright', ...FOXWRIGHT_TOOLS.map(t => `mcp__foxwright__${t}`), '--disallowedTools', ...BLOCKED];
  if (strict)
    args.push('--strict-mcp-config');
  if (help.includes('--no-chrome'))
    args.push('--no-chrome'); // make sure the agent uses Foxwright, not Claude in Chrome
  args.push('--append-system-prompt', 'Do the task in the web browser using the Foxwright tools (mcp__foxwright__*). Do not answer from memory. Leave task tabs open for the independent verifier; the test harness closes them after checking your work.');
  if (MODEL)
    args.push('--model', MODEL);
  const env = { ...process.env };
  delete env.CLAUDECODE; // allow launching from inside a Claude Code terminal
  return spawnAgent(CLAUDE, args, { env, cwd: os.tmpdir() }, transcriptPath, onClaudeStreamEvent)
    .finally(() => fs.rmSync(mcpConfig, { force: true }));
}

const tomlStr = (v) => JSON.stringify(String(v)); // TOML basic strings use JSON-compatible escapes
function runCodex(prompt, transcriptPath) {
  const s = mcpServer;
  const envTable = '{' + Object.entries(s.env).map(([k, v]) => `${k}=${tomlStr(v)}`).join(', ') + '}';
  // code_mode_host stays on: Codex calls MCP tools through it, and its JavaScript has no fetch,
  // XMLHttpRequest, WebSocket, require or imports (checked 2026-11-08, codex-cli 0.161.0).
  // plugins and remote_plugin: an installed plugin's MCP servers (e.g. Notion) still started under
  // --ignore-user-config (codex-cli 0.161.0, 2026-11-16). hooks: the user's hooks. multi_agent: subagents.
  const off = ['shell_tool', 'unified_exec', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'apps', 'in_app_browser', 'image_generation', 'skill_search', 'tool_suggest',
    'plugins', 'remote_plugin', 'skill_mcp_dependency_install', 'hooks', 'multi_agent'];
  const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '-s', 'read-only',
    '-c', 'web_search="disabled"', ...off.flatMap(f => ['--disable', f]),
    '-c', `mcp_servers.foxwright.command=${tomlStr(s.command)}`,
    '-c', `mcp_servers.foxwright.args=[${s.args.map(tomlStr).join(', ')}]`,
    '-c', `mcp_servers.foxwright.env=${envTable}`,
    '-c', 'mcp_servers.foxwright.startup_timeout_sec=30',
    '-c', 'mcp_servers.foxwright.tool_timeout_sec=180',
    '-c', 'mcp_servers.foxwright.default_tools_approval_mode="approve"', // headless: nobody can approve calls (Foxwright's own permission windows still apply)
    '-C', os.tmpdir()];
  if (MODEL)
    args.push('-m', MODEL);
  args.push(`${BROWSER_HINT}\n\n${prompt}`);
  let lastMessage = '';
  return spawnAgent('codex', args, { cwd: os.tmpdir() }, transcriptPath, (ev, m) => {
    const it = ev.item;
    if (ev.type === 'item.completed' && it) {
      if (it.type === 'agent_message')
        lastMessage = it.text || '';
      else if (it.type === 'mcp_tool_call' && it.server === 'foxwright') {
        const content = [...(it.result?.content || []), ...(it.error ? [{ type: 'text', text: String(it.error.message ?? it.error) }] : [])];
        recordCall(m, it.tool || it.name, it.arguments, it.status === 'failed' || !!it.error || !!it.result?.isError || !!it.result?.is_error, content);
      }
    } else if (ev.type === 'turn.completed' && ev.usage) {
      m.usage.input += (ev.usage.input_tokens || 0) - (ev.usage.cached_input_tokens || 0);
      m.usage.cacheRead += ev.usage.cached_input_tokens || 0;
      m.usage.output += (ev.usage.output_tokens || 0) + (ev.usage.reasoning_output_tokens || 0);
    }
    m.final = { result: lastMessage };
  });
}

function runOpencode(prompt, transcriptPath) {
  // A throwaway config folder: the user's opencode.json, AGENTS.md and plugins are not loaded.
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwright-opencode-'));
  fs.mkdirSync(path.join(xdg, 'opencode'));
  // File tools are off too: the tasks need none, and the agent shouldn't read the folder it runs in.
  const deny = ['bash', 'edit', 'write', 'patch', 'webfetch', 'websearch', 'codesearch', 'task', 'skill', 'read', 'glob', 'grep', 'list'];
  fs.writeFileSync(path.join(xdg, 'opencode', 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    mcp: { foxwright: { type: 'local', command: [mcpServer.command, ...mcpServer.args], environment: mcpServer.env, enabled: true, timeout: 30000 } },
    permission: { bash: 'deny', edit: 'deny', read: 'deny', glob: 'deny', grep: 'deny', list: 'deny', webfetch: 'deny', websearch: 'deny', codesearch: 'deny', external_directory: 'deny' },
    tools: Object.fromEntries(deny.map(t => [t, false])),
  }));
  const args = ['run', '--pure', '--format', 'json', '--title', `foxwright-eval ${path.basename(transcriptPath, '.jsonl')}`];
  if (MODEL)
    args.push('-m', MODEL);
  args.push(`${BROWSER_HINT}\n\n${prompt}`);
  const texts = new Map(); // part id -> text (parts can be re-sent as they grow)
  let cost = 0;
  const p = spawnAgent('opencode', args, { cwd: os.tmpdir(), env: { ...process.env, XDG_CONFIG_HOME: xdg } }, transcriptPath, (ev, m) => {
    const part = ev.part || {};
    if (part.type === 'tool') {
      const st = part.state || {};
      if ((st.status === 'completed' || st.status === 'error') && !m.seen.has(part.id || part.callID)) {
        m.seen.add(part.id || part.callID);
        recordCall(m, part.tool, st.input, st.status === 'error', [{ type: 'text', text: String(st.output ?? st.error ?? '') }]);
      }
    } else if (part.type === 'text') {
      texts.set(part.id || texts.size, part.text || '');
    } else if (part.type === 'step-finish') {
      const t = part.tokens || {};
      m.usage.input += t.input || 0;
      m.usage.output += (t.output || 0) + (t.reasoning || 0);
      m.usage.cacheRead += t.cache?.read || 0;
      m.usage.cacheWrite += t.cache?.write || 0;
      cost += part.cost || 0;
    }
    m.final = { result: [...texts.values()].pop() || '', total_cost_usd: cost };
  });
  return p.finally(() => fs.rmSync(xdg, { recursive: true, force: true }));
}

// Every built-in Qwen Code tool (0.15.3, ToolNames in its cli.js). `core` names none of them, so
// none is registered; `exclude` is the second lock. MCP tools are not affected by either.
const QWEN_BUILTINS = ['run_shell_command', 'web_fetch', 'web_search', 'read_file', 'write_file', 'edit', 'list_directory', 'glob', 'grep_search', 'save_memory', 'todo_write', 'agent', 'skill', 'lsp', 'exit_plan_mode', 'ask_user_question', 'cron_create', 'cron_list', 'cron_delete'];
function runQwen(prompt, transcriptPath) {
  // A throwaway HOME: the user's ~/.qwen settings, memory, skills and MCP servers are not loaded.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwright-qwen-'));
  const work = path.join(home, 'work');
  fs.mkdirSync(path.join(home, '.qwen'));
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(home, '.qwen', 'settings.json'), JSON.stringify({
    security: { auth: { selectedType: 'openai' }, folderTrust: { enabled: false } },
    tools: { core: ['__none__'], exclude: QWEN_BUILTINS },
    mcpServers: { foxwright: { ...mcpServer, trust: true, timeout: 180000 } }, // trust: headless runs can't confirm calls
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false },
    general: { disableAutoUpdate: true, disableUpdateNag: true },
  }));
  const env = { ...process.env, HOME: home };
  let model = MODEL;
  if (/^deepseek\//.test(model || '')) {
    model = model.slice('deepseek/'.length);
    Object.assign(env, { OPENAI_API_KEY: process.env.DEEPSEEK_API_KEY || '', OPENAI_BASE_URL: 'https://api.deepseek.com' });
  }
  if (model)
    env.OPENAI_MODEL = model;
  const args = ['--auth-type', 'openai', '--allowed-mcp-server-names', 'foxwright', '-o', 'stream-json', '--chat-recording', 'false', `${BROWSER_HINT}\n\n${prompt}`];
  return spawnAgent('qwen', args, { cwd: work, env }, transcriptPath, onClaudeStreamEvent)
    .finally(() => fs.rmSync(home, { recursive: true, force: true }));
}

const runLocal = (prompt, transcriptPath) => ({ codex: runCodex, opencode: runOpencode, qwen: runQwen }[AGENT] || runClaude)(prompt, transcriptPath);

/** Ask the --serve host to run the agent (see the header). Same result shape as a local run. */
function runRemote(prompt, transcriptPath) {
  const body = JSON.stringify({ agent: AGENT, model: MODEL || null, maxTurns: MAX_TURNS, prompt, mcp: mcpServer });
  return new Promise((resolve) => {
    const fail = (stderr) => resolve({ code: -1, ms: 0, stderr, m: newMetrics() });
    const req = http.request(new URL('/run', RUNNER), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
      });
      res.on('end', () => {
        if (res.statusCode !== 200)
          return fail(`agent runner: HTTP ${res.statusCode} ${buf.slice(0, 300)}`);
        const r = JSON.parse(buf);
        fs.writeFileSync(transcriptPath, r.transcript || '');
        resolve({ code: r.code, ms: r.ms, stderr: r.stderr, m: { ...newMetrics(), ...r.m } });
      });
    });
    req.on('error', e => fail(`agent runner unreachable: ${e.message}`));
    req.end(body);
  });
}

const runAgent = (prompt, transcriptPath) => (RUNNER ? runRemote : runLocal)(prompt, transcriptPath);

/** --serve: run agent CLIs for an evaluation whose Firefox runs in Docker container CONTAINER. */
function serve() {
  if (!CONTAINER || TOKEN.length < 16) {
    console.error('--serve needs --container <docker container> and FOXWRIGHT_AGENT_RUNNER_TOKEN (16+ characters).');
    process.exit(2);
  }
  const docker = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
  execFileSync(docker, ['inspect', CONTAINER], { stdio: 'ignore' }); // fails if the container doesn't exist
  let queue = Promise.resolve();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => {
      queue = queue.then(async () => {
        const reply = (status, obj) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (req.method !== 'POST' || req.url !== '/run' || req.headers.authorization !== `Bearer ${TOKEN}`)
          return reply(403, { error: 'forbidden' });
        let b;
        try {
          b = JSON.parse(raw);
        } catch {
          return reply(400, { error: 'bad json' });
        }
        const s = b.mcp || {};
        const envOk = s.env && Object.entries(s.env).every(([k, v]) => /^FOXWRIGHT_[A-Z_]+$/.test(k) && typeof v === 'string');
        if (!AGENT_NAMES[b.agent] || !envOk || !Array.isArray(s.args) || s.args.length !== 2 || !/\/foxwright\.mjs$/.test(s.args[0]) || s.args[1] !== 'mcp' || typeof b.prompt !== 'string')
          return reply(400, { error: 'unexpected request' });
        if (!cliHelp(b.agent))
          return reply(500, { error: `the ${AGENT_NAMES[b.agent]} CLI isn't installed on the host` });
        AGENT = b.agent;
        MODEL = b.model || undefined;
        MAX_TURNS = String(b.maxTurns || MAX_TURNS);
        mcpServer = { command: docker, args: ['exec', '-i', ...Object.entries(s.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), CONTAINER, s.command, ...s.args], env: {} };
        const transcript = path.join(os.tmpdir(), `foxwright-agent-run-${process.pid}-${Date.now()}.jsonl`);
        process.stdout.write(`${new Date().toISOString()} ${AGENT_NAMES[AGENT]}${MODEL ? ` (${MODEL})` : ''}: ${b.prompt.replace(/\s+/g, ' ').slice(0, 70)}…`);
        const run = await runLocal(b.prompt, transcript);
        process.stdout.write(` ${Math.round(run.ms / 1000)} s, ${run.m.calls.length} tool calls, exit ${run.code}\n`);
        const { seen, idToTool, ...m } = run.m;
        reply(200, { code: run.code, ms: run.ms, stderr: run.stderr, m, transcript: fs.readFileSync(transcript, 'utf8') });
        fs.rmSync(transcript, { force: true });
      }).catch((e) => {
        res.writeHead(500);
        res.end(String(e));
      });
    });
  });
  server.listen(Number(SERVE), '127.0.0.1', () => console.log(`Agent runner on 127.0.0.1:${SERVE}; Foxwright MCP servers start in container ${CONTAINER}.`));
}

/**
 * A scripted person at the permission window: "Allow this session" for every site except those the
 * current task lists in `deny`, which get "Deny". Logs each window it answered.
 */
function scriptedUser(driver) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let stopped = false;
  let deny = [];
  const log = [];
  const done = new Set();
  (async () => {
    while (!stopped) {
      try {
        const w = (await driver.contexts()).find(x => x.url.includes('/prompt/prompt.html') && !done.has(x.context));
        if (w) {
          const info = await driver.readWindow(w);
          const button = deny.some(d => info.origin.includes(d)) ? 'deny' : 'once';
          await driver.answer(button, w);
          done.add(w.context);
          log.push({ origin: info.origin, title: info.title, button });
        }
      } catch { /* window closed meanwhile */ }
      await sleep(250);
    }
  })();
  return { stop: () => { stopped = true; }, setDeny: (list) => { deny = list || []; }, log };
}

async function main() {
  if (!RUNNER && !cliHelp(AGENT)) {
    console.error(`Can't run the ${AGENT_NAME} CLI (${agentCmd(AGENT)}). Install it and log in first.`);
    process.exit(1);
  }
  if (RUNNER && TOKEN.length < 16) {
    console.error('--runner needs FOXWRIGHT_AGENT_RUNNER_TOKEN, the same value as the --serve host.');
    process.exit(2);
  }
  fs.mkdirSync(transcriptDir, { recursive: true });
  const { start } = await import('./harness.mjs');
  const { connectDriver } = await import('./bidi-driver.mjs');
  const uploadFile = path.join(os.tmpdir(), 'foxwright-agent-upload.txt');
  fs.writeFileSync(uploadFile, 'Uploaded by an AI agent through Foxwright.\n');
  console.log(`Foxwright agent evaluation: ${AGENT_NAME} + Foxwright (${TRUSTED ? 'trusted' : 'synthetic'}${ASK ? ', ask' : ''} input, ${process.env.FOXWRIGHT_E2E_BUILD || 'full'} build)${MODEL ? `, model ${MODEL}` : ''}${RUNNER ? `, agent on ${RUNNER}` : ''}`);
  const rows = [];
  let approvalCount = 0;
  // Each repetition gets a fresh Firefox profile, approvals and isolated helper HOME.
  for (let rep = 0; rep < REPEAT; rep++) {
    // Synthetic runs give Firefox a debugging port the agent's MCP server doesn't use: the verifiers
    // read page state through it (the store build has no javascript_tool) and --ask's scripted user
    // presses the permission window's buttons. In trusted mode the agent's MCP server holds Firefox's
    // only WebDriver BiDi session, so the verifiers use javascript_tool (full build) or the fixture
    // pages' probe.
    const h = await start({ testDriver: !TRUSTED, pageEval: true, policy: ASK ? { mode: 'ask', confirmUploads: true, allowedReadOnly: [`http://localhost:${process.env.FOXWRIGHT_P1}`] } : undefined });
    const env = { FOXWRIGHT_HOME: path.join(h.home, '.foxwright'), ...(TRUSTED && h.bidiUrl ? { FOXWRIGHT_BIDI_URL: h.bidiUrl } : { FOXWRIGHT_TRUSTED: '0' }) };
    mcpServer = { command: process.execPath, args: [path.join(root, 'host/dist/foxwright.mjs'), 'mcp'], env };
    const driver = TRUSTED ? null : await connectDriver(h.bidiUrl);
    if (driver)
      h.useDriver(driver);
    const user = ASK ? scriptedUser(driver) : null;
    const v = async (name, args = {}) => h.call(name, args);
    const groupTabs = async () => {
      const r = await v('tabs_context_mcp', {});
      return [...r.text.matchAll(/tabId (\d+): ("(?:[^"\\]|\\.)*") (\S+)( \(active)?/g)].map(x => ({ id: +x[1], title: JSON.parse(x[2]), url: x[3], active: !!x[4] }));
    };
    const resetTabs = async () => {
      for (const t of await groupTabs())
        await v('tabs_close_mcp', { tabId: t.id });
    };

    try {
      for (const task of selectedTasks) {
        await resetTabs();
        const prompt = task.prompt.replace('__UPLOAD_FILE__', uploadFile).replaceAll('__LOCAL__', `http://127.0.0.1:${process.env.FOXWRIGHT_P1}`).replaceAll('__READ_ONLY__', `http://localhost:${process.env.FOXWRIGHT_P1}`).replaceAll('__OTHER__', `http://b.test:${process.env.FOXWRIGHT_P1}`);
        const transcript = path.join(transcriptDir, `${MODE}-${task.id}${REPEAT > 1 ? `-${rep + 1}` : ''}.jsonl`);
        process.stdout.write(`  … ${task.id}`);
        user?.setDeny(task.deny);
        const promptsBefore = user ? user.log.length : 0;
        const run = await runAgent(prompt, transcript);
        user?.setDeny([]);
        const answer = String(run.m.final?.result ?? '');
        const tabs = await groupTabs();
        const active = tabs.find(t => t.active) || tabs[tabs.length - 1];
        const ctx = {
          answer,
          inspectFixture: async (pathname, expression) => {
            const matches = (url) => {
              try {
                const u = new URL(url);
                return ['localhost', '127.0.0.1'].includes(u.hostname) && u.pathname === pathname;
              } catch {
                return false;
              }
            };
            if (driver) {
              const context = (await driver.contexts()).find(c => matches(c.url));
              if (!context) throw new Error(`Fixture not open: ${pathname}`);
              return JSON.parse(await driver.evalIn(context.context, `JSON.stringify(${expression})`));
            }
            const t = tabs.find(x => matches(x.url));
            if (!t) throw new Error(`Fixture not open: ${pathname}`);
            return h.pageEval(t.id, expression);
          },
          inspectAll: async (pathname, expression) => {
            // Every open page with this path (e.g. two product pages in two tabs), through the driver.
            if (!driver) throw new Error('inspectAll needs the test driver (synthetic input)');
            const out = [];
            for (const c of await driver.contexts()) {
              try {
                const u = new URL(c.url);
                if (['localhost', '127.0.0.1'].includes(u.hostname) && u.pathname === pathname)
                  out.push(JSON.parse(await driver.evalIn(c.context, `JSON.stringify(${expression})`)));
              } catch { /* not a page */ }
            }
            return out;
          },
          prompts: user ? user.log.slice(promptsBefore) : [], // permission windows during this task
          calls: run.m.calls, // [{ name, input, isError, resultText }] tool calls the agent made, in order
          tabs: async () => tabs,
          texts: async () => {
            let all = '';
            for (const t of tabs) {
              const r = await v('get_page_text', { tabId: t.id });
              if (!r.isError)
                all += '\n' + r.text;
            }
            return all;
          },
          outline: async (filter = 'all', tabId) => ((tabId ?? active?.id) != null ? (await v('read_page', { tabId: tabId ?? active.id, filter, max_chars: 400000 })).text : ''),
          js: async (code, urlRe) => {
            const t = (urlRe && tabs.find(x => urlRe.test(x.url))) || active;
            if (!t)
              return 'null';
            try {
              return await h.js(t.id, code); // javascript_tool on the full build, the test driver on the store build
            } catch {
              return 'null';
            }
          },
        };
        let ok = false, verifyError = null;
        try {
          ok = !!(await task.verify(ctx));
        } catch (e) {
          verifyError = e.message;
        }
        const f = run.m.final || {};
        const u = f.usage ? { input: f.usage.input_tokens || 0, output: f.usage.output_tokens || 0, cacheRead: f.usage.cache_read_input_tokens || 0, cacheWrite: f.usage.cache_creation_input_tokens || 0 } : run.m.usage;
        const row = {
          id: task.id, rep: rep + 1, ok, ms: run.ms, turns: f.num_turns ?? null, cost: f.total_cost_usd ?? null,
          tools: run.m.toolCalls, toolCalls: Object.values(run.m.toolCalls).reduce((a, b) => a + b, 0), toolErrors: run.m.toolErrors,
          resultChars: run.m.resultChars, usage: u, answer: answer.slice(0, 400), exit: run.code, verifyError,
          prompts: ctx.prompts.map(p => `${p.button} ${p.origin}`),
          stderr: run.stderr.slice(-400), hitTurnLimit: /max_turns/.test(String(f.subtype || '')),
        };
        rows.push(row);
        fs.writeFileSync(path.join(outDir, `agent-eval-${MODE}.json`), JSON.stringify(rows, null, 2));
        const tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
        process.stdout.write(`\r  ${ok ? '✓' : '✗'} ${task.id.padEnd(17)} ${(run.ms / 1000).toFixed(0).padStart(4)}s  ${String(row.toolCalls).padStart(3)} tool calls  ${Math.round(tokens / 1000)}k tokens${row.cost != null ? `  $${row.cost.toFixed(3)}` : ''}${row.hitTurnLimit ? '  (hit turn limit)' : ''}${run.code ? `  (exit ${run.code})` : ''}\n`);
        if (!ok)
          console.log(`      answer: ${answer.replace(/\s+/g, ' ').slice(0, 220) || '(none)'}${verifyError ? `\n      verify error: ${verifyError}` : ''}${run.code && run.stderr ? `\n      stderr: ${run.stderr.trim().slice(-200)}` : ''}`);
      }
    } finally {
      approvalCount += user ? user.log.length : 0;
      user?.stop();
      driver?.close();
      await h.stop();
    }
  }

  // ----- summary -----
  const passed = rows.filter(r => r.ok).length;
  // With --repeat: pass@1 = share of all runs that passed; pass@N = share of tasks passed at least once.
  const taskIds = [...new Set(rows.map(r => r.id))];
  const passAtN = taskIds.filter(id => rows.some(r => r.id === id && r.ok)).length;
  const allPass = taskIds.filter(id => rows.filter(r => r.id === id).every(r => r.ok)).length;
  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
  const byTool = {};
  for (const r of rows)
    for (const [t, x] of Object.entries(r.resultChars)) {
      const b = byTool[t] || (byTool[t] = { calls: 0, chars: 0, images: 0 });
      b.calls += r.tools[t] || 0;
      b.chars += x.chars;
      b.images += x.images;
    }
  const totalCost = rows.reduce((s, r) => s + (r.cost || 0), 0);
  const md = [
    `# Agent evaluation: ${AGENT_NAME} + Foxwright (${TRUSTED ? 'trusted' : 'synthetic'}${ASK ? ', ask' : ''} input, ${process.env.FOXWRIGHT_E2E_BUILD || 'full'} build)`,
    '',
    `${new Date().toISOString()} · ${os.platform()} ${os.arch()}${MODEL ? ` · model ${MODEL}` : ''}${AGENT === 'claude' ? ` · max turns ${MAX_TURNS}` : ''}`,
    '',
    'Each repetition uses a fresh Firefox profile and helper HOME. Results are independently checked after every task.',
    '',
    REPEAT > 1 ? `Each task ran ${REPEAT} times. pass@1: **${Math.round(100 * passed / rows.length)}%** (${passed}/${rows.length} runs). pass@${REPEAT}: ${passAtN}/${taskIds.length} tasks. Passed every time: ${allPass}/${taskIds.length} tasks.\n` : '',
    `**${passed}/${rows.length} ${REPEAT > 1 ? 'runs' : 'tasks'} succeeded** (checked in the browser, not taken from the agent's word). Median ${Math.round(med(rows.map(r => r.ms)) / 1000)} s and ${med(rows.map(r => r.toolCalls))} tool calls per task${totalCost ? `; total cost $${totalCost.toFixed(2)}` : ''}.`,
    '',
    ASK ? `Foxwright was in "ask" mode: a scripted user answered ${approvalCount} permission window(s).\n` : '',
    '| Task | Result | Time | Tool calls | Errors | Tokens (in+cache / out) | Cost | Answer |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.id} | ${r.ok ? 'pass' : '**fail**'} | ${Math.round(r.ms / 1000)} s | ${r.toolCalls} | ${r.toolErrors} | ${Math.round((r.usage.input + r.usage.cacheRead + r.usage.cacheWrite) / 1000)}k / ${Math.round(r.usage.output / 1000)}k | ${r.cost != null ? '$' + r.cost.toFixed(3) : '–'} | ${r.answer.replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 90)} |`),
    '',
    '## What the tools cost in context',
    '',
    '| Tool | Calls | Result text (chars) | Avg per call | Screenshots |',
    '|---|---|---|---|---|',
    ...Object.entries(byTool).sort((a, b) => b[1].chars - a[1].chars).map(([t, b]) => `| ${t} | ${b.calls} | ${b.chars} | ${b.calls ? Math.round(b.chars / b.calls) : 0} | ${b.images} |`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, `agent-eval-${MODE}.md`), md);
  fs.writeFileSync(path.join(outDir, `agent-eval-${MODE}.json`), JSON.stringify(rows, null, 2));
  console.log(`\n${passed}/${rows.length} ${REPEAT > 1 ? 'runs' : 'tasks'} succeeded. Report: test/results/agent-eval-${MODE}.md`);
  process.exit(passed === rows.length ? 0 : 1);
}

if (SERVE)
  serve();
else
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
