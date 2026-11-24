import { timedRows, groupWords } from './core.js';
import { fetchModelFile, modelCache, registerModelRevision } from './model-cache.js';
import { speechRanges } from './speech-filter.js';

const CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js';
const MOBILE_CDN = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';
const TRANSLATOR = 'Xenova/m2m100_418M';
const TRANSLATOR_REV = '9c374f0b7aca709787cea97b047bfbbd1559d177';
let transformers;
let mobileTransformers;
let active;
let modelProgress;

async function getLibrary() {
  if (!transformers) {
    transformers = import(CDN).then(module => {
      module.env.allowLocalModels = false;
      module.env.useBrowserCache = false;
      module.env.useCustomCache = true;
      module.env.customCache = modelCache;
      module.env.fetch = (url, options) => fetchModelFile(url, options, (file, loaded, total) =>
        modelProgress?.({ type: 'model-transfer', file, loaded, total }));
      module.env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
        ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1)) : 1;
      return module;
    }).catch(error => {
      transformers = null;
      throw error;
    });
  }
  return transformers;
}

function reportModelTransfer(file, loaded, total) {
  modelProgress?.({ type: 'model-transfer', file, loaded, total });
}

async function getMobileLibrary() {
  if (!mobileTransformers) {
    // Transformers 2 uses the worker's fetch directly. Limit the override to the mobile speech model.
    const originalFetch = self.fetch.bind(self);
    self.fetch = (url, options) => typeof url === 'string' &&
      url.startsWith('https://huggingface.co/Xenova/whisper-tiny/resolve/')
      ? fetchModelFile(url, options, reportModelTransfer) : originalFetch(url, options);
    mobileTransformers = import(MOBILE_CDN).then(module => {
      module.env.allowLocalModels = false;
      module.env.useBrowserCache = false;
      module.env.useCustomCache = true;
      module.env.customCache = modelCache;
      module.env.backends.onnx.wasm.numThreads = 1;
      module.env.backends.onnx.wasm.proxy = false;
      return module;
    }).catch(error => { self.fetch = originalFetch; mobileTransformers = null; throw error; });
  }
  return mobileTransformers;
}

async function unload() {
  if (active) {
    const pipeline = active.instance;
    active = null;
    await pipeline.dispose();
  }
}

async function getPipeline(kind, model, post) {
  const key = [kind, model.repo, model.device, model.dtype].join('/');
  if (active?.key === key) return active.instance;
  await unload();
  registerModelRevision(model.repo, model.revision);
  post({ type: 'stage', stage: 'model' });
  const iphone = model.id === 'iphone';
  const { pipeline } = await (iphone ? getMobileLibrary() : getLibrary());
  const instance = await pipeline(kind, model.repo, {
    ...(iphone ? { quantized: true } : { device: model.device, dtype: model.dtype }),
    revision: model.revision,
    progress_callback(event) {
      post({ type: 'download', state: event.status, file: event.file, loaded: event.loaded, total: event.total });
    },
  });
  active = { key, instance };
  return instance;
}

async function speechJob(message, post) {
  const duration = message.audio.length / 16000;
  const input = message.audio;
  let windows = [[0, duration]];
  if (message.filterSpeech) {
    post({ type: 'stage', stage: 'speechScan' });
    try { windows = await speechRanges(input, await getLibrary()); }
    catch { post({ type: 'stage', stage: 'speechScanFallback' }); }
    if (!windows.length) throw new Error('گفتار واضحی پیدا نشد. ضبط را پخش کن و سطح صدا را بررسی کن. برای ویس مرورگر از «صدای تب» استفاده کن.');
  }
  let model = message.model;
  const iphone = model.id === 'iphone';
  async function execute() {
    const transcriber = await getPipeline('automatic-speech-recognition', model, post);
    post({ type: 'stage', stage: 'speech' });
    const chunks = [];
    const text = [];
    let realWords = message.words;
    for (const [index, [start, end]] of windows.entries()) {
      const samples = input.subarray(Math.round(start * 16000), Math.round(end * 16000));
      const config = {
        ...(end - start > (iphone ? 15 : 25) ? { chunk_length_s: iphone ? 15 : 24, stride_length_s: iphone ? 2 : 3 } : {}),
        task: 'transcribe', return_timestamps: realWords ? 'word' : true,
        num_beams: iphone ? 1 : model.id === 'persian' ? (model.device === 'webgpu' ? 3 : 2) : 2,
        ...(message.language === 'auto' ? {} : { language: message.language }),
      };
      let result;
      try { result = await transcriber(samples, config); }
      catch (error) {
        if (!realWords || !/attention|alignment.head|token.timestamp/i.test(String(error))) throw error;
        post({ type: 'stage', stage: 'sentenceFallback' });
        realWords = false;
        result = await transcriber(samples, { ...config, return_timestamps: true });
      }
      if (result.text?.trim()) text.push(result.text.trim());
      for (const row of timedRows(result.chunks, end - start)) {
        chunks.push({ text: row.text, timestamp: [start + row.start, start + row.end] });
      }
      post({ type: 'speechProgress', value: (index + 1) / windows.length });
    }
    return { result: { chunks, text: text.join(' ') }, realWords };
  }
  let decoded;
  try {
    decoded = await execute();
  } catch (error) {
    const text = String(error);
    const gpuFailure = /WebGPU|GPUBuffer|shader|adapter|device was lost|memory allocation|GPU limits/i.test(text);
    if (model.device !== 'webgpu' || !gpuFailure || !message.fallback) throw error;
    await unload().catch(() => {});
    model = message.fallback;
    post({ type: 'stage', stage: 'gpuFallback', model: model.title });
    decoded = await execute();
  }
  const words = timedRows(decoded.result.chunks, duration);
  return {
    transcript: decoded.result.text?.trim() || '',
    rows: decoded.realWords ? groupWords(words) : words,
    words: decoded.realWords ? words : [],
    model: model.title,
  };
}

async function translationJob(message, post) {
  if (message.from === message.to) return message.parts;
  const model = { repo: TRANSLATOR, revision: TRANSLATOR_REV, device: 'wasm', dtype: 'q8' };
  const translator = await getPipeline('translation', model, post);
  post({ type: 'stage', stage: 'translation' });
  const result = [];
  for (const [index, text] of message.parts.entries()) {
    const translated = await translator(text, { src_lang: message.from, tgt_lang: message.to, max_new_tokens: 240, num_beams: 2 });
    const translatedText = translated[0]?.translation_text?.trim();
    if (!translatedText) throw new Error('مترجم برای یکی از بخش‌ها متن برنگرداند.');
    result.push(translatedText);
    post({ type: 'fraction', value: (index + 1) / message.parts.length });
  }
  return result;
}

self.addEventListener('message', async ({ data }) => {
  const post = value => self.postMessage({ ...value, id: data.id });
  modelProgress = post;
  try {
    let payload;
    if (data.kind === 'speech') payload = await speechJob(data, post);
    else if (data.kind === 'translation') payload = await translationJob(data, post);
    else if (data.kind === 'unload') await unload();
    else throw new Error('درخواست پردازش معتبر نیست.');
    post({ type: 'result', payload });
  } catch (error) {
    post({ type: 'error', message: String(error?.message || error) });
  } finally { modelProgress = null; }
});
