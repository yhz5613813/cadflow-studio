import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import { Compartment, EditorState, StateEffect } from '@codemirror/state';
export function SourceEditor({ value, onChange, readOnly = false, lineRange }: { value: string; onChange: (text: string) => void; readOnly?: boolean; lineRange?: { start: number; end: number } }) {
  const editable = useRef(new Compartment());
  const host = useRef<HTMLDivElement>(null), editor = useRef<EditorView | null>(null), change = useRef(onChange); change.current = onChange;
  useEffect(() => { const view = new EditorView({ doc: value, extensions: [basicSetup, python(), oneDark, EditorView.lineWrapping, EditorView.updateListener.of(update => { if (update.docChanged) change.current(update.state.doc.toString()); }), EditorView.theme({ '&': { height: '100%', fontSize: '12px', backgroundColor: '#1e1e1e' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'Consolas, monospace' }, '.cm-gutters': { backgroundColor: '#1e1e1e', color: '#858585', border: 'none' } })], parent: host.current! }); editor.current = view; return () => view.destroy(); }, []);
  useEffect(() => { const view = editor.current; if (view && view.state.doc.toString() !== value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); }, [value]);
  useEffect(() => { editor.current?.dispatch({ effects: StateEffect.appendConfig.of(editable.current.of([])) }); }, []);
  useEffect(() => { editor.current?.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) }); }, [readOnly]);
  useEffect(() => {
    const view = editor.current; if (!view || !lineRange) return;
    const start = Math.max(1, Math.min(lineRange.start, view.state.doc.lines)), end = Math.max(start, Math.min(lineRange.end, view.state.doc.lines));
    const from = view.state.doc.line(start).from, to = view.state.doc.line(end).to;
    view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
  }, [value, lineRange?.start, lineRange?.end]);
  return <div className="source-editor" ref={host}/>;
}
