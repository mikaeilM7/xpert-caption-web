import { CAPTION_STYLES } from './caption-styles.js';

const TICKS = 254016000000;
const FRAME_TICKS = { '23.976': 10594584000, 24: 10584000000, 25: 10160640000,
  '29.97': 8475667200, 30: 8467200000, 50: 5080320000, '59.94': 4237833600, 60: 4233600000 };
const shifts = [[7, 12, 17, 22], [5, 9, 14, 20], [4, 11, 16, 23], [6, 10, 15, 21]];
const constants = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));

function md5(data) {
  const size = Math.ceil((data.length + 9) / 64) * 64;
  const padded = new Uint8Array(size);
  padded.set(data);
  padded[data.length] = 128;
  const view = new DataView(padded.buffer);
  view.setUint32(size - 8, data.length * 8, true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let offset = 0; offset < size; offset += 64) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      const stage = i >> 4;
      let mix, word;
      if (stage === 0) { mix = (b & c) | (~b & d); word = i; }
      else if (stage === 1) { mix = (d & b) | (~d & c); word = (5 * i + 1) % 16; }
      else if (stage === 2) { mix = b ^ c ^ d; word = (3 * i + 5) % 16; }
      else { mix = c ^ (b | ~d); word = (7 * i) % 16; }
      const sum = (a + mix + constants[i] + view.getUint32(offset + word * 4, true)) | 0;
      const s = shifts[stage][i % 4];
      [a, b, c, d] = [d, (b + ((sum << s) | (sum >>> (32 - s)))) | 0, b, c];
    }
    [a0, b0, c0, d0] = [(a0 + a) | 0, (b0 + b) | 0, (c0 + c) | 0, (d0 + d) | 0];
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((word, i) => out.setUint32(i * 4, word, true));
  return Array.from(new Uint8Array(out.buffer), byte => byte.toString(16).padStart(2, '0')).join('');
}

