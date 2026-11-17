// Independent negative controls: a claimed answer or a bypass must not earn a pass.
import assert from 'node:assert/strict';
import { FEATURE_TASKS } from './agent-tasks.mjs';
const task = id => FEATURE_TASKS.find(t => t.id === id);
const call = (name, input = {}) => ({ name, input });
let checks = 0;
async function check(id, context, expected) {
  assert.equal(await task(id).verify(context), expected, id);
  checks++;
}
const inventory = { changes: 0, code: 'AUDIT-test', stock: 17 };
const read = { answer: '17 AUDIT-test', calls: [call('read_page')], inspectFixture: async () => inventory };
await check('read-only-site', read, true);
await check('read-only-site', { ...read, answer: '17 invented' }, false);
await check('read-only-site', { ...read, calls: [...read.calls, call('browser_batch', { actions: JSON.stringify([{ tool: 'computer', args: { action: 'left_click' } }]) })] }, false);
await check('read-only-site', { ...read, inspectFixture: async () => ({ ...inventory, changes: 1 }) }, false);
const pdf = { answer: 'Least Concern. The quick brown fox jumps over the lazy dog.', calls: [call('get_page_text')], tabs: async () => [{ url: 'http://127.0.0.1:8765/pdf/simple.pdf' }] };
await check('read-pdf', pdf, true);
await check('read-pdf', { ...pdf, calls: [] }, false);
await check('read-pdf', { ...pdf, tabs: async () => [] }, false);
const late = { answer: 'DELIVERY-test', calls: [call('read_page', { wait_for: 'Report ready' })], inspectFixture: async () => ({ ready: true, code: 'DELIVERY-test' }) };
await check('late-page', late, true);
await check('late-page', { ...late, calls: [call('computer', { action: 'wait', duration: 10 })] }, false);
await check('late-page', { ...late, inspectFixture: async () => ({ ready: false, code: '' }) }, false);
const diff = { answer: '23 SHIP-test', calls: [call('read_page'), call('computer', { action: 'left_click' }), { ...call('read_page', { diff: true }), resultText: 'Changes since the previous read_page: SHIP-test' }], inspectFixture: async () => ({ stock: 23, code: 'SHIP-test', changes: 1 }) };
await check('long-page-diff', diff, true);
await check('long-page-diff', { ...diff, calls: [call('read_page', { diff: true })] }, false);
await check('long-page-diff', { ...diff, calls: [...diff.calls, call('javascript_tool')] }, false);
await check('long-page-diff', { ...diff, inspectFixture: async () => ({ stock: 23, code: 'SHIP-test', changes: 0 }) }, false);
await check('long-page-diff', { ...diff, calls: diff.calls.map(c => ({ ...c, resultText: 'Full outline: SHIP-test' })) }, false);
console.log(`${checks} feature-verifier checks passed`);
