// Checks that Foxwright still answers after the extension has been idle for longer
// than Firefox's event-page idle timeout (~30 s).
import { start } from './harness.mjs';
const h = await start({});
const a = await h.call('tabs_context_mcp', { createIfEmpty: true });
console.log('before idle:', a.isError ? 'ERROR ' + a.text : 'ok');
await new Promise(r => setTimeout(r, 75000));
const b = await h.call('tabs_context_mcp', {});
console.log('after 75s idle:', b.isError ? 'ERROR ' + b.text : 'ok');
await h.stop();
process.exit(a.isError || b.isError ? 1 : 0);
