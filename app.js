import { capabilities, isAppleMobile, speechOptions, recommendedSpeech, LANGUAGES, languageName, digits,
  MAX_BYTES, wordsOf, splitText, timestamp, createSrt, guessScriptLanguage } from './core.js';
import { decodeMedia, startCapture, videoFile } from './media.js';
import { CAPTION_STYLES } from './caption-styles.js';
import { readDrafts, writeDraft } from './drafts.js';
import { connectPlayer } from './player.js';
import { normalizeInstagramUrl, inspectInstagram, loadInstagramVideo } from './instagram.js';
import { audioQualities, videoQualities, extractAudio, resizeVideo } from './media-conversion.js';

const $ = id => document.getElementById(id);
const tabs = [...document.querySelectorAll('[data-input]')];
const modes = [...document.querySelectorAll('[name="output-mode"]')];
const sourceLanguage = $('source-language');
const targetLanguage = $('target-language');
const preview = $('preview');
const appleMobile = isAppleMobile();
const TURBO_RUN = 'xpert-caption-iphone-turbo-running';
let turboInterrupted = false;
try {
  turboInterrupted = appleMobile && sessionStorage.getItem(TURBO_RUN) === '1';
  if (turboInterrupted) sessionStorage.removeItem(TURBO_RUN);
} catch { /* Session storage can be unavailable. */ }
let hardware = { appleMobile, os: '', cores: 0, ram: 0, webgpu: false, f16: false, gpuName: '' };
let selectedModel;
let manualModel = false;
let manualSource = false;
let inputType = 'file';
let inputFile;
let inputUrl;
let stopRecording;
let recordTimer;
let worker;
let pending;
let serial = 0;
let busy = false;
let requestingCapture = false;
let converting = false;
let output;
let downloadProgress = new Map();
let modelTransfers = new Map();
let styleId = 'clean';
let loading = true;
const slots = new Map(tabs.map(tab => [tab.dataset.input, { file: null, mediaId: '', output: null, text: '', time: 0, style: 'clean' }]));
let saveTimer;
const DRAFT_ACTIVE = 'xpert-caption-active-input';
const DRAFT_META = 'xpert-caption-draft:';

const player = connectPlayer({
  media: preview, player: $('player'), seek: $('player-seek'), waveform: $('waveform'), play: $('player-play'),
  back: $('player-back'), forward: $('player-forward'), rate: $('player-rate'), volume: $('player-volume'),
  clock: $('player-clock'), fullscreen: $('player-fullscreen'), label: $('player-label'),
  onTime: updateOverlay, onError: showError, drawWaveform: !appleMobile,
});

function option(select, value, text) { select.add(new Option(text, value)); }
option(sourceLanguage, 'auto', 'تشخیص خودکار');
option(targetLanguage, '', 'بدون ترجمه');
for (const code of ['fa', 'en', 'ru', ...LANGUAGES.filter(value => !['fa', 'en', 'ru'].includes(value))]) {
  option(sourceLanguage, code, languageName(code));
  option(targetLanguage, code, languageName(code));
}
sourceLanguage.value = 'fa';

function showError(error) {
  $('error').hidden = !error;
  $('error').textContent = error ? String(error.message || error).slice(0, 310) : '';
}

function rememberSlot(type = inputType, { media = false, session = true } = {}) {
  if (loading) return;
  const slot = slots.get(type);
  const { file, ...state } = slot;
  try {
    localStorage.setItem(DRAFT_META + type, JSON.stringify(state));
    if (session) localStorage.setItem(DRAFT_ACTIVE, inputType);
  } catch { /* IndexedDB remains available if localStorage is full. */ }
  const updates = [[type, state]];
  if (media) updates.push(['media:' + type, { file, id: state.mediaId }]);
  if (session) updates.push(['active', inputType]);
  writeDraft(updates).then(() => {
    if (type === inputType) $('draft-status').textContent = slot.file || slot.output || slot.text
      ? 'پیش‌نویس همین تب روی این مرورگر ذخیره شد.' : '';
  }).catch(() => {
    if (type === inputType) $('draft-status').textContent = 'ذخیره روی دیسک ممکن نشد. پیش‌نویس تا وقتی صفحه باز است در دسترس می‌ماند.';
  });
}

function keepCurrent() {
  const slot = slots.get(inputType);
  slot.output = output;
  slot.time = Number.isFinite(preview.currentTime) ? preview.currentTime : 0;
  slot.style = styleId;
  if (inputType === 'text') slot.text = $('source-text').value;
}

function saveEdits() {
  keepCurrent();
  const type = inputType;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => rememberSlot(type), 160);
}

function status(message, fraction) {
  $('status').textContent = message;
  $('progress').hidden = !busy || !message;
  if (Number.isFinite(fraction)) $('progress').value = Math.max(0, Math.min(1, fraction));
  else $('progress').removeAttribute('value');
}

