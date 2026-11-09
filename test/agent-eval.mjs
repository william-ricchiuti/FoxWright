// Real-agent evaluation: Claude Code (headless) completes everyday browser tasks using
// only Kitsune's tools, and an independent verifier checks the result in the browser.
//
//   node test/agent-eval.mjs [--agent claude|codex|opencode] [--trusted | --ask] [--only REGEX] [--model NAME] [--max-turns N] [--repeat N]
//
//   --agent    which agent CLI runs the tasks (default claude). codex = OpenAI's Codex CLI
//              (`codex exec`), opencode = OpenCode (`opencode run`, any provider, e.g.
//              --model deepseek/deepseek-v4-pro). Both are locked down so only Kitsune's tools
//              can reach the web: Codex without its shell, browser, computer use, apps and web
//              search (its code mode has no network APIs) (read-only sandbox, your config.toml ignored); OpenCode with a
//              temporary config (your opencode.json and plugins ignored) denying bash, edit,
//              webfetch, websearch, task and skill. --max-turns applies to Claude only.
//
//   --trusted  real input through WebDriver BiDi
//   --ask      Kitsune asks before every new site, as it does for real users; a scripted "user"
//              presses "Allow this session" in each permission window (synthetic input only)
//   --repeat N run every task N times and report pass@1 and pass@N
//
// Needs the `claude` CLI (logged in). Uses the same throwaway-Firefox harness as the other
// tests. Writes test/results/agent-eval-<mode>.{json,md} and one transcript per task.
// Exits 1 if any task failed. Each full run costs roughly $4 of Claude usage with Opus 5.5 (2026-11-08); less with a cheaper --model.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { start } from './harness.mjs';
import { TASKS } from './agent-tasks.mjs';
import { connectDriver } from './bidi-driver.mjs';

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
const MODEL = opt('--model');
const MAX_TURNS = opt('--max-turns', '40');
const REPEAT = Number(opt('--repeat', '1'));
const CLAUDE = opt('--claude', 'claude');
const AGENT = opt('--agent', 'claude');
if (!['claude', 'codex', 'opencode'].includes(AGENT)) {
  console.error('--agent must be claude, codex or opencode.');
  process.exit(2);
}
const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex CLI', opencode: 'OpenCode' }[AGENT];
// Reports and transcripts keep their old names for Claude, so earlier results stay comparable.
const MODE = (AGENT === 'claude' ? '' : `${AGENT}-`) + (TRUSTED ? 'trusted' : 'synthetic') + (ASK ? '-ask' : '');
const outDir = path.join(root, 'test', 'results');
const transcriptDir = path.join(outDir, 'agent');
fs.mkdirSync(transcriptDir, { recursive: true });

