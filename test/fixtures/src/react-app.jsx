import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
function App() {
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [size, setSize] = useState('m');
  const [count, setCount] = useState(0);
  const [submitted, setSubmitted] = useState(null);
  const [q, setQ] = useState('');
  const suggestions = ['firefox', 'fox', 'foxglove', 'foxwright', 'kitten'].filter(s => q && s.startsWith(q.toLowerCase()));
  return (
    <form onSubmit={e => { e.preventDefault(); setSubmitted({ name, agree, size }); }}>
      <h1>React form</h1>
      <label>Your name <input id="rname" value={name} onChange={e => setName(e.target.value)} /></label>
      <p id="echo">Hello, {name || 'nobody'}</p>
      <label><input id="ragree" type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} /> Agree</label>
      <label>Size <select id="rsize" value={size} onChange={e => setSize(e.target.value)}><option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option></select></label>
      <button type="button" id="rcount" onClick={() => setCount(c => c + 1)}>Count: {count}</button>
      <label>Search <input id="rsearch" role="combobox" aria-autocomplete="list" value={q} onChange={e => setQ(e.target.value)} /></label>
      <ul id="rsuggest" role="listbox">{suggestions.map(s => <li key={s} role="option" onClick={() => setQ(s)}>{s}</li>)}</ul>
      <button type="submit" id="rsubmit">Save</button>
      <p id="rresult">{submitted ? `SAVED ${JSON.stringify(submitted)}` : 'unsaved'}</p>
    </form>
  );
}
createRoot(document.getElementById('root')).render(<App />);
