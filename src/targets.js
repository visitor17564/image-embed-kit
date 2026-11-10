'use strict';
const {MarkdownView, editorLivePreviewField, parseLinktext, TFile} = require('obsidian');
const {EditorView} = require('@codemirror/view');
const doc = require('./markdown.js');
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
  constructor(app) { this.app=app; this.sections=new WeakMap(); }
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
  #openEditor(file, view) {
    if (view?.file===file && view.getMode()==='source') return view.editor;
    return this.app.workspace.getLeavesOfType('markdown').map(l=>l.view)
      .find(v=>v instanceof MarkdownView && v.file===file && v.getMode()==='source')?.editor || null;
  }
  #result(view,file,text,row) {
    return {view,file,path:file.path,line:row.line,imageFile:row.dest,src:this.app.vault.getResourcePath(row.dest),
      snapshot:doc.snapshot(text,row.start,row.raw)};
  }
  async forImage(img) {
    if (!this.accepts(img)) throw Error(stale);
    const view=this.viewFor(img), file=view?.file;
    if (!file) throw Error(stale);
    const editor=this.#openEditor(file,view);
    const text=editor?editor.getValue():await this.app.vault.read(file);
    if (!img.isConnected || view.file!==file) throw Error(stale);
    const candidates=this.#rows(file,text).filter(row=>this.#matches(img,row,file.path));
    if (!candidates.length) throw Error(stale);
    let row;
    if (view.getMode()==='source') {
      // A non-editable image widget itself does not expose the owning EditorView.
      const cmRoot=img.closest('.cm-editor');
      const cm=cmRoot && EditorView.findFromDOM(cmRoot);
      if (!cm || !cm.state.field(editorLivePreviewField,false)) throw Error(stale);
      const pos=cm.posAtDOM(img.closest('.image-embed')||img);
      row=pickAt(candidates,pos,cm.state.doc.lineAt(pos).number-1);
    } else {
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
    }
    if (!row) throw Error('이 이미지의 위치를 확인할 수 없습니다. 명령 팔레트의 ‘노트 이미지 선택’에서 줄 번호를 선택하세요.');
    return this.#result(view,file,text,row);
  }
  atCursor(view) {
    if (!(view instanceof MarkdownView) || !view.file || view.getMode()!=='source') return null;
    const editor=view.editor, text=editor.getValue(), cursor=editor.getCursor();
    const row=pickAt(this.#rows(view.file,text),editor.posToOffset(cursor),cursor.line);
    return row ? this.#result(view,view.file,text,row) : null;
  }
  async inNote(view) {
    const file=view.file;if(!file)return [];
    const editor=this.#openEditor(file,view);
    const text=editor?editor.getValue():await this.app.vault.read(file);
    if(view.file!==file)throw Error(stale);
    return this.#rows(file,text).map(row=>this.#result(view,file,text,row));
  }
  async save(ref, changes) {
    if (ref.file.path!==ref.path || this.app.vault.getAbstractFileByPath(ref.path)!==ref.file) throw Error(stale);
    const patch=doc.edit(ref.snapshot,changes);
    if (ref.snapshot.text.slice(patch.from,patch.to)===patch.insert) return;
    const editor=this.#openEditor(ref.file,ref.view);
    if (editor) {
      doc.apply(editor.getValue(),ref.snapshot,patch); // guard against a stale dialog or drag
      editor.replaceRange(patch.insert,editor.offsetToPos(patch.from),editor.offsetToPos(patch.to));
    } else {
      await this.app.vault.process(ref.file,text=>doc.apply(text,ref.snapshot,patch));
    }
  }
}
module.exports={Targets};