function renderHardware() {
  $('os-stat').textContent = hardware.os || 'نامشخص';
  $('cpu-stat').textContent = hardware.cores ? digits(hardware.cores) : 'نامشخص';
  $('ram-stat').textContent = hardware.ram ? 'حدود ' + digits(hardware.ram) + ' گیگابایت' : 'گزارش نشده';
  $('gpu-stat').textContent = hardware.gpuName || 'گزارش نشده';
  $('gpu-badge').textContent = hardware.webgpu ? 'WebGPU فعال' : 'اجرای CPU';
  $('gpu-badge').classList.toggle('ready', hardware.webgpu);
  renderModels();
}

function renderModels() {
  const options = speechOptions(hardware, sourceLanguage.value, $('persian-cpu').checked);
  $('cpu-override').hidden = appleMobile || !hardware.webgpu || !['fa', 'auto'].includes(sourceLanguage.value) || inputType === 'text';
  const recommended = recommendedSpeech(hardware, sourceLanguage.value, options);
  selectedModel = manualModel && options.some(model => model.id === selectedModel) ? selectedModel : recommended;
  $('models').replaceChildren();
  for (const model of options) {
    const label = document.createElement('label');
    label.className = 'model-choice';
    const info = document.createElement('span');
    const title = document.createElement('strong');
    const detail = document.createElement('small');
    title.textContent = model.title;
    detail.textContent = model.detail + ' · حدود ' + digits(model.size) + ' مگابایت';
    info.append(title, detail);
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'speech-model';
    radio.value = model.id;
    radio.checked = model.id === selectedModel;
    radio.disabled = loading || busy || inputType === 'text';
    radio.setAttribute('aria-label', model.title + '، ' + detail.textContent);
    radio.addEventListener('change', () => {
      selectedModel = model.id;
      manualModel = true;
      turboInterrupted = false;
      if (appleMobile) $('recommendation-note').textContent = mobileModelNote();
    });
    label.append(radio, info);
    if (model.id === recommended) {
      const badge = document.createElement('b');
      badge.textContent = 'پیشنهادی';
      label.append(badge);
    }
    $('models').append(label);
  }
  $('recommendation-note').textContent = inputType === 'text'
    ? 'برای متن تایپ‌شده مدل گفتار بارگیری نمی‌شود.'
    : appleMobile ? mobileModelNote()
    : sourceLanguage.value === 'fa' && recommended !== 'persian'
      ? 'مدل فارسی تخصصی روی این پردازنده کندتر است، ولی می‌توانی دستی انتخابش کنی.'
      : 'برای فارسی، مدل تخصصی روی سخت‌افزار مناسب پیشنهاد می‌شود.';
}

function mobileModelNote() {
  if (turboInterrupted) return 'اجرای Turbo با بازشدن دوبارهٔ صفحه قطع شد. مدل فارسی سبک‌تر انتخاب شده است.';
  if (selectedModel === 'iphoneTurbo') return 'برای اولین تست Turbo یک کلیپ کوتاه انتخاب کن. اگر گرافیک خطا بدهد، مدل فارسی سبک‌تر ادامه می‌دهد.';
  if (selectedModel === 'iphonePersian') return 'مدل فارسی روی گوشی اجرا می‌شود. زمان زیرنویس بر اساس بخش‌های صدا تخمین زده می‌شود.';
  return 'Whisper Base روی گوشی اجرا می‌شود. مدل پس از بارگیری در مرورگر ذخیره می‌شود.';
}

function markTurboRun(running) {
  try {
    if (running) sessionStorage.setItem(TURBO_RUN, '1');
    else sessionStorage.removeItem(TURBO_RUN);
  } catch { /* The model can run without a recovery marker. */ }
}

function controls() {
  for (const element of [...tabs, ...modes, sourceLanguage, targetLanguage, $('dropzone'), $('source-text'), $('persian-cpu'),
    ...document.querySelectorAll('[name="speech-model"]')]) {
    element.disabled = loading || busy || converting || Boolean(stopRecording) || requestingCapture ||
      (inputType === 'text' && element.name === 'speech-model');
  }
  $('record').disabled = loading || busy || requestingCapture;
  $('record-save').hidden = !inputFile || !['mic', 'tab'].includes(inputType);
  $('record-save').disabled = Boolean(stopRecording) || requestingCapture;
  $('remove-source').disabled = loading || busy || converting || Boolean(stopRecording) || requestingCapture ||
    (inputType === 'instagram' && instagramBusy);
  if (!stopRecording && !requestingCapture) $('record').textContent = inputFile ? 'ضبط مجدد' : 'شروع ضبط';
  $('start').disabled = loading || busy || converting || Boolean(stopRecording) || requestingCapture ||
    (inputType === 'text' ? !$('source-text').value.trim() : !inputFile);
  $('cancel').hidden = !busy;
  for (const id of ['convert-audio-format', 'convert-audio-quality', 'convert-audio-use', 'convert-audio-save',
    'convert-video-quality', 'convert-video-save']) $(id).disabled = loading || busy || converting || !inputFile;
}

function clearOutput() {
  output = null;
  $('result').hidden = true;
  $('output-editor').replaceChildren();
  $('export-status').textContent = '';
  updateOverlay();
}

