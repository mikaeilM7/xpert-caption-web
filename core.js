export const SPEECH = {
  iphone: { title: 'Whisper Base برای آیفون', detail: 'تشخیص چندزبانه · پردازنده', size: 80, device: 'wasm', dtype: 'q8',
    repo: 'Xenova/whisper-base', revision: '64da57285918e20ea79ea5c88eed7197933abaa8' },
  iphonePersian: { title: 'فارسی ویژهٔ آیفون', detail: 'Whisper Base Persian · پردازنده', size: 109, device: 'wasm', dtype: 'q8',
    repo: 'armantee/whisper-base-persian-onnx', revision: '2a29564b0977b04d78a4f546c00d01950917f9ba' },
  light: { title: 'سبک', detail: 'Whisper Base · پردازنده', size: 77, device: 'wasm', dtype: 'q8',
    repo: 'onnx-community/whisper-base_timestamped', revision: '608c49e61301901684bc36cac8f74b95ff6b5a8e' },
  balanced: { title: 'متعادل', detail: 'Whisper Small', size: 249, device: 'wasm', dtype: 'q8',
    repo: 'onnx-community/whisper-small_timestamped', revision: '65caa70f294b46e1c33ff820aae6b16d048ab818' },
  persian: { title: 'فارسی تخصصی', detail: 'Persian Turbo · گرافیک', size: 564, device: 'webgpu', dtype: 'q4f16',
    repo: 'mehrshadjavid/whisper-large-v3-turbo-persian-ONNX', revision: 'dc9d1b9e980401d0c45ff6fed1b65e97f8c26f4f' },
};
export const LANGUAGES = 'af am ar ast az ba be bg bn br bs ca ceb cs cy da de el en es et fa ff fi fr fy ga gd gl gu ha he hi hr ht hu hy id ig ilo is it ja jv ka kk km kn ko lb lg ln lo lt lv mg mk ml mn mr ms my ne nl no ns oc or pa pl ps pt ro ru sd si sk sl so sq sr ss su sv sw ta th tl tn tr uk ur uz vi wo xh yi yo zh zu'.split(' ');
const names = new Intl.DisplayNames(['fa'], { type: 'language' });
export const languageName = code => names.of(code) || code;
export const digits = value => new Intl.NumberFormat('fa').format(value);
export const MAX_SECONDS = 15 * 60;
export const MAX_BYTES = 300_000_000;

export function isAppleMobile(nav = navigator) {
  const platform = nav.userAgentData?.platform || nav.platform || '';
  return /iPhone|iPad|iPod/i.test(platform + (nav.userAgent || '')) ||
    (/Mac/i.test(platform) && nav.maxTouchPoints > 1);
}

function osLabel(nav) {
  const platform = nav.userAgentData?.platform || nav.platform || '';
  const ua = nav.userAgent || '';
  if (/Android/i.test(platform + ua)) return 'Android';
  if (isAppleMobile(nav)) return 'iOS / iPadOS';
  if (/Chrome OS|CrOS/i.test(platform + ua)) return 'ChromeOS';
  if (/Win/i.test(platform)) return 'Windows';
  if (/Mac/i.test(platform)) return 'macOS';
  if (/Linux/i.test(platform)) return 'Linux';
  return platform || 'نامشخص';
}

