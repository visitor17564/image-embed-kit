'use strict';

// Obsidian's metadata identifies the occurrence. Only touch the width in the label
// and the immediately adjacent caption that this plugin owns.
const captionMark = '<!--iek-caption-->';
const hiddenMark = '<!--iek-caption-hidden:';
const gap = '(?:[ \\t]+|[ \\t]*(?:\\r?\\n){1,2}[ \\t]*)';
const visibleCaption = new RegExp('^(' + gap + ')\\*((?:\\\\[^\\r\\n]|[^*\\\\\\r\\n])+)\\* ' + captionMark);
const hiddenCaption = new RegExp('^(' + gap + ')' + hiddenMark + '([^\\r\\n]*?)-->');
const minWidth = 32, maxWidth = 8192, maxCaption = 1000;

function parse(raw) {
  if (!raw || /[\r\n]/.test(raw)) return null;
  let head, label, tail, wiki = false;
  if (raw.startsWith('![[') && raw.endsWith(']]')) {
    const body = raw.slice(3, -2);
    // Escaped pipes in Markdown tables have different escaping rules.
    if (!body || body.includes('\\|')) return null;
    const pipe = body.indexOf('|');
    const path = pipe < 0 ? body : body.slice(0, pipe);
    if (!path) return null;
    wiki = true; head = '![[' + path; tail = ']]';
    label = pipe < 0 ? '' : body.slice(pipe + 1);
  } else if (raw.startsWith('![')) {
    let i = 2, depth = 1;
    for (; i < raw.length; i++) {
      if (raw[i] === '\\') { i++; continue; }
      if (raw[i] === '[') depth++;
      if (raw[i] === ']' && --depth === 0) break;
    }
    if (depth || raw[i+1] !== '(' || !raw.endsWith(')')) return null;
    head = '!['; label = raw.slice(2,i); tail = raw.slice(i);
  } else return null;
  const size = /(?:^|(?<!\\)\|)(\d+)(?:[xX](\d+))?$/.exec(label);
  return {wiki, head, tail, label: size ? label.slice(0, size.index) : label,
    width: size ? Number(size[1]) : null, height: size?.[2] ? Number(size[2]) : null};
}

function withWidth(raw, width) {
  const p = parse(raw);
  if (!p) throw Error('지원하지 않는 이미지 문법입니다.');
  if (width !== null && (!Number.isInteger(width) || width < minWidth || width > maxWidth))
    throw Error('너비는 ' + minWidth + '–' + maxWidth + 'px로 입력하세요.');
  let label = p.label;
  if (width !== null) label += (label ? '|' : '') + width;
  return p.head + (p.wiki && label ? '|' : '') + label + p.tail;
}

function escapeText(s) { return s.replace(/[\\*_[\]<>!&$~|%\x60#^]/g, '\\$&'); }
function unescapeText(s) { return s.replace(/\\([\\*_[\]<>!&$~|%\x60#^])/g, '$1'); }
function hideText(s) { return s.replace(/&/g,'&amp;').replace(/-/g,'&#45;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function unhideText(s) { return s.replace(/&#45;/g,'-').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&'); }
function captionAfter(text, end) {
  const rest = text.slice(end, end + maxCaption * 8 + 200);
  const m = visibleCaption.exec(rest);
  if (m) return {raw:m[0], space:m[1], value:unescapeText(m[2]), hidden:false};
  const h = hiddenCaption.exec(rest);
  if (h) return {raw:h[0], space:h[1], value:unhideText(h[2]), hidden:true};
  return {raw:'', space:'', value:'', hidden:false};
}

// Derive UTF-16 offsets from Obsidian's line/column positions so CRLF stays intact.
function lineStarts(text) {
  const starts=[0]; for (let p=text.indexOf('\n'); p>=0; p=text.indexOf('\n',p+1)) starts.push(p+1);
  return starts;
}
function offset(starts, pos) { return starts[pos.line] === undefined ? -1 : starts[pos.line]+pos.col; }
function snapshot(text, start, raw) {
  if (start < 0 || !parse(raw) || text.slice(start,start+raw.length)!==raw)
    throw Error('이미지 위치가 변경됐습니다. 이미지를 다시 선택하세요.');
  const end=start+raw.length;
  return {text, start, raw, end, spec:parse(raw), caption:captionAfter(text,end)};
}
function edit(s, changes) {
  const {text, start, raw, end, caption}=s;
  const hasWidth = Object.hasOwn(changes,'width');
  const image = hasWidth ? withWidth(raw,changes.width) : raw;
  let next=caption.raw;
  if (Object.hasOwn(changes,'caption') || Object.hasOwn(changes,'hidden')) {
    const value=String(changes.caption ?? caption.value).trim();
    if (/[\r\n]/.test(value) || value.length > maxCaption) throw Error('캡션은 한 줄, 최대 ' + maxCaption + '자로 입력하세요.');
    const hidden=changes.hidden ?? caption.hidden;
    if (value!==caption.value || hidden!==caption.hidden) {
      const lineStart=text.lastIndexOf('\n',start-1)+1;
      const firstLf=text.indexOf('\n',end+caption.raw.length);
      const lineEnd=firstLf<0?text.length:firstLf;
      const ownLine=/^[ \t]{0,3}$/.test(text.slice(lineStart,start)) && /^[ \t\r]*$/.test(text.slice(end+caption.raw.length,lineEnd));
      const eol=text.includes('\r\n') ? '\r\n':'\n';
      const space=caption.space || (ownLine ? eol+eol : ' ');
      next=!value?'': space + (hidden ? hiddenMark+hideText(value)+'-->' : '*'+escapeText(value)+'* '+captionMark);
    }
  }
  return {from:start,to:end+caption.raw.length,insert:image+next};
}
function apply(text, s, change) {
  if (text!==s.text) throw Error('편집 중 노트가 변경됐습니다. 이미지를 다시 선택하세요.');
  return text.slice(0,change.from)+change.insert+text.slice(change.to);
}
module.exports={parse,withWidth,snapshot,edit,apply,lineStarts,offset,minWidth,maxWidth,maxCaption};