function loadMedia(file, time = 0) {
  preview.pause();
  if (inputUrl) URL.revokeObjectURL(inputUrl);
  inputFile = file || null;
  inputUrl = inputFile ? URL.createObjectURL(inputFile) : null;
  $('source-selection').hidden = !inputFile;
  $('source-info').textContent = file?.name || '';
  $('conversion-tools').hidden = !inputFile;
  $('convert-video').hidden = true;
  $('conversion-status').textContent = '';
  player.load(inputFile, inputUrl, !!inputFile && videoFile(inputFile), time);
}

function setFile(file, type = inputType) {
  if (!file || file.size > MAX_BYTES || !file.size) {
    if (!file) return;
    showError(new Error(file.size ? 'حجم فایل بیشتر از ۳۰۰ مگابایت است.' : 'فایل خالی است.'));
    controls();
    return;
  }
  Object.assign(slots.get(type), { file, mediaId: crypto.randomUUID(), output: null, time: 0, detached: false });
  if (type === 'derived') document.querySelector('[data-input="derived"]').hidden = false;
  if (type === inputType) {
    showError();
    clearOutput();
    loadMedia(file);
    status('');
  }
  rememberSlot(type, { media: true });
  controls();
}

function changeInput(type, restoring = false) {
  if (type === inputType && !restoring) return;
  if (!restoring) {
    keepCurrent();
    rememberSlot();
  }
  inputType = type;
  const slot = slots.get(type);
  styleId = CAPTION_STYLES[slot.style] ? slot.style : 'clean';
  clearOutput();
  loadMedia(slot.file, slot.time);
  if (slot.output) { output = slot.output; showResult(); }
  if (type === 'text') $('source-text').value = slot.text;
  document.querySelectorAll('[name="caption-style"]').forEach(radio => { radio.checked = radio.value === styleId; });
  for (const tab of tabs) tab.setAttribute('aria-pressed', tab.dataset.input === type);
  $('input-file').hidden = type !== 'file';
  $('input-record').hidden = !['mic', 'tab'].includes(type);
  $('input-instagram').hidden = type !== 'instagram';
  $('input-derived').hidden = type !== 'derived' || !slot.file;
  $('input-text').hidden = type !== 'text';
  $('record-help').textContent = type === 'tab'
    ? 'اگر ویس در مرورگر پخش می‌شود، همان تب و گزینهٔ اشتراک صدا را انتخاب کن تا صدای مستقیم ضبط شود.'
    : 'برای ضبط، دسترسی میکروفون را فعال کن و «شروع ضبط» را بزن.';
  $('start').textContent = type === 'text' ? 'آماده‌سازی متن' : 'ساخت زیرنویس';
  showError();
  status('');
  $('draft-status').textContent = '';
  renderModels();
  controls();
  rememberSlot();
}

function formatError(message) {
  if (/Failed to fetch|NetworkError|load module|network|ERR_|CORS|403|429|502|503/i.test(message))
    return 'دانلود مدل کامل نشد. اتصال به Hugging Face و CDN را بررسی کن و دوباره بزن.';
  if (/out of memory|memory allocation|allocation failed/i.test(message))
    return 'حافظه برای این مدل کافی نیست. مدل سبک‌تر یا فایل کوتاه‌تر را امتحان کن.';
  if (/WebGPU|GPUBuffer|adapter|shader/i.test(message))
    return 'اجرای مدل روی گرافیک کامل نشد. فایل محفوظ است. می‌توانی «اجرای مدل فارسی با CPU» را امتحان کنی.';
  return message;
}

function releaseWorker(reason) {
  worker?.terminate();
  worker = null;
  if (pending) {
    pending.reject(new Error(reason || 'پردازش متوقف شد.'));
    pending = null;
  }
}

const STAGES = {
  model: 'آماده‌سازی مدل…', speech: 'در حال تشخیص گفتار…',
  sentenceFallback: 'زمان‌بندی جمله‌ها در حال آماده‌سازی است…',
  gpuFallback: 'در حال ادامه با پردازنده…', translation: 'در حال ترجمه…',
  speechScan: 'در حال پیدا کردن بخش‌های گفتار…',
  speechScanFallback: 'جدا کردن مکث‌ها در دسترس نبود. صدا به‌صورت کامل بررسی می‌شود.',
};

