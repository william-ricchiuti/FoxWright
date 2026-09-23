import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from 'prosemirror-schema-basic';
import { exampleSetup } from 'prosemirror-example-setup';
const view = new EditorView(document.getElementById('editor'), {
  state: EditorState.create({ schema, plugins: exampleSetup({ schema, menuBar: false }) }),
  dispatchTransaction(tr) {
    view.updateState(view.state.apply(tr));
    document.getElementById('pmdoc').textContent = view.state.doc.textContent;
  },
});
window.pmView = view;
