'use strict';
const {Modal, SuggestModal, setIcon} = require('obsidian');
const {minWidth,maxWidth,maxCaption}=require('./markdown.js');

function element(parent,tag,cls,text) {
  const el=parent.ownerDocument.createElement(tag);
  if (cls) el.className=cls;
  if (text!=null) el.textContent=text;
  parent.append(el); return el;
}
function button(parent,label,icon,handler,cls) {
  const b=element(parent,'button',cls||'iek-button'); b.type='button';
  b.setAttribute('aria-label',label); b.title=label;
  if(icon) setIcon(b,icon); else b.textContent=label;
  b.addEventListener('click',handler);return b;
}
class Preview extends Modal {
  constructor(app,info) { super(app);this.info=info;this.factor=null; }
  onOpen() {
    this.modalEl.classList.add('iek-preview');this.titleEl.textContent=this.info.name;
    const stage=this.stage=element(this.contentEl,'div','iek-stage'); stage.tabIndex=0;
    stage.setAttribute('aria-label','이미지 확대보기');
    const img=this.img=element(stage,'img','iek-full-image');
    img.alt=this.info.alt||this.info.name;img.draggable=false;
    img.addEventListener('load',()=>this.paint());
    img.addEventListener('error',()=>{this.status.textContent='이미지를 불러올 수 없습니다.';});
    const bar=element(this.contentEl,'div','iek-preview-bar');
    this.status=element(bar,'span','iek-info','원본 크기 확인 중');this.status.setAttribute('aria-live','polite');
    const controls=element(bar,'div','iek-preview-controls');
    button(controls,'축소','zoom-out',()=>this.zoom(1/1.25));
    button(controls,'확대','zoom-in',()=>this.zoom(1.25));
    button(controls,'100%',null,()=>{this.factor=1;this.paint();});
    button(controls,'화면 맞춤',null,()=>{this.factor=null;this.paint();});
    for (const [key, action] of [['+',()=>this.zoom(1.25)],['=',()=>this.zoom(1.25)],['-',()=>this.zoom(1/1.25)],['0',()=>{this.factor=null;this.paint();}]]) {
      this.scope.register([],key,evt=>{evt.preventDefault();action();return false;});
    }
    stage.addEventListener('wheel',e=>{if(e.ctrlKey||e.metaKey){e.preventDefault();this.zoom(e.deltaY<0?1.25:1/1.25);}}, {passive:false});
    this.resize=new stage.ownerDocument.defaultView.ResizeObserver(()=>this.paint());
    this.resize.observe(stage);img.src=this.info.src;this.paint();
  }
  zoom(step) {this.factor=Math.max(.05,Math.min(8,(this.current||1)*step));this.paint();}
  paint() {
    const i=this.img;if(!i?.naturalWidth || !this.stage.clientWidth) return;
    this.current=this.factor??Math.min(1,this.stage.clientWidth/i.naturalWidth,this.stage.clientHeight/i.naturalHeight);
    i.style.width=Math.max(1,Math.round(i.naturalWidth*this.current))+'px';
    this.status.textContent=i.naturalWidth+' × '+i.naturalHeight+' px · '+Math.round(100*this.current)+'%';
  }
  onClose() {this.resize?.disconnect();this.contentEl.empty();this.afterClose?.();}
}

class Properties extends Modal {
  constructor(app,ref,save,preview) {super(app);this.ref=ref;this.save=save;this.preview=preview;}
  onOpen() {
    const ref=this.ref,s=ref.snapshot;
    this.modalEl.classList.add('iek-properties');
    this.titleEl.textContent='이미지 설정';
    element(this.contentEl,'div','iek-filename',ref.imageFile.path);
    const form=element(this.contentEl,'form','iek-form');
    const widthLabel=element(form,'label','iek-field');
    element(widthLabel,'span','iek-field-title','표시 너비 (px)');
    const width=element(widthLabel,'input','iek-width');
    width.type='number';width.min=String(minWidth);width.max=String(maxWidth);width.step='1';
    const oldWidth=s.spec.width==null?'':String(s.spec.width);
    width.value=oldWidth;width.placeholder='자동';
    element(widthLabel,'small','iek-help','비워 두면 노트의 기본 크기로 표시합니다.');
    const captionLabel=element(form,'label','iek-field');
    element(captionLabel,'span','iek-field-title','캡션');
    const caption=element(captionLabel,'input','iek-caption-input');
    caption.type='text';caption.value=s.caption.value;caption.maxLength=maxCaption;
    caption.placeholder='이미지 아래에 표시할 설명';
    const hideLabel=element(form,'label','iek-hide-row');
    const hide=element(hideLabel,'input','iek-caption-hide');hide.type='checkbox';hide.checked=s.caption.hidden;
    element(hideLabel,'span','','캡션 내용은 보관하고 화면에서 숨기기');
    const error=element(form,'div','iek-error');error.setAttribute('role','alert');
    const bar=element(form,'div','iek-form-bar');
    button(bar,'확대보기',null,()=>this.preview(ref));
    button(bar,'취소',null,()=>this.close());
    const ok=element(bar,'button','mod-cta iek-save','저장');ok.type='submit';
    form.addEventListener('submit',async e=>{
      e.preventDefault();if(ok.disabled)return;
      const changes={caption:caption.value,hidden:hide.checked};
      if(width.value!==oldWidth)changes.width=width.value===''?null:Number(width.value);
      ok.disabled=true;
      try {await this.save(ref,changes);this.close();}
      catch(ex){error.textContent=ex.message;ok.disabled=false;}
    });
    caption.focus();
  }
  onClose(){this.contentEl.empty();this.afterClose?.();}
}
class Picker extends SuggestModal {
  constructor(app,refs,choose) { super(app);this.refs=refs;this.choose=choose;this.setPlaceholder('이미지 파일명, 캡션 또는 줄 번호 검색'); }
  getSuggestions(query) {
    const q=query.trim().toLocaleLowerCase();
    return this.refs.filter(r=>(r.imageFile.path+' '+(r.line+1)+' '+r.snapshot.caption.value).toLocaleLowerCase().includes(q));
  }
  renderSuggestion(r,el) {
    element(el,'div','iek-picker-title',r.imageFile.name+' · '+(r.line+1)+'행');
    element(el,'small','iek-help',r.snapshot.caption.value || r.imageFile.path);
  }
  onChooseSuggestion(r) {this.choose(r);}
  onClose(){super.onClose();this.afterClose?.();}
}
module.exports={element,button,Preview,Properties,Picker};
