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
    const firstWrite = plugin.save(second, {width: 168});
    const updated = (await plugin.targets.inNote(view))[1];
    assert.equal(updated.snapshot.spec.width, 168);
    await Promise.all([firstWrite, plugin.save(updated, {width: 200})]);
    assert.ok((await app.vault.adapter.read(note.path)).includes(raw + raw.replace('|128', '|200')));

    const resized = await waitFor(() => images()[1]?.getAttribute('width') === '200' && images()[1], 'updated widget');
    const document = resized.ownerDocument;
    const window = document.defaultView;
    resized.dispatchEvent(new window.PointerEvent('pointerover', {bubbles: true}));
    const tools = document.querySelector('.iek-layer:not([hidden]) .iek-tools');
    assert.ok(tools);
    const display = el => window.getComputedStyle(el).display;
    const visibleTools = bar => Array.from(bar.querySelectorAll('button')).filter(el => display(el) !== 'none').length;
    assert.equal(visibleTools(tools), 3);
    const host = resized.closest('.image-embed');
    for (const native of host.querySelectorAll(':scope > .embed-actions, :scope > .image-wrapper > .image-resize-corner')) {
      assert.equal(display(native), 'none');
    }

    const layer = tools.closest('.iek-layer');
    const pointer = {bubbles: true, pointerId: 7, button: 0};
    layer.querySelector('.iek-right').dispatchEvent(new window.PointerEvent('pointerdown', pointer));
    assert.equal(window.getComputedStyle(resized).visibility, 'hidden');
    assert.ok(layer.querySelector('.iek-ghost'));
    document.dispatchEvent(new window.PointerEvent('pointercancel', pointer));
    assert.notEqual(window.getComputedStyle(resized).visibility, 'hidden');
    assert.equal(display(layer), 'none');
    resized.dispatchEvent(new window.PointerEvent('pointerover', {bubbles: true}));
    tools.querySelector('.iek-source').click();
    await waitFor(() => editor.getSelection() === name + '.svg', 'edit original link');
    assert.equal(editor.getCursor('from').ch, raw.length + 3);

    await leaf.setViewState({type: 'markdown', state: {file: note.path, mode: 'preview'}, active: true});
    const readingImage = await waitFor(() => leaf.view.contentEl.querySelector('.markdown-preview-view .image-embed img'), 'reading image');
    readingImage.dispatchEvent(new window.PointerEvent('pointerover', {bubbles: true}));
    assert.notEqual(display(layer), 'none');
    assert.equal(visibleTools(tools), 2);
    assert.equal(display(tools.querySelector('.iek-source')), 'none');
  } finally {
    leaf.detach();
    for (const file of created.reverse()) await app.vault.delete(file);
  }
};
