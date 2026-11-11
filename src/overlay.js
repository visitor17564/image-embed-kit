'use strict';
const {element,button}=require('./modals.js');
const {minWidth,maxWidth}=require('./markdown.js');
const {ViewPlugin}=require('@codemirror/view');
const {editorLivePreviewField}=require('obsidian');

const managedImage='data-iek-live-image';

// Mark only this editor's supported native image widgets. Other embeds keep
// their own controls, including a note or a callout that contains an image.
function liveImageControls(targets) {
  return ViewPlugin.define(editor => {
    const root = editor.contentDOM;
    const mark = host => {
      const img = host.querySelector(':scope > .image-wrapper > img, :scope > img');
      host.toggleAttribute(managedImage, !!img && targets.accepts(img) && !!targets.viewFor(img));
    };
    const scan = node => {
      if (node.nodeType !== 1) return;
      const host = node.closest('.image-embed');
      if (host) mark(host);
      else for (const image of node.querySelectorAll('.image-embed')) mark(image);
    };
    const observer = new root.ownerDocument.defaultView.MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') scan(record.target);
        else for (const node of record.addedNodes) scan(node);
      }
    });
    const clear = () => {
      observer.disconnect();
      for (const host of root.querySelectorAll('[' + managedImage + ']')) host.removeAttribute(managedImage);
    };
    const enable = () => {
      observer.observe(root, {childList: true, subtree: true, attributes: true, attributeFilter: ['src']});
      scan(root);
    };
    if (editor.state.field(editorLivePreviewField, false)) enable();
    return {
      update({state, startState}) {
        const live = state.field(editorLivePreviewField, false);
        if (live !== startState.field(editorLivePreviewField, false)) {
          if (live) enable();
          else clear();
        }
      },
      destroy: clear
    };
  });
}
function normal(e) {return !e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey;}
function stop(e) {e.preventDefault();e.stopPropagation();}
class Overlay {
  constructor(plugin,doc) {
    this.plugin=plugin;this.doc=doc;this.win=doc.defaultView;this.events=new this.win.AbortController();
    const layer=this.layer=element(doc.body,'div','iek-layer');layer.hidden=true;
    layer.tabIndex = -1;
    layer.setAttribute('role', 'group');
    layer.setAttribute('aria-label', '선택한 이미지');
    this.outline=element(layer,'div','iek-outline');
    for(const [dir,title] of [['left','왼쪽 너비 조절'],['right','오른쪽 너비 조절']]) {
      const b=button(layer,title,null,()=>{},'iek-grip iek-'+dir);
      b.textContent='';b.dataset.dir=dir;b.setAttribute('aria-label',title+' · 방향키로 10px 조절');
      b.addEventListener('pointerdown',e=>this.start(e,dir,b));
      b.addEventListener('keydown',e=>{
        if(!['ArrowLeft','ArrowRight','Enter',' '].includes(e.key))return;
        stop(e);const img=this.img;if(!img)return;
        if(e.key==='Enter'||e.key===' ') return this.plugin.propertiesFor(img);
        const sign=(e.key==='ArrowRight'?1:-1)*(dir==='left'?-1:1);
        const width=this.clamp(img,img.getBoundingClientRect().width+sign*(e.shiftKey?1:10));
        this.plugin.resizeImage(img,width);
      });
    }
    const tools=element(layer,'div','iek-tools');tools.setAttribute('role','toolbar');tools.setAttribute('aria-label','이미지 도구');
    button(tools,'확대보기','maximize-2',()=>this.img&&this.openPreview(),'iek-tool iek-open');
    button(tools,'너비와 캡션 편집','captions',()=>this.img&&this.openSettings(),'iek-tool iek-edit');
    this.blockEdit=button(tools,'이 블럭 수정','code-2',()=>this.editBlock(),'iek-tool iek-source');
    this.blockEdit.hidden=true;
    this.badge=element(layer,'div','iek-badge');
    const listen=(dest,type,fn,opts={})=>dest.addEventListener(type,fn,{...opts,signal:this.events.signal});
    listen(doc,'pointerover',e=>{
      if(this.drag || this.layer.contains(e.target)) {this.clearTimer();return;}
      if (this.selection && this.doc.activeElement === layer) return;
      const host=e.target.closest?.('.image-embed');
      const img=this.match(e.target.tagName==='IMG'?e.target:host?.querySelector('img'));
      if(img){this.show(img,false);return;}
      if(!this.pinned)this.later();
    },{capture:true});
    listen(doc,'pointerdown',e=>{
      if(this.layer.contains(e.target)||this.drag)return;
      const img=this.match(e.target);
      if(!img || !normal(e) || e.button!==0){this.hide();return;}
      this.select(img);stop(e);
    },{capture:true});
    listen(doc,'click',e=>{
      if(e.button===0 && normal(e) && this.match(e.target)){
        stop(e);this.select(e.target);
      }
    },{capture:true});
    listen(doc,'dblclick',e=>{
      if(e.button===0 && normal(e) && this.match(e.target)){
        stop(e);this.show(e.target,true);this.openPreview();
      }
    },{capture:true});
    listen(doc,'pointermove',e=>this.move(e),{capture:true});
    listen(doc,'pointerup',e=>this.end(e,false),{capture:true});
    listen(doc,'pointercancel',e=>this.end(e,true),{capture:true});
    listen(doc,'keydown',e=>this.keydown(e),{capture:true});
    listen(doc,'keyup',e=>{if (this.heldKey === e.key) this.heldKey = null;},{capture:true});
    listen(layer,'focusout',e=>{if (this.selection && !layer.contains(e.relatedTarget)) this.hide();});
    listen(doc,'scroll',()=>this.schedule(),{capture:true,passive:true});
    listen(this.win,'resize',()=>this.schedule());
    listen(this.win,'blur',()=>{this.heldKey = null;this.hide();});
    this.observer=new this.win.ResizeObserver(()=>this.schedule());
  }
  match(node) {
    if(!this.plugin.targets.accepts(node))return null;
    if(node===this.img && node.isConnected)return node;
    return this.plugin.targets.viewFor(node) ? node:null;
  }
  clearTimer(){if(this.timer){this.win.clearTimeout(this.timer);this.timer=0;}}
  later(){this.clearTimer();this.timer=this.win.setTimeout(()=>{if(!this.pinned&&!this.layer.contains(this.doc.activeElement))this.hide();},180);}
  select(img) {
    this.show(img, true);
    if (this.layer.hidden) return;
    if (!this.selection) {
      this.selection = this.plugin.targets.forImage(img).then(ref => ({ref}), error => ({error}));
    }
    this.layer.setAttribute('aria-keyshortcuts', this.blockEdit.hidden ? 'Delete' : 'Delete Enter');
    this.layer.focus({preventScroll: true});
  }
  keydown(e) {
    if (this.heldKey === e.key && e.repeat) { stop(e); return; }
    if (e.key === 'Escape' && !this.layer.hidden) { stop(e); this.hide(); return; }
    if (e.target !== this.layer || this.doc.activeElement !== this.layer || !this.selection || this.drag ||
        !normal(e) || e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
    if (e.key !== 'Delete' && (e.key !== 'Enter' || this.blockEdit.hidden)) return;
    stop(e);
    if (e.repeat) return;
    this.heldKey = e.key;
    const pending = this.selection;
    const key = e.key;
    this.hide();
    this.plugin.perform(async () => {
      const {ref, error} = await pending;
      if (error) throw error;
      if (this.plugin.alive) await this.plugin.targets.applySelectionKey(ref, key);
    });
  }
  show(img,pin){
    this.clearTimer();
    if(this.img!==img) {
      this.selection=null;this.pinned=false;this.observer.disconnect();this.img=img;this.observer.observe(img);
    }
    const live=!!img.closest('.markdown-source-view.is-live-preview');
    this.blockEdit.hidden=!live;
    if(live)img.closest('.image-embed').setAttribute(managedImage,'');
    this.pinned=this.pinned||pin;this.layer.hidden=false;this.position();
  }
  schedule(){
    if(this.img&&!this.raf)this.raf=this.win.requestAnimationFrame(()=>{this.raf=0;this.position();});
  }
  position(){
    if(!this.img?.isConnected){if(this.img)this.hide();return;}
    if(this.drag)return;
    const r=this.img.getBoundingClientRect();
    const pane=this.img.closest('.workspace-leaf-content')?.getBoundingClientRect();
    if(r.width<1||r.height<1||r.bottom<=Math.max(0,pane?.top||0)||r.top>=Math.min(this.win.innerHeight,pane?.bottom||this.win.innerHeight)){this.hide();return;}
    this.box(r.left,r.top,r.width,r.height);
  }
  box(x,y,w,h){
    Object.assign(this.layer.style,{left:x+'px',top:y+'px',width:w+'px',height:h+'px'});
    this.layer.classList.toggle('iek-small',w<(this.blockEdit.hidden?85:110)||h<45);
  }
  clamp(img,width){
    const content=img.closest('.cm-line, p, li') || img.closest('.markdown-preview-sizer,.cm-content');
    const inner=content?.getBoundingClientRect().width;
    const bound=Math.max(minWidth,Math.min(maxWidth,inner>0?Math.floor(inner):maxWidth));
    return Math.max(minWidth,Math.min(bound,Math.round(width)));
  }
  start(e,dir,handle){
    if(e.button!==0||!this.img||this.drag)return;
    stop(e);this.clearTimer();this.pinned=true;const img=this.img,r=img.getBoundingClientRect();
    const pending=this.plugin.targets.forImage(img).then(ref=>({ref}),error=>({error}));
    this.drag={img,dir,handle,id:e.pointerId,startX:e.clientX,r,width:Math.round(r.width),pending,
      ratio:img.naturalWidth&&img.naturalHeight?img.naturalWidth/img.naturalHeight:r.width/r.height};
    try {handle.setPointerCapture(e.pointerId);} catch { /* document listeners also track the drag */ }
    this.layer.classList.add('iek-dragging');
    this.ghost=element(this.layer,'img','iek-ghost');this.ghost.alt='';this.ghost.src=img.currentSrc||img.src;
    img.classList.add('iek-origin');this.badge.textContent=Math.round(r.width)+' px';
  }
  move(e){
    const d=this.drag;if(!d||e.pointerId!==d.id)return;
    stop(e);const dx=(e.clientX-d.startX)*(d.dir==='right'?1:-1);
    d.width=this.clamp(d.img,d.r.width+dx);
    this.box(d.dir==='left'?d.r.right-d.width:d.r.left,d.r.top,d.width,d.width/d.ratio);
    this.badge.textContent=d.width+' px';
  }
  release(){
    const d=this.drag;if(!d)return;
    this.drag=null; d.img.classList.remove('iek-origin');this.ghost?.remove();this.ghost=null;
    this.layer.classList.remove('iek-dragging');
    try{if(d.handle.hasPointerCapture(d.id))d.handle.releasePointerCapture(d.id);}catch{}
  }
  end(e,cancel){
    const d=this.drag;if(!d||e.pointerId!==d.id)return;
    if(!cancel)this.move(e);
    this.release();this.hide();
    if(!cancel&&d.width!==Math.round(d.r.width))this.plugin.perform(async()=>{
      const {ref,error}=await d.pending;if(error)throw error;await this.plugin.save(ref,{width:d.width});
    });
  }
  openSettings(){const i=this.img;this.hide();this.plugin.propertiesFor(i);}
  openPreview(){const i=this.img;this.hide();this.plugin.previewImage(i);}
  editBlock() {
    const img = this.img;
    if (!img?.isConnected) { this.hide(); return; }
    const native = img.closest('.image-embed').querySelector(':scope > .embed-actions > .edit-block-button');
    this.hide();
    if (native) native.click();
    else this.plugin.perform(() => this.plugin.targets.editBlock(img));
  }
  hide(){
    this.clearTimer();this.release();this.selection=null;this.pinned=false;this.img=null;this.observer?.disconnect();
    this.layer.hidden=true;
  }
  destroy(){
    this.hide();this.events.abort();if(this.raf)this.win.cancelAnimationFrame(this.raf);this.layer.remove();
  }
}
module.exports={Overlay,liveImageControls};