const KITSUNE_TOOLS = ['tabs_context_mcp', 'tabs_create_mcp', 'tabs_close_mcp', 'navigate', 'read_page', 'find', 'form_input', 'computer', 'get_page_text', 'javascript_tool', 'handle_dialog', 'read_console_messages', 'read_network_requests', 'resize_window', 'file_upload', 'browser_batch', 'gif_creator'];
// Everything else is off, so the agent can't route around the browser (e.g. with WebFetch).
const BLOCKED = ['Bash', 'WebFetch', 'WebSearch', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Task', 'Agent', 'NotebookEdit'];

let help = '';
try {
  help = execFileSync(AGENT === 'claude' ? CLAUDE : AGENT, ['--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  console.error(`Can't run the ${AGENT_NAME} CLI (${AGENT === 'claude' ? CLAUDE : AGENT}). Install it and log in first.`);
  process.exit(1);
}
const STRICT = help.includes('--strict-mcp-config');

const mcpConfig = path.join(os.tmpdir(), `kitsune-agent-eval-${process.pid}.json`);
// Written after the harness starts (below), so the MCP server can point at the harness's Kitsune folder.
let mcpServer = null; // { command, args, env } for the agents that take it directly
function writeMcpConfig(h) {
  const env = { KITSUNE_HOME: path.join(h.home, '.kitsune'), ...(h.bidiUrl ? { KITSUNE_BIDI_URL: h.bidiUrl } : {}) };
  mcpServer = { command: process.execPath, args: [path.join(root, 'host/dist/kitsune.mjs'), 'mcp'], env };
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { kitsune: { command: process.execPath, args: [path.join(root, 'host/dist/kitsune.mjs'), 'mcp'], env } } }));
}
const uploadFile = path.join(os.tmpdir(), 'kitsune-agent-upload.txt');
fs.writeFileSync(uploadFile, 'Uploaded by an AI agent through Kitsune.\n');

function runClaude(prompt, transcriptPath) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--mcp-config', mcpConfig, '--max-turns', MAX_TURNS,
    '--allowedTools', 'mcp__kitsune', ...KITSUNE_TOOLS.map(t => `mcp__kitsune__${t}`), '--disallowedTools', ...BLOCKED];
  if (STRICT)
    args.push('--strict-mcp-config');
  if (help.includes('--no-chrome'))
    args.push('--no-chrome'); // make sure the agent uses Kitsune, not Claude in Chrome
  args.push('--append-system-prompt', 'Do the task in the web browser using the Kitsune tools (mcp__kitsune__*). Do not answer from memory.');
  if (MODEL)
    args.push('--model', MODEL);
  const env = { ...process.env };
  delete env.CLAUDECODE; // allow launching from inside a Claude Code terminal
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(CLAUDE, args, { env, cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    const out = fs.createWriteStream(transcriptPath);
    let buf = '', stderr = '';
    const m = { calls: [], toolCalls: {}, toolErrors: 0, resultChars: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, seen: new Set(), idToTool: {}, final: null };
    const onLine = (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === 'assistant' && ev.message) {
        const msg = ev.message;
        for (const c of msg.content || []) {
          if (c.type === 'tool_use') {
            const name = String(c.name).replace(/^mcp__kitsune__/, '');
            m.toolCalls[name] = (m.toolCalls[name] || 0) + 1;
            m.calls.push({ name, input: c.input || {} });
            m.idToTool[c.id] = name;
          }
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
          if (c.is_error)
            m.toolErrors++;
          const tool = m.idToTool[c.tool_use_id] || '?';
          const parts = Array.isArray(c.content) ? c.content : [{ type: 'text', text: String(c.content ?? '') }];
          const chars = parts.reduce((n, p) => n + (p.type === 'text' ? (p.text || '').length : p.type === 'image' ? 0 : 0), 0);
          const images = parts.filter(p => p.type === 'image').length;
          const r = m.resultChars[tool] || (m.resultChars[tool] = { chars: 0, images: 0 });
          r.chars += chars;
          r.images += images;
        }
      } else if (ev.type === 'result') {
        m.final = ev;
      }
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

const BROWSER_HINT = 'Do the task in the web browser using the Kitsune tools. Do not answer from memory.';
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
  name = String(name).replace(/^(mcp__)?kitsune(__|_|\.)/, '');
  m.toolCalls[name] = (m.toolCalls[name] || 0) + 1;
  m.calls.push({ name, input: input || {} });
  if (isError)
    m.toolErrors++;
  countResult(m, name, parts);
}

/** Spawn an agent CLI, write its JSONL to the transcript and feed each event to onEvent(ev, m). */
function spawnAgent(cmd, args, opts, transcriptPath, onEvent) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
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

const tomlStr = (v) => JSON.stringify(String(v)); // TOML basic strings use JSON-compatible escapes
function runCodex(prompt, transcriptPath) {
  const s = mcpServer;
  const envTable = '{' + Object.entries(s.env).map(([k, v]) => `${k}=${tomlStr(v)}`).join(', ') + '}';
  // code_mode_host stays on: Codex calls MCP tools through it, and its JavaScript has no fetch,
  // XMLHttpRequest, WebSocket, require or imports (checked 2026-11-08, codex-cli 0.161.0).
  const off = ['shell_tool', 'unified_exec', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'apps', 'in_app_browser', 'image_generation', 'skill_search', 'tool_suggest'];
  const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '-s', 'read-only',
    '-c', 'web_search="disabled"', ...off.flatMap(f => ['--disable', f]),
    '-c', `mcp_servers.kitsune.command=${tomlStr(s.command)}`,
    '-c', `mcp_servers.kitsune.args=[${s.args.map(tomlStr).join(', ')}]`,
    '-c', `mcp_servers.kitsune.env=${envTable}`,
    '-c', 'mcp_servers.kitsune.startup_timeout_sec=30',
    '-c', 'mcp_servers.kitsune.tool_timeout_sec=180',
    '-c', 'mcp_servers.kitsune.default_tools_approval_mode="approve"', // headless: nobody can approve calls (Kitsune's own permission windows still apply)
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
      else if (it.type === 'mcp_tool_call' && it.server === 'kitsune') {
        const content = it.result?.content || [];
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
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-opencode-'));
  fs.mkdirSync(path.join(xdg, 'opencode'));
  const deny = ['bash', 'edit', 'write', 'patch', 'webfetch', 'websearch', 'codesearch', 'task', 'skill'];
  fs.writeFileSync(path.join(xdg, 'opencode', 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    mcp: { kitsune: { type: 'local', command: [mcpServer.command, ...mcpServer.args], environment: mcpServer.env, enabled: true, timeout: 30000 } },
    permission: { bash: 'deny', edit: 'deny', webfetch: 'deny', websearch: 'deny', codesearch: 'deny', external_directory: 'deny' },
    tools: Object.fromEntries(deny.map(t => [t, false])),
  }));
  const args = ['run', '--pure', '--format', 'json', '--title', `kitsune-eval ${path.basename(transcriptPath, '.jsonl')}`];
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

const runAgent = (prompt, transcriptPath) => (AGENT === 'codex' ? runCodex : AGENT === 'opencode' ? runOpencode : runClaude)(prompt, transcriptPath);

async function main() {
  console.log(`Kitsune agent evaluation: ${AGENT_NAME} + Kitsune (${TRUSTED ? 'trusted' : 'synthetic'}${ASK ? ', ask' : ''} input)${MODEL ? `, model ${MODEL}` : ''}${AGENT === 'claude' && !STRICT ? ' [note: --strict-mcp-config unsupported; other MCP servers may be visible]' : ''}`);
  // In trusted mode Firefox gets a debugging port for Claude's Kitsune MCP server; the harness's
  // own MCP client (used for checks) stays off it, since Firefox allows one WebDriver BiDi session.
  const h = await start({ testDriver: TRUSTED || ASK, policy: ASK ? { mode: 'ask', confirmUploads: true } : undefined });
  writeMcpConfig(h);
  const driver = ASK ? await connectDriver(h.bidiUrl) : null;
  const approver = driver ? driver.autoAnswer('once') : null;
  const v = async (name, args = {}) => h.call(name, args);
  const groupTabs = async () => {
    const r = await v('tabs_context_mcp', {});
    return [...r.text.matchAll(/tabId (\d+): ("(?:[^"\\]|\\.)*") (\S+)( \(active)?/g)].map(x => ({ id: +x[1], title: JSON.parse(x[2]), url: x[3], active: !!x[4] }));
  };
  const resetTabs = async () => {
    for (const t of await groupTabs())
      await v('tabs_close_mcp', { tabId: t.id });
  };

  const rows = [];
  for (let rep = 0; rep < REPEAT; rep++) {
    for (const task of TASKS) {
      if (ONLY && !ONLY.test(task.id))
        continue;
      await resetTabs();
      const prompt = task.prompt.replace('__UPLOAD_FILE__', uploadFile).replaceAll('__LOCAL__', `http://127.0.0.1:${process.env.KITSUNE_P1}`);
      const transcript = path.join(transcriptDir, `${MODE}-${task.id}${REPEAT > 1 ? `-${rep + 1}` : ''}.jsonl`);
      process.stdout.write(`  … ${task.id}`);
      const run = await runAgent(prompt, transcript);
      const answer = String(run.m.final?.result ?? '');
      const tabs = await groupTabs();
      const active = tabs.find(t => t.active) || tabs[tabs.length - 1];
      const ctx = {
        answer,
        calls: run.m.calls, // [{ name, input }] tool calls the agent made, in order
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
          const r = await v('javascript_tool', { tabId: t.id, action: 'javascript_exec', text: code });
          return r.isError ? 'null' : r.text;
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
        stderr: run.stderr.slice(-400), hitTurnLimit: /max_turns/.test(String(f.subtype || '')),
      };
      rows.push(row);
      const tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
      process.stdout.write(`\r  ${ok ? '✓' : '✗'} ${task.id.padEnd(17)} ${(run.ms / 1000).toFixed(0).padStart(4)}s  ${String(row.toolCalls).padStart(3)} tool calls  ${Math.round(tokens / 1000)}k tokens${row.cost != null ? `  $${row.cost.toFixed(3)}` : ''}${row.hitTurnLimit ? '  (hit turn limit)' : ''}${run.code ? `  (exit ${run.code})` : ''}\n`);
      if (!ok)
        console.log(`      answer: ${answer.replace(/\s+/g, ' ').slice(0, 220) || '(none)'}${verifyError ? `\n      verify error: ${verifyError}` : ''}${run.code && run.stderr ? `\n      stderr: ${run.stderr.trim().slice(-200)}` : ''}`);
    }
  }
  approver?.stop();
  driver?.close();
  await h.stop();
  fs.rmSync(mcpConfig, { force: true });

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
    `# Agent evaluation: ${AGENT_NAME} + Kitsune (${TRUSTED ? 'trusted' : 'synthetic'}${ASK ? ', ask' : ''} input)`,
    '',
    `${new Date().toISOString()} · ${os.platform()} ${os.arch()}${MODEL ? ` · model ${MODEL}` : ''}${AGENT === 'claude' ? ` · max turns ${MAX_TURNS}` : ''}`,
    '',
    REPEAT > 1 ? `Each task ran ${REPEAT} times. pass@1: **${Math.round(100 * passed / rows.length)}%** (${passed}/${rows.length} runs). pass@${REPEAT}: ${passAtN}/${taskIds.length} tasks. Passed every time: ${allPass}/${taskIds.length} tasks.\n` : '',
    `**${passed}/${rows.length} ${REPEAT > 1 ? 'runs' : 'tasks'} succeeded** (checked in the browser, not taken from the agent's word). Median ${Math.round(med(rows.map(r => r.ms)) / 1000)} s and ${med(rows.map(r => r.toolCalls))} tool calls per task${totalCost ? `; total cost $${totalCost.toFixed(2)}` : ''}.`,
    '',
    ASK ? `Kitsune was in "ask" mode: a scripted user approved ${approver.count} permission window(s).\n` : '',
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

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