function requestEngine(message, transfers = []) {
  if (!worker) {
    worker = new Worker(new URL('./engine.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', ({ data }) => {
      if (!pending || pending.id !== data.id) return;
      if (data.type === 'result' || data.type === 'error') {
        const current = pending;
        pending = null;
        if (data.type === 'result') current.resolve(data.payload);
        else current.reject(new Error(formatError(data.message)));
      } else if (data.type === 'stage') {
        if (data.stage === 'model') {
          downloadProgress.clear();
          modelTransfers.clear();
        }
        status(STAGES[data.stage] || 'در حال پردازش…');
      } else if (data.type === 'model-transfer') {
        modelTransfers.set(data.file, [data.loaded, data.total]);
        let loaded = 0, total = 0;
        for (const amounts of modelTransfers.values()) { loaded += amounts[0]; total += amounts[1]; }
        status('دانلود مدل · ' + digits(Math.round(loaded / 1000000)) + ' از ' +
          digits(Math.round(total / 1000000)) + ' مگابایت ذخیره شد', loaded / total);
      } else if (data.type === 'download' && data.file && data.total > 0) {
        if (Array.from(modelTransfers.values()).some(([loaded, total]) => loaded < total)) return;
        downloadProgress.set(data.file, [data.loaded || 0, data.total]);
        let loaded = 0, total = 0;
        for (const amounts of downloadProgress.values()) { loaded += amounts[0]; total += amounts[1]; }
        status('آماده‌سازی مدل · ' + digits(Math.round(loaded / 1000000)) + ' مگابایت', loaded / total);
      } else if (data.type === 'fraction') status('در حال ترجمه…', data.value);
      else if (data.type === 'speechProgress') status('در حال خواندن گفتار…', data.value);
    });
    worker.addEventListener('error', event => releaseWorker(formatError(event.message || 'مرورگر نتوانست موتور را اجرا کند.')));
  }
  return new Promise((resolve, reject) => {
    const id = ++serial;
    pending = { id, resolve, reject };
    worker.postMessage({ ...message, id }, transfers);
  });
}

async function createLanguageDetector(signal) {
  try {
    const api = globalThis.LanguageDetector;
    if (!api) return null;
    const availability = await api.availability();
    if (availability === 'available') return await api.create({ signal });
  } catch { /* The language menu is always available. */ }
  return null;
}

async function detectLanguage(text, detectorPromise) {
  try {
    const detector = await detectorPromise;
    if (detector) {
      try {
        const best = (await detector.detect(text.slice(0, 2400)))[0];
        const code = best?.detectedLanguage?.split('-')[0];
        if (best?.confidence >= .65 && LANGUAGES.includes(code)) return code;
      } finally { detector.destroy?.(); }
    }
  } catch { /* The language menu is always available. */ }
  try {
    const { localLanguage } = await import('./assets/language-vendor.js');
    const locale = localLanguage(text, LANGUAGES);
    if (locale) return locale;
  } catch { /* The script-based fallback does not need the detector. */ }
  const simple = guessScriptLanguage(text);
  if (simple) return simple;
  if (/\b(the|you|and|are|is|we|this|of|can)\b/i.test(text) && /^[\p{Script=Latin}\p{Script=Common}\s]+$/u.test(text)) return 'en';
  return null;
}

async function translateParts(parts, from, to) {
  const jobs = parts.map(text => text.length > 420 ? splitText(text) : [text]);
  const translated = await requestEngine({ kind: 'translation', parts: jobs.flat(), from, to });
  let offset = 0;
  return jobs.map(job => {
    const joined = translated.slice(offset, offset + job.length).join(' ');
    offset += job.length;
    return joined;
  });
}

async function run() {
  if (busy || converting) return;
  const fromSetting = sourceLanguage.value;
  const to = targetLanguage.value;
  const mode = modes.find(input => input.checked).value;
  const file = inputFile;
  const typed = inputType === 'text' ? $('source-text').value.trim() : '';
  const fromText = inputType === 'text';
  const options = speechOptions(hardware, fromSetting, $('persian-cpu').checked);
  const model = options.find(item => item.id === selectedModel);
  const turboFallback = model?.id === 'iphoneTurbo' ? options.find(item => item.id === 'iphonePersian') : null;
  if ((!fromText && !file) || (fromText && !typed)) return;
  const detectorControl = new AbortController();
  const detector = to && fromSetting === 'auto' ? createLanguageDetector(detectorControl.signal) : null;
  const runId = ++serial;
  busy = true;
  $('start').dataset.run = String(runId);
  preview.pause();
  showError();
  controls();
  const current = () => busy && Number($('start').dataset.run) === runId;
  try {
    let rows = [];
    let words = [];
    let transcript = typed;
    let modelName = '';
    let usedTurboFallback = false;
    if (!fromText) {
      status('در حال خواندن صدا…');
      const pcm = await decodeMedia(file);
      if (!current()) return;
      const recognize = (activeModel, audio) => requestEngine({
        kind: 'speech', audio, model: activeModel, language: fromSetting,
        words: mode === 'word' && (!to || to === fromSetting),
        filterSpeech: !appleMobile,
        fallback: activeModel.id === 'balanced' && activeModel.device === 'webgpu' ? { ...activeModel, device: 'wasm' } : null,
      }, [audio.buffer]);
      let decoded;
      if (turboFallback) markTurboRun(true);
      try {
        decoded = await recognize(model, pcm);
        if (!decoded.transcript) throw new Error('گفتار قابل تشخیص پیدا نشد.');
      } catch (error) {
        if (!turboFallback || !current()) throw error;
        markTurboRun(false);
        releaseWorker();
        usedTurboFallback = true;
        manualModel = false;
        renderModels();
        status('Turbo کامل نشد. در حال ادامه با مدل فارسی سبک‌تر…');
        const retryAudio = await decodeMedia(file);
        if (!current()) return;
        decoded = await recognize(turboFallback, retryAudio);
      } finally {
        if (turboFallback) markTurboRun(false);
      }
      ({ transcript, rows, words, model: modelName } = decoded);
      if (!transcript) throw new Error('گفتار قابل تشخیص پیدا نشد.');
    }
    if (!current()) return;
    const from = to && fromSetting === 'auto' ? await detectLanguage(transcript, detector) : fromSetting;
    if (!current()) return;
    if (to && !from) throw new Error('زبان ورودی با اطمینان تشخیص داده نشد. زبان را از منوی ورودی انتخاب کن و دوباره شروع کن.');
    const translated = Boolean(to && from !== to);
    let sections = fromText ? splitText(transcript) : rows.map(row => row.text);
    if (!sections.length) sections = splitText(transcript);
    if (translated) {
      if (appleMobile && !fromText) releaseWorker();
      sections = await translateParts(sections, from, to);
      rows = rows.map((row, index) => ({ ...row, text: sections[index] }));
      words = [];
    }
    if (!current()) return;
    output = {
      mode, rows, words, sections, modelName, fromText, translated,
      full: translated ? sections.join('\n') : transcript,
      original: to ? { language: from, text: transcript } : null,
      translatedTo: to || '',
      fileName: file?.name?.replace(/\.[^.]+$/, '') || 'xpert-caption',
    };
    output.wordTimed = mode === 'word' && words.length > 0;
    if (mode === 'word' && !output.wordTimed) output.wordText = sections.flatMap(wordsOf);
    showResult();
    keepCurrent();
    rememberSlot();
    status(usedTurboFallback ? 'آماده شد با مدل فارسی سبک‌تر.' : 'آماده شد.');
  } catch (error) {
    if (current()) { showError(error); status(''); }
  } finally {
    detectorControl.abort();
    if (current()) {
      releaseWorker();
      busy = false;
      $('progress').hidden = true;
      controls();
    }
  }
}

function editableRows() {
  if (output.mode === 'sentence') return output.rows;
  if (output.mode === 'word' && output.wordTimed) return output.words;
  return [];
}

function exportRows() {
  if (output.mode === 'word' && !output.wordTimed) {
    let pointer = 0;
    return output.rows.map((row, index) => {
      const count = wordsOf(output.sections[index]).length;
      const text = output.wordText.slice(pointer, pointer + count).join(' ');
      pointer += count;
      return { ...row, text };
    });
  }
  return editableRows();
}

function currentText() {
  if (output.mode === 'full') return output.full;
  if (output.mode === 'word' && !output.wordTimed) return output.wordText.join(' ');
  const list = editableRows();
  return (list.length ? list.map(row => row.text) : output.sections).join(output.mode === 'word' ? ' ' : '\n');
}

function textEditor(value, label, onInput, rows = 1) {
  const textarea = document.createElement('textarea');
  textarea.dir = 'auto';
  textarea.value = value;
  textarea.rows = rows;
  textarea.setAttribute('aria-label', label);
  textarea.addEventListener('input', () => { onInput(textarea.value); updateOverlay(); saveEdits(); });
  return textarea;
}

function showResult() {
  $('result').hidden = false;
  $('output-editor').replaceChildren();
  $('result-meta').textContent = [output.modelName, output.translated ? 'ترجمه‌شده' : ''].filter(Boolean).join(' · ');
  $('parallel-translation').hidden = !output.original;
  if (output.original) {
    $('original-language').textContent = 'زبان اصلی · ' + languageName(output.original.language);
    $('original-transcript').value = output.original.text;
    $('translated-language').textContent = 'ترجمه · ' + languageName(output.translatedTo);
  }
  $('result-note').textContent = output.mode === 'full'
    ? 'متن یکپارچه برای کپی و دانلود است. برای خروجی زمان‌دار، حالت جمله‌ای یا کلمه‌ای را انتخاب کن.'
    : output.mode === 'word' && !output.wordTimed
      ? 'کلمه‌ها قابل اصلاح‌اند. اگر ورودی صدا بوده، زمان جمله‌های اصلی در خروجی زمان‌دار حفظ می‌شود.'
      : output.rows.length ? 'روی زمان هر بخش بزن تا همان قسمت در پیش‌نمایش پخش شود.' : 'متن را پیش از دانلود اصلاح کن.';
  if (output.mode === 'full') {
    $('output-editor').append(textEditor(output.full, 'متن کامل', value => { output.full = value; }, 9));
  } else if (output.mode === 'word' && !output.wordTimed) {
    const area = document.createElement('div');
    area.className = 'word-list';
    output.wordText.forEach((word, index) => {
      const field = document.createElement('span');
      field.className = 'word-field';
      field.contentEditable = 'plaintext-only';
      field.dir = 'auto';
      field.setAttribute('role', 'textbox');
      field.setAttribute('aria-label', 'کلمهٔ ' + digits(index + 1));
      field.textContent = word;
      field.addEventListener('input', () => { output.wordText[index] = field.textContent.trim(); updateOverlay(); saveEdits(); });
      area.append(field);
    });
    $('output-editor').append(area);
  } else if (editableRows().length) {
    editableRows().forEach((row, index) => {
      const item = document.createElement('div');
      item.className = 'cue';
      const time = document.createElement('button');
      time.type = 'button';
      time.dir = 'ltr';
      time.className = 'cue-time';
      time.textContent = timestamp(row.start) + ' – ' + timestamp(row.end);
      time.setAttribute('aria-label', 'پخش بخش ' + digits(index + 1));
      time.addEventListener('click', () => {
        preview.currentTime = row.start;
        preview.play().catch(() => {});
        $('player').scrollIntoView({ block: 'nearest' });
      });
      item.append(time, textEditor(row.text, 'متن بخش ' + digits(index + 1), value => { row.text = value; }));
      $('output-editor').append(item);
    });
  } else {
    output.sections.forEach((part, index) => {
      $('output-editor').append(textEditor(part, 'جملهٔ ' + digits(index + 1), value => { output.sections[index] = value; }, 2));
    });
  }
  $('export-srt').disabled = !exportRows().length;
  $('export-graphics').disabled = !exportRows().length;
  $('graphics-note').hidden = !exportRows().length;
  $('graphics-fps-label').hidden = !exportRows().length;
  $('style-settings').hidden = !exportRows().length;
  updateOverlay();
}

function paintStyle(element, style) {
  element.style.setProperty('--caption-color', style.color);
  element.style.setProperty('--caption-font', style.family);
  element.style.setProperty('--caption-weight', style.weight);
  element.style.setProperty('--caption-size', (style.size / 52) + 'rem');
}

function renderStyles() {
  for (const [id, style] of Object.entries(CAPTION_STYLES)) {
    const label = document.createElement('label');
    label.className = 'style-tile';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'caption-style';
    radio.setAttribute('aria-label', style.name);
    radio.value = id;
    radio.checked = id === styleId;
    const sample = document.createElement('span');
    sample.className = 'style-sample';
    sample.textContent = 'صدای تو';
    paintStyle(sample, style);
    const name = document.createElement('small');
    name.textContent = style.name;
    radio.addEventListener('change', () => { styleId = id; updateOverlay(); saveEdits(); });
    label.append(radio, sample, name);
    $('caption-styles').append(label);
  }
}

function updateOverlay() {
  const rows = output ? exportRows() : [];
  const active = rows.find(row => row.start <= preview.currentTime && row.end > preview.currentTime);
  const audio = inputFile && !videoFile(inputFile);
  $('audio-subtitle').hidden = !audio || !rows.length;
  $('audio-subtitle').textContent = active?.text || '';
  paintStyle($('audio-subtitle'), CAPTION_STYLES[styleId]);
  const text = document.createElement('span');
  text.textContent = !audio ? active?.text || '' : '';
  paintStyle(text, CAPTION_STYLES[styleId]);
  $('subtitle-overlay').replaceChildren(text);
}

function download(payload, name, type) {
  const url = URL.createObjectURL(payload instanceof Blob ? payload : new Blob([payload], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function updateAudioQualities() {
  $('convert-audio-quality').replaceChildren();
  for (const quality of audioQualities($('convert-audio-format').value))
    option($('convert-audio-quality'), quality.id, quality.label);
}

preview.addEventListener('loadedmetadata', () => {
  const values = videoQualities(preview.videoWidth, preview.videoHeight);
  $('convert-video-quality').replaceChildren();
  for (const value of values) option($('convert-video-quality'), String(value), digits(value) + 'p');
  $('convert-video').hidden = !values.length;
});
$('convert-audio-format').addEventListener('change', updateAudioQualities);
updateAudioQualities();

async function convertMedia(kind) {
  if (!inputFile || busy || converting) return;
  const source = inputFile;
  preview.pause();
  converting = true;
  controls();
  $('conversion-status').textContent = kind === 'video' ? 'در حال ساخت کیفیت جدید…' : 'در حال استخراج صدا…';
  try {
    const file = kind === 'video'
      ? await resizeVideo(source, Number($('convert-video-quality').value), value => {
        $('conversion-status').textContent = 'ساخت کیفیت ویدیو · ' + digits(Math.round(value * 100)) + '٪';
      })
      : await extractAudio(source, $('convert-audio-format').value, $('convert-audio-quality').value);
    converting = false;
    if (kind === 'use') {
      setFile(file, 'derived');
      changeInput('derived');
      status('صدا آماده است. «ساخت زیرنویس» را بزن.');
    } else {
      download(file, file.name, file.type);
      $('conversion-status').textContent = 'فایل آمادهٔ ذخیره است.';
    }
  } catch (error) { $('conversion-status').textContent = error.message || 'ساخت فایل کامل نشد.'; }
  finally { converting = false; controls(); }
}
$('convert-audio-use').addEventListener('click', () => convertMedia('use'));
$('convert-audio-save').addEventListener('click', () => convertMedia('audio'));
$('convert-video-save').addEventListener('click', () => convertMedia('video'));

for (const tab of tabs) tab.addEventListener('click', () => changeInput(tab.dataset.input));
for (const event of ['pause', 'seeked']) preview.addEventListener(event, () => { if (inputFile) saveEdits(); });
$('dropzone').addEventListener('click', () => $('media-file').click());
$('media-file').addEventListener('change', event => {
  if (event.target.files.length) setFile(event.target.files[0]);
  event.target.value = '';
});
for (const event of ['dragenter', 'dragover', 'dragleave', 'drop']) {
  $('dropzone').addEventListener(event, data => {
    data.preventDefault();
    $('dropzone').classList.toggle('dragging', event === 'dragenter' || event === 'dragover');
    if (event === 'drop' && !busy && data.dataTransfer.files.length) setFile(data.dataTransfer.files[0]);
  });
}
$('source-text').addEventListener('input', () => { controls(); saveEdits(); });
$('persian-cpu').addEventListener('change', () => {
  selectedModel = 'persian';
  manualModel = true;
  renderModels();
  controls();
});
sourceLanguage.addEventListener('change', () => {
  manualSource = true;
  $('translation-note').hidden = !targetLanguage.value || targetLanguage.value === sourceLanguage.value;
  renderModels();
});
targetLanguage.addEventListener('change', () => {
  if (!manualSource) {
    sourceLanguage.value = targetLanguage.value ? 'auto' : 'fa';
    renderModels();
  }
  $('translation-note').hidden = !targetLanguage.value || targetLanguage.value === sourceLanguage.value;
});
$('record').addEventListener('click', async () => {
  if (stopRecording) {
    requestingCapture = true;
    $('record').textContent = 'آماده‌سازی ضبط…';
    controls();
    stopRecording();
    return;
  }
  showError();
  requestingCapture = true;
  controls();
  try {
    stopRecording = await startCapture(inputType, (error, file) => {
      stopRecording = null;
      requestingCapture = false;
      clearInterval(recordTimer);
      $('record-time').hidden = true;
      if (error) showError(error);
      else setFile(file);
      controls();
    });
    const begun = performance.now();
    $('record').textContent = 'توقف ضبط';
    $('record-time').textContent = '00:00';
    $('record-time').hidden = false;
    recordTimer = setInterval(() => {
      $('record-time').textContent = timestamp((performance.now() - begun) / 1000);
    }, 250);
  } catch (error) {
    showError(new Error(error.name === 'NotAllowedError' ? 'اجازهٔ ضبط داده نشد یا پنجرهٔ اشتراک‌گذاری بسته شد.' : error.message));
  } finally {
    requestingCapture = false;
    controls();
  }
});
$('remove-source').addEventListener('click', () => {
  if (!inputFile || $('remove-source').disabled) return;
  clearTimeout(saveTimer);
  const slot = slots.get(inputType);
  const wasDerived = inputType === 'derived';
  Object.assign(slot, { file: null, mediaId: '', output, time: 0, detached: Boolean(output) });
  loadMedia(null);
  if (inputType === 'file') $('media-file').value = '';
  showError();
  status('فایل از کپشن‌ساز برداشته شد.');
  if (output) showResult();
  rememberSlot(inputType, { media: true });
  if (wasDerived && !output) {
    document.querySelector('[data-input="derived"]').hidden = true;
    changeInput('file');
  } else {
    if (wasDerived) $('input-derived').hidden = true;
    controls();
  }
  document.querySelector('[data-input="' + inputType + '"]').focus();
});
$('record-save').addEventListener('click', () => {
  if (inputFile && ['mic', 'tab'].includes(inputType)) download(inputFile, inputFile.name, inputFile.type);
});
$('start').addEventListener('click', () => {
  navigator.storage?.persist?.().catch(() => {});
  run();
});
$('cancel').addEventListener('click', () => {
  busy = false;
  delete $('start').dataset.run;
  releaseWorker();
  status('متوقف شد.');
  controls();
});
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(currentText());
    $('export-status').textContent = 'کپی شد.';
  } catch { $('export-status').textContent = 'اجازهٔ کپی داده نشد. خروجی TXT را بگیر.'; }
});
$('copy-original').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(output.original.text);
    $('export-status').textContent = 'متن اصلی کپی شد.';
  } catch { $('export-status').textContent = 'اجازهٔ کپی داده نشد.'; }
});
$('export-txt').addEventListener('click', () => download(currentText(), output.fileName + '.txt', 'text/plain;charset=utf-8'));
$('export-srt').addEventListener('click', () => {
  if (exportRows().some(row => row.text.trim())) download('\ufeff' + createSrt(exportRows()), output.fileName + '.srt', 'application/x-subrip');
});
$('export-graphics').addEventListener('click', async () => {
  const button = $('export-graphics');
  const prepared = exportRows().map(row => ({ ...row }));
  const name = output.fileName;
  const fps = $('graphics-fps').value;
  const style = CAPTION_STYLES[styleId];
  button.disabled = true;
  $('export-status').textContent = 'در حال ساخت پروژهٔ پریمیر…';
  try {
    const { exportPremiere } = await import('./premiere.js');
    download(await exportPremiere(prepared, fps, style), name + '-graphics.prproj');
    $('export-status').textContent = 'پروژه آمادهٔ دانلود است.';
  } catch (error) {
    $('export-status').textContent = 'ساخت پروژه کامل نشد. ' + error.message;
  } finally { button.disabled = !output || !exportRows().length; }
});

