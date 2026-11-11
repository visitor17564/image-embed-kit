'use strict';
const {MarkdownView, editorLivePreviewField, parseLinktext, TFile} = require('obsidian');
const doc = require('./markdown.js');
const {editorFor, widgetRange, widgetEntry, imageEntries} = require('./live-images.js');
const imageTypes = /^(?:png|apng|jpe?g|jfif|gif|webp|svg|avif|bmp|ico)$/i;
const stale = '이미지의 노트 위치를 확인할 수 없습니다. 노트가 갱신된 뒤 다시 선택하세요.';

function resourceKey(url) {
  if (!url) return '';
  try { return decodeURIComponent(url.split(/[?#]/,1)[0]); } catch { return ''; }
}
function pickAt(candidates, pos, line) {
  // Prefer the start of a widget at two adjacent embed boundaries.
  const at=candidates.filter(c=>c.start===pos);
  if (at.length===1) return at[0];
  const inside=candidates.filter(c=>c.start<pos && pos<=c.end);
  if (inside.length===1) return inside[0];
  const sameLine=candidates.filter(c=>c.line===line);
  return sameLine.length===1?sameLine[0]:null;
}
class Targets {
  constructor(app) {
    this.app = app;
    this.sections = new WeakMap();
    this.pendingSaves = new WeakMap();
  }
  registerSection(el,ctx) {
    const section={el,ctx};
    this.sections.set(el,section);
    for (const node of el.querySelectorAll('.internal-embed, img')) this.sections.set(node,section);
  }
  viewFor(img) {
    return this.app.workspace.getLeavesOfType('markdown').map(l=>l.view)
      .find(v=>v instanceof MarkdownView && v.contentEl.contains(img)) || null;
  }
  accepts(img) {
    if (!img || img.tagName!=='IMG' || !img.closest('.markdown-preview-view, .markdown-source-view.is-live-preview')) return false;
    if (img.closest('a, table, .cm-table-widget, .markdown-embed, .metadata-container, .frontmatter-container, .view-header, .modal-container, pre, .cm-tooltip, .canvas-node, .block-language-dataviewjs, .block-language-dataview')) return false;
    const host=img.closest('.image-embed');
    if (/^(?:https?:|data:|blob:|\/\/)/i.test(host?.getAttribute('src')||'') || /^https?:/i.test(img.currentSrc||img.src)) return false;
    return !!host;
  }
  #fileFor(link, path) {
    if (!link || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(link)) return null;
    const t=this.app.metadataCache.getFirstLinkpathDest(parseLinktext(link).path,path);
    return t instanceof TFile && imageTypes.test(t.extension) ? t:null;
  }
  #rows(file,text) {
    const starts=doc.lineStarts(text), cache=this.app.metadataCache.getFileCache(file);
    // A literal pipe changes cell boundaries in Markdown tables. Restrict
    // command-palette writes as well as mouse edits to ordinary note content.
    const protectedSections=(cache?.sections||[]).filter(s=>['table','yaml','code'].includes(s.type));
    return (cache?.embeds||[]).flatMap(e=>{
      const pos=e.position, dest=this.#fileFor(e.link,file.path);
      if (!dest || !pos || !doc.parse(e.original)) return [];
      if (protectedSections.some(s=>s.position.start.line<=pos.start.line && pos.start.line<=s.position.end.line)) return [];
      const start=doc.offset(starts,pos.start), end=doc.offset(starts,pos.end);
      if (start<0 || end<start || text.slice(start,end)!==e.original) return [];
      return [{start,end,line:pos.start.line,col:pos.start.col,raw:e.original,dest}];
    });
  }
  #matches(img, candidate, notePath) {
    const host=img.closest('.image-embed');
    const t=this.#fileFor(host?.getAttribute('src'),notePath);
    if (t) return t.path===candidate.dest.path;
    const src=resourceKey(img.currentSrc||img.src);
    return !!src && src===resourceKey(this.app.vault.getResourcePath(candidate.dest));
  }
  #editingView(file, view) {
    if (view?.file===file && view.getMode()==='source') return view;
    return this.app.workspace.getLeavesOfType('markdown').map(l=>l.view)
      .find(v=>v instanceof MarkdownView && v.file===file && v.getMode()==='source') || null;
  }
  #liveRows(cm, file, from, to) {
    const rows = [];
    for (const entry of imageEntries(cm, from, to)) {
      const dest = this.#fileFor(entry.link, file.path);
      if (dest) rows.push({...entry, dest});
    }
    return rows;
  }
  #fromEditor(img, view) {
    const host = img.closest('.image-embed');
    const cm = editorFor(host);
    if (!cm?.state.field(editorLivePreviewField, false)) throw Error(stale);

    let widget = host;
    let range = widgetRange(cm, widget);
    // A callout is a single CodeMirror widget containing multiple rendered elements.
    if (range && range.from === range.to) {
      widget = host.closest('.cm-embed-block');
      range = widgetRange(cm, widget);
    }
    if (!range || range.from >= range.to) throw Error(stale);
    const file = view.file;
    let row;
    if (widget === host) {
      const entry = widgetEntry(cm, range);
      const dest = entry && this.#fileFor(entry.link, file.path);
      if (dest && this.#matches(img, {dest}, file.path)) row = {...entry, dest};
    } else {
      const rows = this.#liveRows(cm, file, range.from, range.to)
        .filter(item => this.#matches(img, item, file.path));
      if (!rows.length) throw Error(stale);
      const images = Array.from(widget.querySelectorAll('.image-embed img'))
        .filter(other => this.accepts(other) && this.#matches(other, rows[0], file.path));
      if (images.length === rows.length) row = rows[images.indexOf(img)];
    }
    if (!row) throw Error(stale);
    return this.#result(view, file, cm.state.doc.toString(), row);
  }
  #result(view,file,text,row) {
    return {view,file,path:file.path,line:row.line,imageFile:row.dest,src:this.app.vault.getResourcePath(row.dest),
      snapshot:doc.snapshot(text,row.start,row.raw)};
  }
  async forImage(img) {
    if (!this.accepts(img)) throw Error(stale);
    const view=this.viewFor(img), file=view?.file;
    if (!file) throw Error(stale);
    if (view.getMode()==='source') return this.#fromEditor(img,view);
    const editor=this.#editingView(file,view)?.editor;
    const text=editor?editor.getValue():await this.app.vault.read(file);
    if (!img.isConnected || view.file!==file) throw Error(stale);
    const candidates=this.#rows(file,text).filter(row=>this.#matches(img,row,file.path));
    if (!candidates.length) throw Error(stale);
    let row;
    let section, cur=img;
    while (cur && cur!==view.contentEl) {
      if (this.sections.has(cur)) {section=this.sections.get(cur); break;}
      cur=cur.parentElement;
    }
    if (section && section.ctx.sourcePath!==file.path) throw Error(stale);
    const info=section && (section.ctx.getSectionInfo(img) || section.ctx.getSectionInfo(section.el));
    if (info) {
      const local=candidates.filter(r=>r.line>=info.lineStart && r.line<=info.lineEnd);
      const container=section.el.contains(img)?section.el:img.closest('.el-p,.el-ul,.el-ol,.el-blockquote');
      const siblings=container ? Array.from(container.querySelectorAll('img')).filter(other=>this.accepts(other) && this.#matches(other,candidates[0],file.path)) : [];
      if (local.length===1 && siblings.length<=1) row=local[0];
      else if (local.length && local.length===siblings.length) row=local[siblings.indexOf(img)];
    }
    if (!row) throw Error('이 이미지의 위치를 확인할 수 없습니다. 명령 팔레트의 ‘노트 이미지 선택’에서 줄 번호를 선택하세요.');
    return this.#result(view,file,text,row);
  }
  atCursor(view) {
    if (!(view instanceof MarkdownView) || !view.file || view.getMode()!=='source') return null;
    const cm = editorFor(view.contentEl);
    if (!cm) return null;
    const pos = cm.state.selection.main.head;
    const line = cm.state.doc.lineAt(pos);
    const row = pickAt(this.#liveRows(cm, view.file, line.from, line.to), pos, line.number - 1);
    return row ? this.#result(view, view.file, cm.state.doc.toString(), row) : null;
  }
  async editBlock(img) {
    const ref = await this.forImage(img);
    const {view, file, snapshot} = ref;
    if (view.getMode() !== 'source' || view.file !== file || view.editor.getValue() !== snapshot.text) throw Error(stale);
    const editor = view.editor;
    const from = snapshot.spec.wiki ? snapshot.start + 3 : snapshot.start;
    const to = snapshot.spec.wiki ? snapshot.start + snapshot.spec.head.length : snapshot.end;
    editor.focus();
    editor.setSelection(editor.offsetToPos(from), editor.offsetToPos(to));
  }
  async inNote(view) {
    const file=view.file;if(!file)return [];
    const editingView=this.#editingView(file,view);
    if (editingView) {
      const cm = editorFor(editingView.contentEl);
      if (!cm) throw Error(stale);
      const text = cm.state.doc.toString();
      return this.#liveRows(cm, file).map(row => this.#result(view, file, text, row));
    }
    const text=await this.app.vault.read(file);
    if(view.file!==file)throw Error(stale);
    return this.#rows(file,text).map(row=>this.#result(view,file,text,row));
  }
  async #flushEditor(view, file) {
    // MarkdownView can coalesce a save requested during an active disk write.
    // Start the next save after the previous one settles so it reads the latest buffer.
    const write = async () => {
      if (view.file !== file) throw Error('노트가 전환되었습니다. 편집한 노트의 저장 상태를 확인하세요.');
      await view.save();
    };
    const previous = this.pendingSaves.get(file);
    const pending = previous ? previous.then(write, write) : write();
    this.pendingSaves.set(file, pending);
    try {
      await pending;
    } finally {
      if (this.pendingSaves.get(file) === pending) this.pendingSaves.delete(file);
    }
  }
  async save(ref, changes) {
    return this.#write(ref, doc.edit(ref.snapshot, changes));
  }

  async applySelectionKey(ref, key) {
    const {view, file, snapshot} = ref;
    if (view.file !== file || !view.contentEl.isConnected) throw Error(stale);
    const live = view.getMode() === 'source' && editorFor(view.contentEl)?.state.field(editorLivePreviewField, false);
    if (key !== 'Delete' && (key !== 'Enter' || !live)) return;
    const patch = key === 'Enter' ? doc.lineBelow(snapshot) : doc.removeEmbed(snapshot);
    await this.#write(ref, patch, live);
  }

  async #write(ref, patch, focusEditor = false) {
    if (ref.file.path!==ref.path || this.app.vault.getAbstractFileByPath(ref.path)!==ref.file) throw Error(stale);
    if (ref.snapshot.text.slice(patch.from,patch.to)===patch.insert) return this.pendingSaves.get(ref.file);
    const editingView=this.#editingView(ref.file,ref.view);
    if (editingView) {
      const editor=editingView.editor;
      const current=editor.getValue();
      // A previous write may have updated the editor before a disk save failed.
      // A retry of the same action may save that exact result without inserting it twice.
      if (current === ref.snapshot.text) {
        const change = {from: editor.offsetToPos(patch.from), to: editor.offsetToPos(patch.to), text: patch.insert};
        if (focusEditor) {
          const newline = patch.insert.lastIndexOf('\n');
          const caret = newline < 0 ? change.from : {line: change.from.line + 1, ch: patch.insert.length - newline - 1};
          if (this.app.workspace.activeLeaf !== editingView.leaf) this.app.workspace.setActiveLeaf(editingView.leaf, {focus: false});
          editor.transaction({changes: [change], selection: {from: caret}});
          editor.focus();
        } else {
          editor.replaceRange(change.text, change.from, change.to);
        }
      } else if (current !== doc.apply(ref.snapshot.text,ref.snapshot,patch)) {
        throw Error('편집 중 노트가 변경됐습니다. 이미지를 다시 선택하세요.');
      }
      await this.#flushEditor(editingView, ref.file);
    } else {
      await this.app.vault.process(ref.file,text=>doc.apply(text,ref.snapshot,patch));
    }
  }
}
module.exports={Targets};
