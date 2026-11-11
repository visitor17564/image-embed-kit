const {test}=require('node:test');
const assert=require('node:assert/strict');
const m=require('../src/markdown.js');
function update(text,raw,where,changes) {
  const p=where==='last'?text.lastIndexOf(raw):text.indexOf(raw);
  const s=m.snapshot(text,p,raw);return m.apply(text,s,m.edit(s,changes));
}

test('두 번째 임베드의 폭만 바꾸며 원래 alias, 대상, 앞뒤 본문을 보존한다',()=>{
  const raw='![[그림/한 장.png#outline|대체 텍스트|360x180]]';
  const text=raw+'\n\n둘째: '+raw+' 나머지';
  assert.equal(update(text,raw,'last',{width:240}),raw+'\n\n둘째: ![[그림/한 장.png#outline|대체 텍스트|240]] 나머지');
});
test('표준 Markdown 이미지의 alt, URL escape, 괄호와 title을 그대로 둔다',()=>{
  const raw='![옛 \\[보기\\]|200](<a%20b(2).webp> "title")';
  assert.equal(m.withWidth(raw,400),raw.replace('|200','|400'));
  assert.equal(m.withWidth(raw,null),raw.replace('|200',''));
  assert.equal(m.withWidth('![](x.png)',96),'![96](x.png)');
});
test('캡션만 편집하면 명시적 높이와 CRLF를 보존하며 삭제로 원문을 완전히 복구한다',()=>{
  const raw='![[x.png|ALT|300x100]]',text='머리\r\n\r\n'+raw+'\r\n\r\n*기존 사용자 캡션*';
  const value='호수 & <b> **아침** ![[다른 이미지.png]] | 50% \\';
  const next=update(text,raw,0,{caption:value});
  assert.ok(next.startsWith('머리\r\n\r\n'+raw+'\r\n\r\n*'));
  assert.equal(m.snapshot(next,next.indexOf(raw),raw).caption.value,value);
  assert.equal(update(next,raw,0,{caption:''}),text);
});
test('인라인 이미지의 캡션은 그 이미지에만 붙고 숨기기와 다시 표시할 때 내용이 같다',()=>{
  const raw='![[a.svg]]',text='사진 '+raw+' A / '+raw+' B';
  const cap='둘째 --><img> &amp; &#45; \\\\*';
  const visible=update(text,raw,'last',{caption:cap});
  const hidden=update(visible,raw,'last',{hidden:true});
  assert.ok(!hidden.includes('\n')); assert.equal(hidden.split('-->').length,2);
  const snap=m.snapshot(hidden,hidden.lastIndexOf(raw),raw);
  assert.equal(snap.caption.hidden,true);assert.equal(snap.caption.value,cap);
  assert.equal(update(hidden,raw,'last',{hidden:false}),visible);
  assert.equal(update(hidden,raw,'last',{caption:''}),text);
});
test('현재 문서가 바뀌었거나 캐시 위치가 틀리면 저장하지 않는다',()=>{
  const text='![[same.webp]]\n![[same.webp]]',raw='![[same.webp]]';
  const s=m.snapshot(text,0,raw);
  assert.throws(()=>m.apply('변경\n'+text,s,m.edit(s,{width:64})),/노트가 변경/);
  assert.throws(()=>m.snapshot(text,2,raw),/위치가 변경/);
  assert.throws(()=>m.withWidth(raw,0),/너비/);
  assert.equal(m.parse('![alt][ref]'),null);
});
test('Obsidian line/col works with astral Unicode and CRLF',()=>{
  const text='😀\r\n동일 ![[a.png]]',starts=m.lineStarts(text);
  assert.equal(m.offset(starts,{line:1,col:3}),text.indexOf('!'));
});

test('Delete removes only the selected embed and its owned visible or hidden caption', () => {
  const raw = '![Map|120](map.png "First edition")';
  for (const caption of ['\n\n*second* <!--iek-caption-->', ' <!--iek-caption-hidden:second-->']) {
    const text = raw + ' and ' + raw + caption + '\n\n*handwritten caption*';
    const ref = m.snapshot(text, text.lastIndexOf(raw), raw);
    assert.equal(m.apply(text, ref, m.removeEmbed(ref)), raw + ' and \n\n*handwritten caption*');
    assert.throws(() => m.apply('different ' + text, ref, m.removeEmbed(ref)), /노트가 변경/);
  }
});

test('Enter adds one writing line without splitting inline text or detaching its caption', () => {
  const raw = '![[photo.png]]';
  for (const [line, following, expectedBreak] of [
    [raw, '', '\n'],
    ['before ' + raw + ' after', '\nnext', '\n'],
    [raw + '\r\n\r\n*caption* <!--iek-caption-->', '\r\nnext', '\r\n'],
    [raw + '\n\n<!--iek-caption-hidden:kept-->', '\n\nnext', '\n'],
    ['> - ' + raw, '\n> next', '\n>   '],
    ['12. ' + raw, '\nnext', '\n    ']
  ]) {
    const text = line + following, ref = m.snapshot(text, text.indexOf(raw), raw);
    const patch = m.lineBelow(ref);
    assert.equal(m.apply(text, ref, patch), line + expectedBreak + following);
    assert.equal(patch.from + patch.insert.length, (line + expectedBreak).length);
  }
});
