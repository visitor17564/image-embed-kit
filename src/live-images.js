'use strict';

const {EditorView} = require('@codemirror/view');
const {ensureSyntaxTree, language, syntaxTree} = require('@codemirror/language');
const markdown = require('./markdown.js');
const excludedSyntax = /HyperMD-(?:table|codeblock|frontmatter)|(?:^|_)(?:comment|inline-code)(?:_|$)/;

function editorFor(node) {
  const root = node?.closest('.cm-editor') ?? node?.querySelector('.markdown-source-view .cm-editor');
  return root ? EditorView.findFromDOM(root) : null;
}

function widgetRange(editor, widget) {
  if (!widget || !editor.contentDOM.contains(widget)) return null;
  const parent = widget.parentNode;
  const index = Array.prototype.indexOf.call(parent.childNodes, widget);
  return {
    from: editor.posAtDOM(parent, index),
    to: editor.posAtDOM(parent, index + 1)
  };
}

// The editor's Markdown parser has already established where the destination
// ends. Keep the original markup for editing and decode only the file lookup.
function destination(spec) {
  if (spec.wiki) return spec.head.slice(3);
  const value = spec.tail.slice(2, -1).trim();
  const angle = /^<((?:\\.|[^>\\])*)>(?:\s|$)/u.exec(value);
  const path = angle ? angle[1] : value.replace(/\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))$/u, '');
  const unescaped = path.replace(/\\([!-/:-@[-\x60{-~])/g, '$1');
  try { return decodeURIComponent(unescaped); } catch { return unescaped; }
}

function entryInRange(document, start, end) {
  const line = document.lineAt(start);
  if (end > line.to) return null;
  const raw = document.sliceString(start, end);
  const spec = markdown.parse(raw);
  return spec ? {start, end, line: line.number - 1, col: start - line.from, raw, link: destination(spec)} : null;
}

function widgetEntry(editor, range) {
  // A standalone block widget can include its line break; that break belongs to the note.
  const line = editor.state.doc.lineAt(range.from);
  if (range.to > line.to + 1) return null;
  const end = Math.min(range.to, line.to);
  if (end <= range.from) return null;
  let node = syntaxTree(editor.state).resolveInner(range.from + 1, 1);
  while (node) {
    if (excludedSyntax.test(node.name)) return null;
    node = node.parent;
  }
  const direct = entryInRange(editor.state.doc, range.from, end);
  if (direct) return direct;

  // Some Live Preview versions render the opening markup as a separate widget.
  // Accept only the parsed embed that contains this widget's whole source range.
  const entries = imageEntries(editor, line.from, line.to)
    .filter(entry => entry.start <= range.from && end <= entry.end);
  return entries.length === 1 ? entries[0] : null;
}

// Only asked for on an editor command or a click. Small interactions walk the
// clicked widget or cursor line. The note-wide picker also includes offscreen lines.
function imageEntries(editor, from = 0, to = editor.state.doc.length) {
  const {state} = editor;
  const document = state.doc;
  let tree = ensureSyntaxTree(state, to, 30);
  if (!tree) {
    const parser = state.facet(language)?.parser;
    if (!parser) return [];
    tree = parser.parse(document.toString());
  }

  const entries = [];
  let open = null;
  tree.iterate({
    from, to,
    enter(node) {
      const name = node.name;
      if (excludedSyntax.test(name)) return false;
      if (node.from < from || node.to > to) return;
      if (open && node.from > open.line.to) open = null;

      const wiki = name.includes('formatting-embed') && name.includes('formatting-link-start');
      const image = name.includes('image-marker');
      if (wiki || image) {
        const marker = document.sliceString(node.from, node.to);
        if (marker === '![[' || marker === '!') {
          open = {start: node.from, line: document.lineAt(node.from), wiki: marker === '![['};
        }
        return;
      }
      if (!open) return;
      const closing = open.wiki ? 'formatting-link-end' : 'formatting-link-string';
      if (!name.includes(closing)) return;
      if (document.sliceString(node.from, node.to) !== (open.wiki ? ']]' : ')')) return;

      const entry = entryInRange(document, open.start, node.to);
      if (entry) entries.push(entry);
      open = null;
    }
  });
  return entries;
}

module.exports = {editorFor, widgetRange, widgetEntry, imageEntries};