let instagramResult;
let instagramBusy = false;
function instagramMessage(message) { $('instagram-status').textContent = message; }
function instagramControls() {
  $('instagram-url').disabled = instagramBusy;
  $('instagram-form').querySelector('button').disabled = instagramBusy;
  $('instagram-format').disabled = instagramBusy;
  $('instagram-import').disabled = instagramBusy || busy || !instagramResult;
  $('instagram-download').disabled = instagramBusy || !instagramResult;
  controls();
}
$('instagram-url').addEventListener('input', () => {
  instagramResult = null;
  $('instagram-options').hidden = true;
  $('instagram-open').hidden = true;
});
$('instagram-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (instagramBusy) return;
  instagramBusy = true;
  instagramResult = null;
  $('instagram-options').hidden = true;
  $('instagram-open').hidden = true;
  instagramControls();
  try {
    const url = normalizeInstagramUrl($('instagram-url').value);
    $('instagram-open').href = url;
    $('instagram-open').hidden = false;
    instagramMessage('در حال بررسی لینک… بار اول ممکن است موتور دانلود هم دریافت شود.');
    instagramResult = await inspectInstagram(url);
    $('instagram-format').replaceChildren();
    for (const format of instagramResult.formats) option($('instagram-format'), format.id, format.label);
    $('instagram-options').hidden = false;
    instagramMessage('کیفیت اصلی را دانلود کن یا ویدیو را وارد کن تا صدا یا کیفیت کوچک‌تر بسازی.');
  } catch (error) { instagramMessage(error.message); }
  finally { instagramBusy = false; instagramControls(); }
});
async function receiveInstagram(importIntoEditor) {
  if (!instagramResult || instagramBusy || (importIntoEditor && busy)) return;
  instagramBusy = true;
  instagramControls();
  instagramMessage('در حال دریافت فایل ویدیو…');
  try {
    const file = await loadInstagramVideo(instagramResult, $('instagram-format').value);
    if (importIntoEditor) {
      if (inputType === 'instagram' && busy) throw new Error('پردازش فعلی را تمام کن و دوباره بزن.');
      setFile(file, 'instagram');
      instagramMessage('ویدیو آماده است. برای گرفتن متن «ساخت زیرنویس» را بزن.');
    } else {
      download(file, file.name, file.type);
      instagramMessage('دانلود ویدیو آماده است.');
    }
  } catch (error) { instagramMessage(error.message); }
  finally { instagramBusy = false; instagramControls(); }
}
$('instagram-import').addEventListener('click', () => receiveInstagram(true));
$('instagram-download').addEventListener('click', () => receiveInstagram(false));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { keepCurrent(); rememberSlot(); }
});
window.addEventListener('pagehide', () => { keepCurrent(); rememberSlot(); });