function replaceSourceText(element, text, style) {
  const bytes = Uint8Array.from(atob(element.textContent), character => character.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const u32 = offset => view.getUint32(offset, true);
  const to = offset => offset + u32(offset);
  function fields(table) {
    const vtable = table - view.getInt32(table, true);
    const length = (view.getUint16(vtable, true) - 4) / 2;
    const offsets = new Map();
    for (let i = 0; i < length; i++) {
      const relative = view.getUint16(vtable + 4 + 2 * i, true);
      if (relative) offsets.set(i, table + relative);
    }
    return offsets;
  }
  if (u32(8) !== 0x11223344) throw new Error('قالب متن پروژه قابل شناسایی نیست.');
  const doc = fields(to(fields(to(12)).get(0)));
  const vector = to(doc.get(0));
  const fonts = to(doc.get(1));
  if (u32(vector) !== 1) throw new Error('ساختار قالب متن پروژه قابل تغییر نیست.');
  const run = fields(to(vector + 4));
  const pointer = run.get(0);
  const styleRef = run.get(1);
  const original = fields(to(styleRef));
  if ([...original.keys()].some(field => ![6, 21, 23, 24].includes(field)) || u32(fonts) !== 1)
    throw new Error('قالب استایل پروژه پشتیبانی نمی‌شود.');
  const encoded = new TextEncoder().encode(text);
  const font = new TextEncoder().encode(style.font);
  const align = length => Math.ceil(length / 4) * 4;
  const offset = align(bytes.length);
  const fontOffset = align(offset + 5 + encoded.length);
  const styleVtable = align(fontOffset + 5 + font.length);
  const styleTable = align(styleVtable + 54);
  const styleFields = [1, 2, ...original.keys()];
  const styleLength = 4 + styleFields.length * 4;
  const colorVtable = styleTable + styleLength;
  const colorTable = colorVtable + 12;
  const result = new Uint8Array(colorTable + 8);
  result.set(bytes);
  result.set(encoded, offset + 4);
  result.set(font, fontOffset + 4);
  const updated = new DataView(result.buffer);
  updated.setUint32(offset, encoded.length, true);
  updated.setUint32(pointer, offset - pointer, true);
  updated.setUint32(fontOffset, font.length, true);
  updated.setUint32(fonts + 4, fontOffset - fonts - 4, true);
  updated.setUint32(styleRef, styleTable - styleRef, true);
  updated.setUint16(styleVtable, 54, true);
  updated.setUint16(styleVtable + 2, styleLength, true);
  updated.setInt32(styleTable, styleTable - styleVtable, true);
  styleFields.forEach((field, index) => {
    const fieldOffset = 4 + index * 4;
    const fieldPointer = styleTable + fieldOffset;
    updated.setUint16(styleVtable + 4 + field * 2, fieldOffset, true);
    if (field === 1) updated.setFloat32(fieldPointer, style.size, true);
    else if (field === 2) updated.setUint32(fieldPointer, colorTable - fieldPointer, true);
    else updated.setUint32(fieldPointer, u32(original.get(field)), true);
  });
  updated.setUint16(colorVtable, 12, true);
  updated.setUint16(colorVtable + 2, 8, true);
  updated.setInt32(colorTable, 12, true);
  for (let channel = 0; channel < 4; channel++) {
    updated.setUint16(colorVtable + 4 + channel * 2, 4 + channel, true);
    updated.setUint8(colorTable + 4 + channel, channel === 3 ? 255 : parseInt(style.color.slice(1 + 2 * channel, 3 + 2 * channel), 16));
  }
  updated.setUint32(0, result.length - 12, true);
  element.textContent = btoa(String.fromCharCode(...result));
  const hash = md5(result).slice(0, 24) + (result.length + 12).toString(16).padStart(8, '0');
  element.setAttribute('BinaryHash', [hash.slice(0, 8), hash.slice(8, 12), hash.slice(12, 16), hash.slice(16, 20), hash.slice(20)].join('-'));
}

function set(parent, tag, value) {
  let field = [...parent.children].find(child => child.tagName === tag);
  if (!field) {
    field = parent.ownerDocument.createElement(tag);
    parent.append(field);
  }
  field.textContent = String(value);
}

function rekey(node, idMap, uidMap) {
  for (const item of [node, ...node.querySelectorAll('*')]) {
    for (const [name, map] of [['ObjectID', idMap], ['ObjectRef', idMap], ['ObjectUID', uidMap], ['ObjectURef', uidMap]]) {
      const old = item.getAttribute(name);
      if (map.has(old)) item.setAttribute(name, map.get(old));
    }
  }
}

function layout(text) {
  const safe = text.replace(/\r\n|\n/g, '\r').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  if (safe.includes('\r') || safe.length <= 34) return safe;
  const words = safe.split(/\s+/u);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && (line + ' ' + word).length > 34) { lines.push(line); line = ''; }
    line += (line ? ' ' : '') + word;
  }
  return [...lines, line].join('\r');
}

