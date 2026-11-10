'use strict';
const {Plugin,MarkdownView,Notice}=require('obsidian');
const {Targets}=require('./targets.js');
const {Overlay,liveImageControls}=require('./overlay.js');
const {Preview,Properties,Picker}=require('./modals.js');
module.exports=class ImageEmbedKit extends Plugin {
  onload(){
    this.alive=true;this.targets=new Targets(this.app);this.overlays=new Map();this.modals=new Set();
    this.registerEditorExtension(liveImageControls(this.targets));
    this.registerMarkdownPostProcessor((el,ctx)=>this.targets.registerSection(el,ctx));
    const attach=d=>{if(d?.body && !this.overlays.has(d))this.overlays.set(d,new Overlay(this,d));};
    this.app.workspace.onLayoutReady(()=>{
      if(!this.alive)return;
      attach(this.app.workspace.containerEl.ownerDocument);
      for(const leaf of this.app.workspace.getLeavesOfType('markdown')){
        attach(leaf.view.containerEl.ownerDocument);
        if(leaf.view instanceof MarkdownView && leaf.view.getMode()==='preview')leaf.view.previewMode.rerender(true);
      }
    });
    this.registerEvent(this.app.workspace.on('window-open',(_,win)=>attach(win.document)));
    this.registerEvent(this.app.workspace.on('window-close',(_,win)=>{this.overlays.get(win.document)?.destroy();this.overlays.delete(win.document);}));
    this.addCommand({id:'edit-current-image',name:'현재 이미지 설정',editorCallback:(_editor,view)=>{
      const ref=this.targets.atCursor(view);
      if(ref)this.openProperties(ref);else new Notice('이미지 링크에 커서를 두거나 ‘노트 이미지 선택’을 사용하세요.');
    }});
    this.addCommand({id:'pick-image',name:'노트 이미지 선택',checkCallback:checking=>{
      const view=this.app.workspace.getActiveViewOfType(MarkdownView);
      if(!view?.file)return false;
      if(!checking)this.perform(async()=>{
        const refs=await this.targets.inNote(view);
        if(!refs.length){new Notice('이 노트에 편집할 로컬 이미지가 없습니다.');return;}
        this.open(new Picker(this.app,refs,ref=>this.openProperties(ref)));
      });
      return true;
    }});
  }
  async perform(fn){try{await fn();}catch(e){if(this.alive)new Notice(e?.message||'이미지를 수정하지 못했습니다.');}}
  open(modal){if(!this.alive)return;this.modals.add(modal);modal.afterClose=()=>this.modals.delete(modal);modal.open();}
  openProperties(ref){this.open(new Properties(this.app,ref,(r,c)=>this.save(r,c),r=>this.open(new Preview(this.app,{name:r.imageFile.name,src:r.src,alt:r.snapshot.spec.label}))));}
  propertiesFor(img){this.perform(async()=>this.openProperties(await this.targets.forImage(img)));}
  previewImage(img){
    const host=img.closest('.image-embed');
    const fileName=(host?.getAttribute('src')||'이미지').split('/').pop();
    this.open(new Preview(this.app,{name:fileName,src:img.currentSrc||img.src,alt:img.alt}));
  }
  resizeImage(img,width){this.perform(async()=>this.save(await this.targets.forImage(img),{width}));}
  save(ref,changes){if(!this.alive)throw Error('플러그인이 종료됐습니다.');return this.targets.save(ref,changes);}
  onunload(){
    this.alive=false;
    for(const modal of Array.from(this.modals).reverse())modal.close();
    for(const controller of this.overlays.values())controller.destroy();
    this.overlays.clear();
  }
};
