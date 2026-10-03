// Your own background photo, kept on this device in IndexedDB (photos are
// too big for localStorage). Images are scaled down before saving.

const DB = 'tempo';
const STORE = 'files';
const KEY = 'background';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

/** Scale an image file down to at most `max` pixels on its long side. */
async function shrink(file, max = 2400) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function save(file) {
  const blob = await shrink(file);
  await tx('readwrite', (s) => s.put(blob, KEY));
  return blob;
}

export async function load() {
  try {
    return (await tx('readonly', (s) => s.get(KEY))) || null;
  } catch {
    return null;
  }
}

export async function remove() {
  try {
    await tx('readwrite', (s) => s.delete(KEY));
  } catch {
    /* nothing stored */
  }
}

let currentUrl = null;

/** Show (or clear, with null) the background photo. */
export function apply(blob) {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = blob ? URL.createObjectURL(blob) : null;
  const layer = document.querySelector('.photo-bg');
  if (layer) layer.style.backgroundImage = currentUrl ? `url("${currentUrl}")` : '';
  document.body.classList.toggle('has-photo', Boolean(currentUrl));
}
