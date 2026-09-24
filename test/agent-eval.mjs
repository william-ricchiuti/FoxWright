// Real-agent evaluation: Claude Code (headless) completes everyday browser tasks using
// only Kitsune's tools, and an independent verifier checks the result in the browser.
//
//   node test/agent-eval.mjs [--trusted | --ask] [--only REGEX] [--model NAME] [--max-turns N] [--repeat N]
//
//   --trusted  real input through WebDriver BiDi
//   --ask      Kitsune asks before every new site, as it does for real users; a scripted "user"
//              presses "Allow this session" in each permission window (synthetic input only)
//   --repeat N run every task N times and report pass@1 and pass@N
//
// Needs the `claude` CLI (logged in). Uses the same throwaway-Firefox harness as the other
// tests. Writes test/results/agent-eval-<mode>.{json,md} and one transcript per task.
// Exits 1 if any task failed. Each full run costs roughly $1.50–2 of Claude usage.
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
const MODE = (TRUSTED ? 'trusted' : 'synthetic') + (ASK ? '-ask' : '');
const outDir = path.join(root, 'test', 'results');
const transcriptDir = path.join(outDir, 'agent');
fs.mkdirSync(transcriptDir, { recursive: true });

const KITSUNE_TOOLS = ['tabs_context_mcp', 'tabs_create_mcp', 'tabs_close_mcp', 'navigate', 'read_page', 'find', 'form_input', 'computer', 'get_page_text', 'javascript_tool', 'handle_dialog', 'read_console_messages', 'read_network_requests', 'resize_window', 'file_upload', 'browser_batch', 'gif_creator'];
// Everything else is off, so the agent can't route around the browser (e.g. with WebFetch).
const BLOCKED = ['Bash', 'WebFetch', 'WebSearch', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Task', 'Agent', 'NotebookEdit'];

let help = '';
try {
  help = execFileSync(CLAUDE, ['--help'], { encoding: 'utf8' });
} catch (e) {
  console.error(`Can't run the Claude Code CLI (${CLAUDE}). Install it and log in first.`);
  process.exit(1);
}
const STRICT = help.includes('--strict-mcp-config');

const mcpConfig = path.join(os.tmpdir(), `kitsune-agent-eval-${process.pid}.json`);
// Written after the harness starts (below), so the MCP server can point at the harness's Kitsune folder.
function writeMcpConfig(h) {
  const env = { KITSUNE_HOME: path.join(h.home, '.kitsune'), ...(h.bidiUrl ? { KITSUNE_BIDI_URL: h.bidiUrl } : {}) };
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

async function main() {
  console.log(`Kitsune agent evaluation: Claude Code + Kitsune (${MODE} input)${MODEL ? `, model ${MODEL}` : ''}${STRICT ? '' : ' [note: --strict-mcp-config unsupported; other MCP servers may be visible]'}`);
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
      const run = await runClaude(prompt, transcript);
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
    `# Agent evaluation: Claude Code + Kitsune (${MODE} input)`,
    '',
    `${new Date().toISOString()} · ${os.platform()} ${os.arch()}${MODEL ? ` · model ${MODEL}` : ''} · max turns ${MAX_TURNS}`,
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
