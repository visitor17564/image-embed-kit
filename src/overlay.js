'use strict';
const {element,button}=require('./modals.js');
const {minWidth,maxWidth}=require('./markdown.js');
function normal(e) {return !e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey;}
function stop(e) {e.preventDefault();e.stopPropagation();}
class Overlay {
  constructor(plugin,doc) {
    this.plugin=plugin;this.doc=doc;this.win=doc.defaultView;this.events=new this.win.AbortController();
    const layer=this.layer=element(doc.body,'div','iek-layer');layer.hidden=true;
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
    this.badge=element(layer,'div','iek-badge');
    const listen=(dest,type,fn,opts={})=>dest.addEventListener(type,fn,{...opts,signal:this.events.signal});
    listen(doc,'pointerover',e=>{
      if(this.drag || this.layer.contains(e.target)) {this.clearTimer();return;}
      const img=this.match(e.target);
      if(img){this.show(img,false);return;}
      if(!this.pinned)this.later();
    },{capture:true});
    listen(doc,'pointerdown',e=>{
      if(this.layer.contains(e.target)||this.drag)return;
      const img=this.match(e.target);
      if(!img || !normal(e) || e.button!==0){this.hide();return;}
      this.show(img,true);stop(e);
    },{capture:true});
    listen(doc,'click',e=>{
      if(e.button===0 && normal(e) && this.match(e.target)){
        stop(e);this.show(e.target,true);
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
    listen(doc,'keydown',e=>{if(e.key==='Escape' && !layer.hidden){stop(e);this.hide();}},{capture:true});
    listen(doc,'scroll',()=>this.schedule(),{capture:true,passive:true});
    listen(this.win,'resize',()=>this.schedule());
    listen(this.win,'blur',()=>this.hide());
    this.observer=new this.win.ResizeObserver(()=>this.schedule());
  }
  match(node) {
    if(!this.plugin.targets.accepts(node))return null;
    if(node===this.img && node.isConnected)return node;
    return this.plugin.targets.viewFor(node) ? node:null;
  }
  clearTimer(){if(this.timer){this.win.clearTimeout(this.timer);this.timer=0;}}
  later(){this.clearTimer();this.timer=this.win.setTimeout(()=>{if(!this.pinned&&!this.layer.contains(this.doc.activeElement))this.hide();},180);}
  show(img,pin){
    this.clearTimer();
    if(this.img!==img) {
      this.pinned=false;this.observer.disconnect();this.img=img;this.observer.observe(img);
    }
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
    this.layer.classList.toggle('iek-small',w<85||h<45);
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
  hide(){
    this.clearTimer();this.release();this.pinned=false;this.img=null;this.observer?.disconnect();
    this.layer.hidden=true;
  }
  destroy(){
    this.hide();this.events.abort();if(this.raf)this.win.cancelAnimationFrame(this.raf);this.layer.remove();
  }
}
module.exports={Overlay};
