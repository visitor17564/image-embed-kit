'use strict';
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label) {
  for (let i = 0; i < 100; i++) {
    const result = await check();
    if (result) return result;
    await pause(40);
  }
  throw Error('Timed out: ' + label);
}

// Runs only in a disposable vault. An optional Electron webContents exercises
// trusted mouse and keyboard input in addition to the DOM event path.
module.exports = async function verifyImageKeys(app, {wc} = {}) {
  const id = 'embed-keys-' + randomUUID();
  const assetName = id + '.svg';
  const raw = '![[' + assetName + '|120]]';
  const files = [];
  const leaf = app.workspace.getLeaf('tab');
  const document = leaf.containerEl.ownerDocument;
  const win = document.defaultView;
  const layer = document.querySelector('.iek-layer');
  const hasEditorFocus = () => leaf.view.contentEl.contains(document.activeElement) &&
    !!document.activeElement.closest('.cm-content');

  const open = async (label, contents, mode) => {
    const file = await app.vault.create(id + '-' + label + '.md', contents);
    files.push(file);
    await leaf.setViewState({type:'markdown', state:{file:file.path, mode, source:false}, active:true});
    if (mode === 'source') leaf.view.editor.setCursor({line:0, ch:0});
    const scope = mode === 'source' ? '.markdown-source-view.is-live-preview' : '.markdown-preview-view';
    const images = () => Array.from(leaf.view.contentEl.querySelectorAll(scope + ' .image-embed img'));
    await until(() => images()[0]?.naturalWidth && app.metadataCache.getFileCache(file)?.embeds?.length, label);
    return {file, editor:leaf.view.editor, images, read:() => app.vault.adapter.read(file.path)};
  };
  const select = async img => {
    if (wc) {
      img.scrollIntoView({block:'nearest'});
      const r = img.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height * .8);
      assert.ok(document.elementFromPoint(x,y) === img, 'input point must be on the image');
      wc.sendInputEvent({type:'mouseMove',x,y});
      wc.sendInputEvent({type:'mouseDown',button:'left',x,y,clickCount:1});
      wc.sendInputEvent({type:'mouseUp',button:'left',x,y,clickCount:1});
    } else {
      img.dispatchEvent(new win.PointerEvent('pointerdown',{button:0,bubbles:true,cancelable:true}));
      img.dispatchEvent(new win.MouseEvent('click',{button:0,bubbles:true,cancelable:true}));
    }
    await until(() => document.activeElement === layer && !layer.hidden, 'clicked image owns keyboard focus');
  };
  const dispatchKey = (target, key, opts = {}) => {
    const event = new win.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...opts});
    target.dispatchEvent(event);
    target.dispatchEvent(new win.KeyboardEvent('keyup',{key,bubbles:true}));
    return event;
  };
  const press = key => {
    if (!wc) return dispatchKey(document.activeElement, key);
    wc.sendInputEvent({type:'keyDown',keyCode:key});
    wc.sendInputEvent({type:'keyUp',keyCode:key});
  };

  const createAsset = async () => {
    const file = await app.vault.create(assetName, '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="blue"/></svg>');
    files.push(file);
    return file;
  };
  const answer = async confirm => {
    const modal = await until(() => document.querySelector('.modal .modal-button-container button:is(.mod-warning,.mod-destructive)')?.closest('.modal'), 'Obsidian delete dialog');
    assert.ok(modal.textContent.includes(assetName));
    const button = confirm ? modal.querySelector('button:is(.mod-warning,.mod-destructive)') :
      Array.from(modal.querySelectorAll('button')).find(b => /취소|cancel/i.test(b.textContent));
    assert.ok(button);
    button.click();
    await until(() => !document.querySelector('.modal'), 'delete dialog closed');
  };

  try {
    assert.equal(app.vault.getConfig('trashOption'), 'local', 'requires a disposable vault with local trash');
    assert.notEqual(app.vault.getConfig('promptDelete'), false);
    let attachment = await createAsset();
    const caption = ' *second* <!--iek-caption-->';
    const two = '# Test\n\n' + raw + ' / ' + raw + caption + '\n\n*my own paragraph*';
    const removed = two.replace(' / ' + raw, ' / ');
    const reading = await open('reading', two, 'preview');
    await until(() => reading.images().length === 2, 'two reading images');
    reading.images()[1].dispatchEvent(new win.PointerEvent('pointerover', {bubbles:true}));
    assert.equal(dispatchKey(document.body,'Delete').defaultPrevented,false);
    assert.equal(await reading.read(),two);
    await select(reading.images()[1]);
    assert.equal(dispatchKey(layer,'Enter').defaultPrevented,false);
    assert.equal(dispatchKey(layer,'Delete',{ctrlKey:true}).defaultPrevented,false);
    assert.equal(dispatchKey(layer,'Delete',{isComposing:true}).defaultPrevented,false);
    reading.images()[0].dispatchEvent(new win.PointerEvent('pointerover',{bubbles:true}));
    press('Delete');
    await answer(false);
    assert.equal(app.vault.getAbstractFileByPath(assetName),attachment);
    assert.equal(await reading.read(),two);
    await select(reading.images()[1]);
    press('Delete');
    await answer(true);
    await until(async () => await reading.read() === removed, 'reading removes clicked copy');
    assert.equal(leaf.view.getMode(),'preview');
    assert.equal(app.vault.getAbstractFileByPath(assetName),null);
    assert.equal(await app.vault.adapter.exists('.trash/' + assetName),true);

    await createAsset();
    const edit = await open('editing', two, 'source');
    await until(() => edit.images().length === 2, 'two live images');
    await select(edit.images()[1]);
    press('Delete');
    await answer(true);
    await until(async () => await edit.read() === removed, 'live delete saved');
    assert.equal(app.vault.getAbstractFileByPath(assetName),null);
    assert.equal(hasEditorFocus(),true);
    edit.editor.undo();
    await until(() => edit.editor.getValue() === two, 'editor undo restores embed text');
    assert.equal(app.vault.getAbstractFileByPath(assetName),null);

    attachment = await createAsset();
    const capLine = '*caption* <!--iek-caption-->';
    const before = '# Enter\n\n' + raw + '\n\n' + capLine + '\nFollowing paragraph';
    const newline = await open('enter', before, 'source');
    await select(newline.images()[0]);
    press('Enter');
    const expected = before.replace(capLine + '\n', capLine + '\n\n');
    await until(() => newline.editor.getValue() === expected && hasEditorFocus(), 'enter focuses the editor');
    assert.deepEqual(newline.editor.getCursor(),{line:5,ch:0});
    if (wc) await wc.insertText('바로 입력'); else newline.editor.replaceSelection('바로 입력');
    const typed = expected.replace(capLine + '\n\n',capLine + '\n바로 입력\n');
    await until(async () => await newline.read() === typed, 'typing goes below caption');
    const markdown = '![Photo|120](' + assetName + ' "saved title")';
    const eof = await open('eof', '# End\n\n' + markdown, 'source');
    await select(eof.images()[0]);
    press('Enter');
    await until(async () => await eof.read() === '# End\n\n' + markdown + '\n', 'enter at end of note');
    assert.deepEqual(eof.editor.getCursor(),{line:3,ch:0});
    assert.equal(hasEditorFocus(),true);
    assert.equal(app.vault.getAbstractFileByPath(assetName),attachment);

    const stale = await open('stale', two, 'source');
    await until(() => stale.images().length === 2, 'stale fixture');
    await select(stale.images()[1]);
    stale.editor.replaceRange('updated ',{line:0,ch:0});
    dispatchKey(layer,'Delete');
    await until(async () => await stale.read() === 'updated ' + two, 'concurrent edit saved without removing another embed');
    assert.equal(stale.editor.getValue(),'updated ' + two);
    assert.equal(document.querySelector('.modal'),null);
    assert.equal(app.vault.getAbstractFileByPath(assetName),attachment);
    return {input:wc ? 'electron' : 'DOM', readingDelete:true, cancel:true, trash:true, liveDeleteUndo:true, enterType:true, enterAtEnd:true, stale:true};
  } finally {
    leaf.detach();
    for (const file of files.reverse())
      if (app.vault.getAbstractFileByPath(file.path) === file) await app.vault.delete(file);
  }
};