renderStyles();
controls();
readDrafts(['active', ...slots.keys(), ...[...slots.keys()].map(key => 'media:' + key)]).then(saved => {
  for (const [key, slot] of slots) {
    const media = saved.get('media:' + key);
    const state = saved.get(key);
    Object.assign(slot, state, { file: media instanceof File ? media : media?.file || null });
    if (media?.id && slot.mediaId !== media.id) Object.assign(slot, { mediaId: media.id, output: null, time: 0 });
  }
  const selected = saved.get('active');
  inputType = slots.has(selected) && !['tab', 'instagram'].includes(selected) ? selected : 'file';
}).catch(() => {}).finally(() => {
  try {
    const latestTab = localStorage.getItem(DRAFT_ACTIVE);
    if (slots.has(latestTab) && !['tab', 'instagram'].includes(latestTab)) inputType = latestTab;
    for (const [type, slot] of slots) {
      const latest = JSON.parse(localStorage.getItem(DRAFT_META + type) || 'null');
      if (latest && typeof latest === 'object' && (type === 'text' || (latest.mediaId || '') === slot.mediaId)) {
        Object.assign(slot, latest, { file: slot.file });
      }
      if (type !== 'text' && !slot.file && !slot.detached) slot.output = null;
    }
  } catch { /* Use the IndexedDB records already loaded. */ }
  loading = false;
  const derived = slots.get('derived');
  document.querySelector('[data-input="derived"]').hidden = !derived.file && !derived.output;
  changeInput(inputType, true);
});
capabilities().then(value => {
  hardware = { ...value, appleMobile };
  renderHardware();
  controls();
}).catch(() => {});
