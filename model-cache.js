const BLOCK = 64 * 1024 * 1024;
const RANGE_SIZE = 8 * 1024 * 1024;
const MAX_RANGE_FILE = 2 * 1024 * 1024 * 1024;
const CACHE = 'xpert-caption-models-v1';
const DISK_ENDPOINT = '/api/models';
const MODEL_URL = /^https:\/\/huggingface\.co\/([\w-]+\/[\w.-]+)\/resolve\/(main|[a-f0-9]{40})\/((?:onnx\/)?[\w.-]+)$/;
const diskHeaders = { 'X-Xpert-Local-Request': 'model-store' };
const android = location.origin === 'https://appassets.androidplatform.net';
const modelRevisions = new Map();
const mobileSpeechModels = new Set();
const fetchUpstream = globalThis.fetch.bind(globalThis);
let directory;
let diskSupport;
let mobileDatabase;

export function isMobileSpeech(url) {
  const match = MODEL_URL.exec(url);
  return Boolean(match && mobileSpeechModels.has(match[1]));
}

function openMobileDatabase() {
  mobileDatabase ??= new Promise(resolve => {
    if (!globalThis.indexedDB) { resolve(null); return; }
    const request = indexedDB.open(CACHE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => resolve(null);
  }).catch(() => null);
  return mobileDatabase;
}

async function mobileFile(db, key, value) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('files', value === undefined ? 'readonly' : 'readwrite');
    const files = transaction.objectStore('files');
    const request = value === undefined ? files.get(key) : files.put(value, key);
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function rangeStore(url, create = false) {
  const dir = await getDirectory();
  if (dir) {
    const folder = await dir.getDirectoryHandle('ranges-' + await cacheKey(url), { create }).catch(() => null);
    if (folder) return {
      read: name => folder.getFileHandle(name).then(handle => handle.getFile()),
      write: (name, body) => writeRangeFile(folder, name, body),
    };
  }
  const db = isMobileSpeech(url) && await openMobileDatabase();
  return db ? {
    async read(name) {
      const bytes = await mobileFile(db, url + '#' + name);
      return bytes && new Blob([bytes]);
    },
    write: (name, body) => mobileFile(db, url + '#' + name,
      typeof body === 'string' ? new TextEncoder().encode(body) : body),
  } : null;
}

export function registerModelRevision(repo, revision, mobileSpeech = false) {
  modelRevisions.set(repo, revision);
  if (mobileSpeech) mobileSpeechModels.add(repo);
}

export function pinnedModelUrl(url) {
  const model = MODEL_URL.exec(url);
  if (model?.[2] !== 'main') return url;
  const revision = modelRevisions.get(model[1]);
  return revision ? 'https://huggingface.co/' + model[1] + '/resolve/' + revision + '/' + model[3] : url;
}

export async function fetchModelFile(url, options, report = () => {}) {
  const canonical = typeof url === 'string' ? pinnedModelUrl(url) : url;
  if (android && typeof canonical === 'string') {
    const route = await diskRoute(canonical);
    if (route) {
      const saved = await androidRequest('download', route).catch(() => null);
      if (saved?.missing) return new Response('', { status: 404 });
      if (saved?.body) return nativeResponse(saved);
    }
  }
  if (!android && typeof canonical === 'string' && isWeight(canonical) && !await diskRoute(canonical)) {
    const storage = await rangeStore(canonical, true);
    if (storage) {
      const download = () => downloadRanges(canonical, options, storage, report);
      if (navigator.locks) return navigator.locks.request('xpert-model-' + await cacheKey(canonical), download);
      return download();
    }
  }
  return fetchUpstream(canonical, options);
}

function getDirectory() {
  directory ??= navigator.storage?.getDirectory?.()
    .then(root => root.getDirectoryHandle(CACHE, { create: true }))
    .catch(() => null);
  return directory;
}

async function cacheKey(url) {
  const data = new TextEncoder().encode(url);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function cachedBlob(dir, key) {
  const meta = await dir.getFileHandle(key + '.json').then(f => f.getFile()).then(f => f.text()).then(JSON.parse);
  const parts = await Promise.all(Array.from({ length: meta.count }, (_, i) =>
    dir.getFileHandle(key + '.' + i).then(handle => handle.getFile())
  ));
  if (parts.reduce((total, part) => total + part.size, 0) !== meta.size) return undefined;
  return new Blob(parts);
}

async function openWritable(handle) {
  if (handle.createWritable) return handle.createWritable();
  const file = await handle.createSyncAccessHandle();
  let offset = 0;
  return {
    async write(chunk) {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
      if (file.write(bytes, { at: offset }) !== bytes.byteLength) throw new Error('Incomplete model write');
      offset += bytes.byteLength;
    },
    async close() {
      try {
        file.truncate(offset);
        file.flush();
      } finally { file.close(); }
    },
    async abort() { file.close(); },
  };
}

function isWeight(url) {
  return /\/resolve\/[a-f0-9]{40}\/onnx\//.test(url) &&
    /\.(?:onnx(?:_data(?:_\d+)?)?|ort)$/.test(url) && MODEL_URL.test(url);
}

async function readSize(storage) {
  try {
    const size = Number(await (await storage.read('size'))?.text());
    return Number.isSafeInteger(size) && size > 0 && size <= MAX_RANGE_FILE ? size : 0;
  } catch { return 0; }
}

async function loadParts(storage, total) {
  const parts = [];
  let offset = 0;
  while (offset < total) {
    const expected = Math.min(RANGE_SIZE, total - offset);
    try {
      const file = await storage.read('part-' + parts.length);
      if (file?.size !== expected) break;
      parts.push(file);
      offset += file.size;
    } catch { break; }
  }
  return { parts, offset };
}

async function writeRangeFile(folder, name, body) {
  let output;
  try {
    output = await openWritable(await folder.getFileHandle(name, { create: true }));
    await output.write(body);
    await output.close();
  } catch (error) {
    if (output) await output.abort().catch(() => {});
    throw error;
  }
}

async function requestRange(url, options, start, end) {
  const headers = new Headers(options?.headers);
  headers.set('Range', 'bytes=' + start + '-' + end);
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await fetchUpstream(url, { ...options, headers });
      if (result.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(result.headers.get('content-range') || '');
        if (!range) {
          await result.body?.cancel().catch(() => {});
          return { full: await fetchUpstream(url, options) };
        }
        const [, a, b, size] = range.map(Number);
        if (a !== start || b !== Math.min(end, size - 1) || size <= start || size > MAX_RANGE_FILE)
          throw new Error('Invalid model range');
        const data = new Uint8Array(await result.arrayBuffer());
        if (data.length !== b - a + 1) throw new Error('Incomplete model range');
        return { data, size };
      }
      if (result.status !== 429 && result.status < 500) return { full: result };
      await result.body?.cancel().catch(() => {});
      throw new Error('Temporary download failure');
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      if (attempt >= 2) throw new Error('دانلود مدل قطع شد. دوباره شروع کن تا از بخش‌های ذخیره‌شده ادامه بدهد.', { cause: error });
      await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
    }
  }
}