function glRenderer(doc) {
  try {
    const gl = doc.createElement('canvas').getContext('webgl');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    const result = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : '';
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return String(result).replace(/^ANGLE \([^,]+,\s*/, '').replace(/\s+(Direct3D|D3D|Vulkan|OpenGL).*$/i, '').slice(0, 115);
  } catch {
    return '';
  }
}

export async function capabilities(nav = navigator, doc = document) {
  let adapter;
  try {
    adapter = await Promise.race([
      nav.gpu?.requestAdapter({ powerPreference: 'high-performance' }),
      new Promise(resolve => setTimeout(resolve, 1800)),
    ]);
  } catch { /* Some browser policies restrict WebGPU. */ }
  const info = adapter?.info;
  const gpuName = (info?.description || glRenderer(doc) || info?.vendor || 'در دسترس نیست').replace(/\s+\(0x[\da-f]+\)$/i, '');
  const webgpu = Boolean(adapter && !info?.isFallbackAdapter && !/SwiftShader|software rasterizer/i.test(gpuName));
  return {
    os: osLabel(nav), cores: nav.hardwareConcurrency || 0, ram: nav.deviceMemory || 0,
    webgpu, f16: webgpu && adapter.features.has('shader-f16'),
    gpuName,
  };
}

export function speechOptions(hardware, language, persianCpu = false) {
  if (hardware.appleMobile) {
    const id = language === 'fa' ? 'iphonePersian' : 'iphone';
    const options = [{ ...SPEECH[id], id }];
    if (language === 'fa' && hardware.webgpu && hardware.f16) {
      options.push({ ...SPEECH.persian, id: 'iphoneTurbo', title: 'فارسی دقیق‌تر · Turbo',
        detail: 'Whisper Large V3 Turbo · گرافیک' });
    }
    return options;
  }
  const useGPU = hardware.webgpu;
  const options = [{ ...SPEECH.light }, { ...SPEECH.balanced, device: useGPU ? 'webgpu' : 'wasm' }];
  if (language === 'fa' || language === 'auto') {
    options.push(useGPU && !persianCpu
      ? { ...SPEECH.persian, dtype: hardware.f16 ? 'q4f16' : 'q4', size: hardware.f16 ? 564 : 759 }
      : { ...SPEECH.persian, detail: 'Persian Turbo · پردازنده', dtype: 'q8', size: 1084, device: 'wasm' });
  }
  for (const [index, option] of options.entries()) option.id = ['light', 'balanced', 'persian'][index];
  return options;
}

export function recommendedSpeech(hardware, language, options) {
  if (hardware.appleMobile) return options[0].id;
  if (language === 'fa' && options.some(option => option.id === 'persian') &&
      (hardware.webgpu || hardware.ram >= 8 && hardware.cores >= 4)) return 'persian';
  return hardware.webgpu || hardware.ram >= 6 && hardware.cores >= 6 ? 'balanced' : 'light';
}

const clean = text => String(text || '').replace(/[ \t]+/g, ' ').trim();
export function wordsOf(text) {
  return clean(text).split(/\s+/u).filter(Boolean);
}

export function splitText(text, cap = 420) {
  const out = [];
  for (const sentence of String(text).match(/[^\n.!؟?。！]+[.!؟?。！]*|[.!؟?。！]+/gu) || []) {
    let part = '';
    for (const word of wordsOf(sentence)) {
      if (part && part.length + word.length + 1 > cap) {
        out.push(part);
        part = '';
      }
      part += (part ? ' ' : '') + word;
    }
    if (part) out.push(part);
  }
  return out;
}

export function timedRows(chunks, duration) {
  const out = [];
  for (const [index, chunk] of (chunks || []).entries()) {
    const text = clean(chunk.text);
    if (!text || !Number.isFinite(chunk.timestamp?.[0])) continue;
    const start = Math.max(out.at(-1)?.end ?? 0, chunk.timestamp[0]);
    const next = chunks[index + 1]?.timestamp?.[0];
    const end = Math.min(duration, chunk.timestamp[1] ?? (Number.isFinite(next) ? next : duration));
    if (end > start) out.push({ text, start, end });
    else if (out.length) out.at(-1).text += ' ' + text;
  }
  return out;
}

export function groupWords(words) {
  const result = [];
  let group;
  for (const word of words) {
    if (!group || word.start - group.end > .62 || word.end - group.start > 5.8 ||
        group.text.length + word.text.length > 78 || /[.!؟?]$/u.test(group.text)) {
      group = { ...word };
      result.push(group);
    } else {
      group.end = word.end;
      group.text += /^[،؛.!؟?]/u.test(word.text) ? word.text : ' ' + word.text;
    }
  }
  return result;
}

export function timestamp(value, srt = false) {
  const milliseconds = Math.max(0, Math.round(value * 1000));
  const segments = [Math.floor(milliseconds / 3600000), Math.floor(milliseconds / 60000) % 60, Math.floor(milliseconds / 1000) % 60];
  const clock = segments.map(segment => String(segment).padStart(2, '0')).join(':');
  return srt ? clock + ',' + String(milliseconds % 1000).padStart(3, '0') : clock.slice(3);
}

export function createSrt(rows) {
  return rows.filter(row => row.text.trim()).map((row, index) =>
    (index + 1) + '\n' + timestamp(row.start, true) + ' --> ' + timestamp(row.end, true) + '\n' + row.text.trim()
  ).join('\n\n') + '\n';
}

export function guessScriptLanguage(text) {
  if (/[پچژگ]/u.test(text) && /\p{Script=Arabic}/u.test(text)) return 'fa';
  if (/\p{Script=Arabic}/u.test(text)) return null;
  if (/\p{Script=Cyrillic}/u.test(text)) return /[іїєґ]/iu.test(text) ? 'uk' : 'ru';
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)) return 'ja';
  if (/\p{Script=Hangul}/u.test(text)) return 'ko';
  if (/\p{Script=Han}/u.test(text)) return 'zh';
  if (/\p{Script=Greek}/u.test(text)) return 'el';
  if (/\p{Script=Hebrew}/u.test(text)) return 'he';
  return null;
}
