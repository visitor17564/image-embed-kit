'use strict';
const assert = require('node:assert/strict');

// Run inside a disposable desktop vault with Image Embed Kit enabled, for example
// via Obsidian CLI eval: await require('/absolute/path/to/tests/live-preview.host.cjs')(app)
module.exports = async function verifyLivePreview(app) {
  const plugin = app.plugins.getPlugin('image-embed-kit');
  assert.ok(plugin, 'Enable Image Embed Kit in the test vault');
  const leaf = app.workspace.getLeaf('tab');
  const created = [];
  const name = 'embed-kit-test-' + require('node:crypto').randomUUID();
  const raw = '![[' + name + '.svg|128]]';
  const sample = '# Test\n\n' + raw + raw + '\n';
  const waitFor = async (get, label) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = get();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw Error('Timed out: ' + label);
  };

  try {
    created.push(await app.vault.create(name + '.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128"/>'));
    const note = await app.vault.create(name + '.md', sample);
    created.push(note);
    await leaf.setViewState({type: 'markdown', state: {file: note.path, mode: 'source', source: false}, active: true});
    const view = leaf.view;
    const editor = view.editor;
    editor.setCursor({line: 0, ch: 0});
    const images = () => view.contentEl.querySelectorAll('.markdown-source-view.is-live-preview .cm-line > .image-embed img');
    await waitFor(() => images().length === 2 && app.metadataCache.getFileCache(note)?.embeds?.length === 2, 'fixture');

    // Change offsets and query the second occurrence in the very same turn,
    // before Obsidian can save the edit or index the new note contents.
    editor.replaceRange('새 줄\n', {line: 0, ch: 0});
    editor.setCursor({line: 3, ch: raw.length + 5});
    const selected = plugin.targets.atCursor(view);
    assert.equal(selected?.snapshot.start, editor.getValue().lastIndexOf(raw));
    const indexed = await plugin.targets.inNote(view);
    assert.deepEqual(indexed.map(r => r.snapshot.start), [editor.getValue().indexOf(raw), selected.snapshot.start]);
    editor.setCursor({line: 0, ch: 0});
    const img = await waitFor(() => images()[1], 'second widget');
    const second = await plugin.targets.forImage(img);
    assert.equal(second.snapshot.start, selected.snapshot.start);
    await plugin.save(second, {width: 200});
    assert.ok((await app.vault.adapter.read(note.path)).includes(raw + raw.replace('|128', '|200')));

    const resized = await waitFor(() => images()[1]?.getAttribute('width') === '200' && images()[1], 'updated widget');
    const document = resized.ownerDocument;
    const window = document.defaultView;
    resized.dispatchEvent(new window.PointerEvent('pointerover', {bubbles: true}));
    const tools = document.querySelector('.iek-layer:not([hidden]) .iek-tools');
    assert.ok(tools);
    const native = resized.closest('.image-embed').querySelector(':scope > .embed-actions');
    if (native) assert.equal(window.getComputedStyle(native).display, 'none');
    tools.querySelector('.iek-source').click();
    await waitFor(() => editor.getSelection() === name + '.svg', 'edit original link');
    assert.equal(editor.getCursor('from').ch, raw.length + 3);
  } finally {
    leaf.detach();
    for (const file of created.reverse()) await app.vault.delete(file);
  }
};