async function downloadRanges(url, options, storage, report) {
  let total = await readSize(storage);
  let { parts, offset } = await loadParts(storage, total);
  if (total && offset) report(url, offset, total);
  while (!total || offset < total) {
    const chunk = await requestRange(url, options, offset, offset + RANGE_SIZE - 1);
    if (chunk.full) {
      if (!offset || !chunk.full.ok || chunk.full.status === 200) return chunk.full;
      throw new Error('سرور ادامهٔ دانلود مدل را نپذیرفت. دوباره تلاش کن.');
    }
    if (total && total !== chunk.size) {
      throw new Error('اندازهٔ فایل مدل تغییر کرد. دوباره تلاش کن.');
    }
    const key = 'part-' + parts.length;
    try {
      if (!total) {
        total = chunk.size;
        await storage.write('size', String(total));
      }
      await storage.write(key, chunk.data);
      parts.push(await storage.read(key));
    } catch (error) {
      throw new Error('فضای ذخیرهٔ مدل در مرورگر کافی نیست یا در دسترس نیست.', { cause: error });
    }
    offset += chunk.data.length;
    report(url, offset, total);
  }
  return blobResponse(new Blob(parts));
}

async function storeResponse(dir, key, response) {
  const stream = response.body.getReader();
  let part = 0;
  let filled = 0;
  let size = 0;
  let file;
  try {
    while (true) {
      const { value, done } = await stream.read();
      if (done) break;
      let offset = 0;
      while (offset < value.length) {
        if (!file) file = await dir.getFileHandle(key + '.' + part, { create: true }).then(openWritable);
        const n = Math.min(BLOCK - filled, value.length - offset);
        await file.write(value.subarray(offset, offset + n));
        size += n;
        filled += n;
        offset += n;
        if (filled === BLOCK) {
          await file.close();
          file = null;
          filled = 0;
          part++;
        }
      }
    }
    if (file) {
      await file.close();
      file = null;
      part++;
    }
    file = await dir.getFileHandle(key + '.json', { create: true }).then(openWritable);
    await file.write(JSON.stringify({ count: part, size }));
    await file.close();
    file = null;
  } finally {
    if (file) await file.abort().catch(() => {});
    await stream.cancel().catch(() => {});
  }
}

async function diskRoute(url) {
  if (!android && (location.protocol !== 'http:' || location.hostname !== '127.0.0.1')) return null;
  const match = MODEL_URL.exec(url);
  if (!match) return null;
  diskSupport ??= (android ? androidRequest('probe', DISK_ENDPOINT) :
    fetchDisk(DISK_ENDPOINT).then(async response => response.ok && await response.text() === 'Xpert Caption Model Store 1')
  ).catch(() => false);
  return await diskSupport ? DISK_ENDPOINT + '/' + match.slice(1).join('/') : null;
}

