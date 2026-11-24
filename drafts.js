let connection;

function database() {
  connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('xpert-caption-web-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Draft storage is in use.'));
  });
  return connection;
}

export async function readDrafts(keys) {
  const db = await database();
  const tx = db.transaction('drafts');
  const store = tx.objectStore('drafts');
  const records = await Promise.all(keys.map(key => new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve([key, request.result]);
    request.onerror = () => reject(request.error);
  })));
  return new Map(records);
}

export async function writeDraft(entries) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite');
    const store = tx.objectStore('drafts');
    for (const [key, value] of entries) store.put(value, key);
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}
