'use strict';
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label) {
  for (let i = 0; i < 120; i++) {
    const value = await check();
    if (value) return value;
    await pause(40);
  }
  throw Error('Timed out: ' + label);
}

// All files and the trash destination must belong to a disposable vault.
module.exports = async function verifyImageMenu(app, {wc}) {
  assert.equal(app.vault.getConfig('trashOption'), 'local');
  assert.notEqual(app.vault.getConfig('promptDelete'), false);
  const id = 'embed-menu-' + randomUUID(), files = [];
  const leaf = app.workspace.getLeaf('tab'), doc = leaf.containerEl.ownerDocument, win = doc.defaultView;
  const create = async (name, content) => {
    const file = await app.vault.create(id + name, content); files.push(file); return file;
  };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="140"><rect width="240" height="140" fill="teal"/></svg>';
  const images = () => Array.from(leaf.view.contentEl.querySelectorAll((leaf.view.getMode() === 'source' ?
    '.markdown-source-view.is-live-preview' : '.markdown-preview-view') + ' .image-embed img'));
  const right = async index => {
    const img = await until(() => images()[index]?.naturalWidth && app.metadataCache.getFileCache(leaf.view.file)?.embeds?.[index] && images()[index], 'loaded image');
    img.scrollIntoView({block:'nearest'});
    const bounds = img.getBoundingClientRect(), x = Math.round(bounds.left + bounds.width * .45),
      y = Math.round(bounds.top + bounds.height * .8);
    assert.equal(doc.elementFromPoint(x,y),img);
    wc.sendInputEvent({type:'mouseMove',x,y});
    wc.sendInputEvent({type:'mouseDown',button:'right',clickCount:1,x,y});
    wc.sendInputEvent({type:'mouseUp',button:'right',clickCount:1,x,y});
    const menu = await until(() => doc.querySelector('.menu .menu-item-title')?.closest('.menu'), 'image context menu');
    assert.equal(doc.querySelector('.lightbox, .iek-preview'),null);
    return menu;
  };
  const titles = m => Array.from(m.querySelectorAll('.menu-item-title'), n => n.textContent);
  const item = (menu, re) => {
    const button = Array.from(menu.querySelectorAll('.menu-item')).find(n => re.test(n.querySelector('.menu-item-title')?.textContent || ''));
    assert.ok(button, re + ' in ' + titles(menu)); return button;
  };
  const close = async () => {
    wc.sendInputEvent({type:'keyDown',keyCode:'Escape'}); wc.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await until(() => !doc.querySelector('.menu'), 'menu closed');
  };
  const confirm = () => until(() => doc.querySelector('.modal .modal-button-container button:is(.mod-warning,.mod-destructive)')?.closest('.modal'), 'file delete confirmation');
  try {
    const image = await create('.svg',svg), replacement = await create('-swap.svg',svg);
    const raw = '![[' + image.name + '|140]]', cap = ' *caption* <!--iek-caption-->';
    const source = '# Menu\n\n' + raw + ' + ' + raw + cap + '\n\nNext';
    const note = await create('.md', source), other = await create('-other.md','Reference ' + raw);
    const read = () => app.vault.adapter.read(note.path);
    const open = async mode => {
      await leaf.setViewState({type:'markdown',state:{file:note.path,mode,source:false},active:true});
      if (mode === 'source') leaf.view.editor.setCursor({line:0,ch:0});
      await until(() => images().length === 2 && images()[1].naturalWidth && app.metadataCache.getFileCache(note)?.embeds?.length === 2, mode);
    };
    await open('source');
    const native = titles(await right(1)); await close();
    await open('preview');
    const bounds = images()[1].getBoundingClientRect(), x = Math.round(bounds.left + bounds.width * .45),
      y = Math.round(bounds.top + bounds.height * .8);
    for (const clickCount of [1,2]) {
      wc.sendInputEvent({type:'mouseDown',button:'left',clickCount,x,y});
      wc.sendInputEvent({type:'mouseUp',button:'left',clickCount,x,y});
    }
    await until(() => doc.querySelector('.iek-preview'), 'double-click opens the full-size viewer');
    wc.sendInputEvent({type:'keyDown',keyCode:'Escape'}); wc.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await until(() => !doc.querySelector('.iek-preview'), 'closed viewer');
    let menu = await right(1);
    const reading = titles(menu);
    for (const title of native) assert.ok(reading.includes(title), 'missing native action ' + title + ': ' + reading);
    assert.deepEqual(reading.filter(n => native.includes(n)),native,'same ordering as the editing menu');
    assert.equal(new Set(reading).size,reading.length,'no duplicate menu entries');
    item(menu,/^(크기 재설정|Reset size)$/i).click();
    const noWidth = '![[' + image.name + ']]';
    await until(async () => await read() === source.replace(' + ' + raw, ' + ' + noWidth), 'reset only selected width');
    await until(() => images()[1]?.getBoundingClientRect().width > 150, 'render reset size');

    menu = await right(1);
    item(menu,/파일 바꿔치기|Swap file/i).click();
    const input = await until(() => doc.querySelector('.prompt-input'), 'replacement picker');
    input.value = replacement.name; input.dispatchEvent(new win.Event('input',{bubbles:true}));
    const result = await until(() => Array.from(doc.querySelectorAll('.suggestion-item')).find(n => n.textContent.includes(replacement.name)), 'replacement found');
    result.click();
    const swapped = source.replace(' + ' + raw,' + ![[' + replacement.name + ']]');
    await until(async () => await read() === swapped, 'swap only selected embed');
    await until(() => images()[1]?.closest('.image-embed')?.getAttribute('src') === replacement.name, 'replacement rendered');

    menu = await right(1); item(menu,/^(이름 변경|Rename)$/i).click();
    const rename = await until(() => doc.querySelector('.modal form input'), 'rename input');
    assert.equal(rename.value, replacement.basename);
    const oldPath = replacement.path;
    rename.value = id + '-renamed';
    rename.closest('form').requestSubmit();
    const updateLinks = await until(() => Array.from(doc.querySelectorAll('.modal button')).find(b =>
      /한 번만 업데이트|update once|just once/i.test(b.textContent)) || !doc.querySelector('.modal'), 'Obsidian rename response');
    if (updateLinks !== true) updateLinks.click();
    await until(() => replacement.path === id + '-renamed.svg' && !doc.querySelector('.modal'), 'renamed file');
    assert.equal(app.vault.getAbstractFileByPath(oldPath),null);
    await until(() => images()[1]?.closest('.image-embed')?.getAttribute('src') === replacement.name, 'renamed link rendered');
    menu = await right(1); item(menu,/^(이미지 제거|Remove image)$/i).click();
    const unlinked = source.replace(' + ' + raw,' + ');
    await until(async () => await read() === unlinked, 'unlink selected embed');
    assert.equal(app.vault.getAbstractFileByPath(replacement.path),replacement);
    await until(() => images().length === 1, 'render remaining image');
    const clipboard = win.navigator.clipboard, origWrite = Object.getOwnPropertyDescriptor(clipboard, 'write');
    let copied;
    try {
      Object.defineProperty(clipboard,'write',{configurable:true,value:async values => {copied = await values[0].getType('image/png');}});
      menu = await right(0); item(menu,/^(이미지 복사|Copy image)$/i).click();
      await until(() => copied?.type === 'image/png' && copied.size > 0, 'copy original as PNG');
    } finally {
      if (origWrite) Object.defineProperty(clipboard,'write',origWrite); else delete clipboard.write;
    }
    menu = await right(0); item(menu,/^(이미지 삭제|Delete image)$/i).click();
    const cancel = await confirm(); assert.ok(cancel.textContent.includes(image.name));
    Array.from(cancel.querySelectorAll('button')).find(b => /취소|cancel/i.test(b.textContent)).click();
    await until(() => !doc.querySelector('.modal'), 'cancel delete');
    assert.equal(await read(),unlinked); assert.equal(app.vault.getAbstractFileByPath(image.path),image);
    menu = await right(0); item(menu,/^(이미지 삭제|Delete image)$/i).click();
    (await confirm()).querySelector('button:is(.mod-warning,.mod-destructive)').click();
    await until(async () => await read() === unlinked.replace(raw,''), 'remove embed after file deletion');
    assert.equal(await app.vault.adapter.read(other.path),'Reference ' + raw);
    assert.equal(app.vault.getAbstractFileByPath(image.path),null);
    assert.equal(await app.vault.adapter.read('.trash/' + image.name),svg);
    assert.equal(leaf.view.getMode(),'preview');

    const remaining = '![[' + replacement.name + ']]', parallel = await create('-parallel.md', '# Links\n\n' + remaining + ' / ' + remaining);
    await leaf.setViewState({type:'markdown',state:{file:parallel.path,mode:'preview'},active:true});
    menu = await right(1); item(menu,/^(이미지 삭제|Delete image)$/i).click();
    const dialog = await confirm();
    await app.vault.process(parallel, text => 'Edited while confirming\n' + text);
    dialog.querySelector('button:is(.mod-warning,.mod-destructive)').click();
    await until(async () => await app.vault.adapter.read(parallel.path) === 'Edited while confirming\n# Links\n\n' + remaining + ' / ', 'concurrent note edit retained');
    assert.equal(app.vault.getAbstractFileByPath(replacement.path),null);

    const immediate = await create('-immediate.svg',svg), immediateLink = '![[' + immediate.name + ']]';
    const noPrompt = await create('-immediate.md', '# No prompt\n\n' + immediateLink);
    await leaf.setViewState({type:'markdown',state:{file:noPrompt.path,mode:'preview'},active:true});
    const oldPrompt = app.vault.getConfig('promptDelete');
    try {
      app.vault.setConfig('promptDelete',false);
      menu = await right(0); item(menu,/^(이미지 삭제|Delete image)$/i).click();
      await until(async () => await app.vault.adapter.read(noPrompt.path) === '# No prompt\n\n', 'vault skips confirmation');
      assert.equal(doc.querySelector('.modal'),null);
      assert.equal(await app.vault.adapter.read('.trash/' + immediate.name),svg);
    } finally { app.vault.setConfig('promptDelete',oldPrompt); }
    return {native,reading,doubleClick:true,copy:true,swap:true,reset:true,rename:true,unlink:true,cancel:true,delete:true,otherNotePreserved:true,concurrent:true,noPrompt:true};
  } finally {
    leaf.detach();
    for (const file of files.reverse()) if (app.vault.getAbstractFileByPath(file.path) === file) await app.vault.delete(file);
  }
};