function androidRequest(action, route, blob) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = event => {
      channel.port1.close();
      resolve(event.data);
    };
    channel.port1.onmessageerror = () => {
      channel.port1.close();
      reject(new Error('Android model transfer failed'));
    };
    self.postMessage({ type: 'model-store', action, route, blob, result: channel.port2 }, [channel.port2]);
  });
}

function fetchDisk(route) {
  return fetch(route, { headers: diskHeaders, redirect: 'error', cache: 'no-store' });
}

async function readFromDisk(route) {
  const response = android ? await androidRequest('read', route) : await fetchDisk(route);
  if (android) {
    if (response?.body) return nativeResponse(response);
    return undefined;
  }
  if (response.ok && response.headers.get('content-type') === 'application/octet-stream') return response;
  return undefined;
}

function nativeResponse(response) {
  const headers = response.size ? { 'content-length': response.size } : {};
  return new Response(response.body, { headers });
}

async function saveToDisk(route, blob) {
  if (!blob?.size) return false;
  try {
    if (android) return await androidRequest('write', route, blob) === true;
    const result = await fetch(route, { method: 'PUT', headers: diskHeaders, body: blob, redirect: 'error' });
    return result.ok;
  } catch { return false; }
}

function blobResponse(blob) {
  return new Response(blob, { headers: { 'content-length': String(blob.size) } });
}

async function storeForLauncher(route, key, request, response, dir) {
  // Assemble large files from disk-backed parts so uploading takes a bounded amount of RAM.
  const stagingName = 'transfer-' + crypto.randomUUID();
  const staging = await dir?.getDirectoryHandle(stagingName, { create: true }).catch(() => null);
  if (!staging || !response.body) {
    const blob = await response.blob();
    if (!await saveToDisk(route, blob)) await (await caches.open(CACHE)).put(request, blobResponse(blob));
    if (staging) await dir.removeEntry(stagingName).catch(() => {});
    return;
  }
  try {
    await storeResponse(staging, key, response);
    const blob = await cachedBlob(staging, key);
    if (blob && !await saveToDisk(route, blob)) await storeResponse(dir, key, blobResponse(blob));
  } finally {
    await dir.removeEntry(stagingName, { recursive: true }).catch(() => {});
  }
}

export const modelCache = {
  async match(request) {
    const url = typeof request === 'string' ? request : request.url;
    const canonical = pinnedModelUrl(url);
    const route = await diskRoute(canonical);
    if (route) {
      const saved = await readFromDisk(route).catch(() => undefined);
      if (saved) return saved;
    }
    for (const key of canonical === url ? [url] : [canonical, url]) {
      try {
        const dir = await getDirectory();
        const digest = dir ? await cacheKey(key) : null;
        let blob;
        if (isWeight(key)) {
          try {
            const storage = await rangeStore(key);
            const size = storage ? await readSize(storage) : 0;
            const saved = await loadParts(storage, size);
            if (size && saved.offset === size) blob = new Blob(saved.parts);
          } catch { /* An interrupted download keeps its finished chunks. */ }
        }
        blob ??= digest ? await cachedBlob(dir, digest) : undefined;
        if (blob) {
          if (route) await saveToDisk(route, blob);
          return blobResponse(blob);
        }
      } catch { /* Absent and incomplete cache entries are safe to miss. */ }
      if (isMobileSpeech(key)) {
        try {
          const db = await openMobileDatabase();
          const bytes = db && await mobileFile(db, key);
          if (bytes) return blobResponse(new Blob([bytes]));
        } catch { /* IndexedDB can be disabled by browser policy. */ }
      }
      try {
        const previous = await (await caches.open(CACHE)).match(key);
        if (!previous) continue;
        if (route) {
          try { await saveToDisk(route, await previous.clone().blob()); }
          catch { /* Reuse even if the copy could not be saved. */ }
        }
        return previous;
      } catch { /* Cache storage can be disabled in private browsing. */ }
    }
    return undefined;
  },
  async put(request, response) {
    const url = typeof request === 'string' ? request : request.url;
    const canonical = pinnedModelUrl(url);
    try {
      const dir = await getDirectory();
      const route = await diskRoute(canonical);
      if (route) {
        await storeForLauncher(route, await cacheKey(canonical), canonical, response, dir);
        return;
      }
      if (dir && response.body) {
        await storeResponse(dir, await cacheKey(canonical), response);
        return;
      }
      const db = isMobileSpeech(canonical) && await openMobileDatabase();
      if (db) {
        const ranges = isWeight(canonical) ? await rangeStore(canonical) : null;
        const size = ranges ? await readSize(ranges) : 0;
        if (!size || (await loadParts(ranges, size)).offset !== size) {
          await mobileFile(db, canonical, await response.arrayBuffer());
        }
        return;
      }
      await (await caches.open(CACHE)).put(canonical, response);
    } catch { /* Private mode, policy and disk limits do not block inference. */ }
  },
};