export async function exportPremiere(cues, frameRate = '30', style = CAPTION_STYLES.clean) {
  if (!globalThis.CompressionStream || !crypto.randomUUID) {
    throw new Error('برای دانلود پروژه از نسخهٔ به‌روز کروم یا اج استفاده کن.');
  }
  const rows = cues.filter(cue => cue.text.trim());
  if (!rows.length || rows.length > 1200) throw new Error('پروژه باید بین ۱ و ۱۲۰۰ لایهٔ متن داشته باشد.');
  const frame = FRAME_TICKS[frameRate];
  if (!frame) throw new Error('فریم‌ریت انتخاب‌شده معتبر نیست.');
  const [xmlResponse, mapResponse] = await Promise.all([
    fetch(new URL('./assets/premiere-base.xml', import.meta.url)),
    fetch(new URL('./assets/premiere-template.json', import.meta.url)),
  ]);
  if (!xmlResponse.ok || !mapResponse.ok) throw new Error('قالب پروژه در دسترس نیست.');
  const doc = new DOMParser().parseFromString(await xmlResponse.text(), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('قالب پروژه خراب است.');
  const recipe = await mapResponse.json();
  const root = doc.documentElement;
  const key = node => node.getAttribute('ObjectID') || node.getAttribute('ObjectUID');
  const byKey = new Map([...root.children].map(node => [key(node), node]));
  const sequence = byKey.get(recipe.sequence);
  const track = byKey.get(recipe.track);
  const group = byKey.get(recipe.group);
  const templates = recipe.graphic.map(id => byKey.get(id));
  const templateSet = new Set(templates);
  const sharedTemplates = new Set();
  const scan = [...root.children].filter(node => !templateSet.has(node));
  for (let i = 0; i < scan.length; i++) {
    for (const link of scan[i].querySelectorAll('[ObjectRef], [ObjectURef]')) {
      const referenced = byKey.get(link.getAttribute('ObjectRef') || link.getAttribute('ObjectURef'));
      if (templateSet.has(referenced) && !sharedTemplates.has(referenced)) {
        sharedTemplates.add(referenced);
        scan.push(referenced);
      }
    }
  }
  const items = track.querySelector('ClipItems > TrackItems');
  set(group.querySelector('TrackGroup'), 'FrameRate', frame);
  set(sequence, 'Name', 'Xpert Caption Graphics');
  let nextId = Math.max(...[...byKey.keys()].filter(id => /^\d+$/.test(id)).map(Number)) + 1;
  let previous = 0;
  rows.forEach((cue, index) => {
    const text = layout(cue.text);
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || text.length > 2000)
      throw new Error('زمان یا متن یکی از بخش‌ها برای خروجی معتبر نیست.');
    const start = Math.max(previous, Math.round(cue.start * TICKS / frame) * frame);
    const end = Math.max(start + frame, Math.round(cue.end * TICKS / frame) * frame);
    previous = end;
    const clones = templates.map(node => node.cloneNode(true));
    const ids = new Map(), uids = new Map();
    for (const node of clones) {
      const id = node.getAttribute('ObjectID');
      const uid = node.getAttribute('ObjectUID');
      if (id) ids.set(id, String(nextId++));
      if (uid) uids.set(uid, crypto.randomUUID());
    }
    for (const node of clones) {
      rekey(node, ids, uids);
      for (const id of node.querySelectorAll('ClipID, ID')) {
        if (id.textContent.includes('-')) id.textContent = crypto.randomUUID();
      }
    }
    const clip = clones[0];
    const timing = clip.querySelector('ClipTrackItem > TrackItem');
    set(timing, 'Start', start);
    set(timing, 'End', end);
    const perClip = new Map(clones.map(node => [key(node), node]));
    const subclip = perClip.get(clip.querySelector('ClipTrackItem > SubClip').getAttribute('ObjectRef'));
    set(subclip, 'Name', 'Xpert Text ' + (index + 1));
    const video = perClip.get(subclip.querySelector('Clip').getAttribute('ObjectRef')).querySelector('Clip');
    set(video, 'OutPoint', Number(video.querySelector('InPoint')?.textContent || 0) + end - start);
    const textComponent = clones.find(node => node.querySelector('MatchName')?.textContent === 'AE.ADBE Text');
    set(textComponent.querySelector('Component'), 'InstanceName', text);
    const sourceText = clones.find(node => node.tagName === 'ArbVideoComponentParam' &&
      node.querySelector('Name')?.textContent === 'Source Text' && node.querySelector('ParameterID')?.textContent === '1');
    replaceSourceText(sourceText.querySelector('StartKeyframeValue'), text, style);
    root.append(...clones);
    const item = doc.createElement('TrackItem');
    item.setAttribute('Index', index);
    item.setAttribute('ObjectRef', clip.getAttribute('ObjectID'));
    items.append(item);
  });
  for (const node of templates) if (!sharedTemplates.has(node)) node.remove();
  const finalUids = new Map([...root.children].filter(node => node.hasAttribute('ObjectUID'))
    .map(node => [node.getAttribute('ObjectUID'), crypto.randomUUID()]));
  rekey(root, new Map(), finalUids);
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(root);
  return new Response(new Blob([xml]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
}
