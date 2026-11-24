/**
 * IndexedDB Vault for VoyageReader
 * Uses 4 MB ArrayBuffer chunks so iOS Safari never OOMs on 200 MB+ PDFs
 * and never suffers WebKit temp-Blob eviction across app restarts.
 */

export const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB
const DB_NAME = 'voyage-reader-vault';
const DB_VERSION = 1;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) {
        const s = db.createObjectStore('books', { keyPath: 'id' });
        s.createIndex('category', 'category', { unique: false });
        s.createIndex('cached', 'cached', { unique: false });
        s.createIndex('lastReadAt', 'lastReadAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('chunks')) {
        const c = db.createObjectStore('chunks', { keyPath: 'key' });
        c.createIndex('bookId', 'bookId', { unique: false });
      }
      if (!db.objectStoreNames.contains('covers')) {
        db.createObjectStore('covers', { keyPath: 'bookId' });
      }
      if (!db.objectStoreNames.contains('bookmarks')) {
        const bm = db.createObjectStore('bookmarks', { keyPath: 'id' });
        bm.createIndex('bookId', 'bookId', { unique: false });
        bm.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---- Meta & Settings ----

export async function getMeta(key, fallback = null) {
  const db = await openDB();
  const tx = db.transaction('meta', 'readonly');
  const row = await reqPromise(tx.objectStore('meta').get(key));
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  const db = await openDB();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  await txPromise(tx);
}

// ---- Books ----

export async function getAllBooks() {
  const db = await openDB();
  const tx = db.transaction('books', 'readonly');
  return reqPromise(tx.objectStore('books').getAll());
}

export async function getBook(id) {
  const db = await openDB();
  const tx = db.transaction('books', 'readonly');
  return reqPromise(tx.objectStore('books').get(id));
}

export async function putBook(book) {
  const db = await openDB();
  const tx = db.transaction('books', 'readwrite');
  tx.objectStore('books').put(book);
  await txPromise(tx);
}

export async function putBooksBulk(books) {
  const db = await openDB();
  const tx = db.transaction('books', 'readwrite');
  const store = tx.objectStore('books');
  for (const b of books) store.put(b);
  await txPromise(tx);
}

/**
 * Merge a full catalog JSON without overwriting local reading progress,
 * favorites, page counts, or cached offline status.
 */
export async function mergeCatalog(catalog) {
  const existing = await getAllBooks();
  const existingById = new Map(existing.map((b) => [b.id, b]));
  const existingByNameSize = new Map(
    existing.map((b) => [`${b.filename}::${b.size}`, b])
  );

  const merged = [];
  for (const cb of catalog.books || []) {
    const prev = existingById.get(cb.id) || existingByNameSize.get(`${cb.filename}::${cb.size}`);
    merged.push({
      id: cb.id,
      filename: cb.filename,
      title: cb.title,
      format: cb.format || (cb.filename.toLowerCase().endsWith('.epub') ? 'epub' : 'pdf'),
      mimeType: cb.mimeType || (cb.format === 'epub' ? 'application/epub+zip' : 'application/pdf'),
      size: cb.size || 0,
      category: cb.category || '未分類',
      categories: cb.categories || [cb.category || '未分類'],
      driveFileId: cb.driveFileId || prev?.driveFileId || null,
      packs: cb.packs || prev?.packs || [],
      // Preserve local user state
      cached: prev?.cached ? 1 : 0,
      chunkCount: prev?.chunkCount || 0,
      cachedSize: prev?.cachedSize || 0,
      totalPages: prev?.totalPages || 0,
      currentPage: prev?.currentPage || 1,
      currentChapter: prev?.currentChapter || 0,
      scrollRatio: prev?.scrollRatio || 0,
      favorite: !!prev?.favorite,
      lastReadAt: prev?.lastReadAt || 0,
      importedAt: prev?.importedAt || 0,
      hasCover: !!prev?.hasCover,
    });
  }

  await putBooksBulk(merged);

  await setMeta('catalogInfo', {
    libraryName: catalog.libraryName || '離線書庫',
    generatedAt: catalog.generatedAt || new Date().toISOString(),
    totalUniqueBooks: catalog.totalUniqueBooks || merged.length,
    totalUniqueBytes: catalog.totalUniqueBytes || merged.reduce((s, b) => s + (b.size || 0), 0),
    categories: catalog.categories || [],
    packs: catalog.packs || [],
  });

  return merged.length;
}

/**
 * Store a Blob/File into 4 MB IndexedDB ArrayBuffer chunks.
 * Uses only ~4 MB RAM at a time regardless of file size (even 205 MB PDFs!).
 */
export async function saveBookBlobChunked(bookId, blob, onChunkProgress) {
  // Remove any stale chunks for this book first
  await deleteBookChunks(bookId);

  const totalSize = blob.size;
  const totalChunks = Math.max(1, Math.ceil(totalSize / CHUNK_SIZE));

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(totalSize, start + CHUNK_SIZE);
    const buffer = await blob.slice(start, end).arrayBuffer();

    const db = await openDB();
    const tx = db.transaction('chunks', 'readwrite');
    tx.objectStore('chunks').put({
      key: `${bookId}:${i}`,
      bookId,
      index: i,
      data: buffer,
    });
    await txPromise(tx);
    if (onChunkProgress) onChunkProgress(i + 1, totalChunks);
  }

  return { chunkCount: totalChunks, cachedSize: totalSize };
}

export async function getBookChunk(bookId, index) {
  const db = await openDB();
  const tx = db.transaction('chunks', 'readonly');
  const row = await reqPromise(tx.objectStore('chunks').get(`${bookId}:${index}`));
  return row ? row.data : null;
}

/**
 * Read an arbitrary byte range [begin, end) across 4 MB IndexedDB chunks
 * with a small in-memory LRU cache (max 4 chunks = 16 MB RAM).
 */
export class ChunkedByteReader {
  constructor(bookId, totalSize, maxCachedChunks = 4) {
    this.bookId = bookId;
    this.totalSize = totalSize;
    this.maxCachedChunks = maxCachedChunks;
    this.cache = new Map(); // chunkIndex -> Uint8Array
    this.inflight = new Map();
  }

  async _loadChunk(idx) {
    if (this.cache.has(idx)) {
      const val = this.cache.get(idx);
      // Refresh LRU order
      this.cache.delete(idx);
      this.cache.set(idx, val);
      return val;
    }
    if (this.inflight.has(idx)) {
      return this.inflight.get(idx);
    }
    const p = getBookChunk(this.bookId, idx).then((buf) => {
      this.inflight.delete(idx);
      if (!buf) throw new Error(`Missing chunk ${idx} for book ${this.bookId}`);
      const u8 = new Uint8Array(buf);
      this.cache.set(idx, u8);
      if (this.cache.size > this.maxCachedChunks) {
        const oldestKey = this.cache.keys().next().value;
        this.cache.delete(oldestKey);
      }
      return u8;
    });
    this.inflight.set(idx, p);
    return p;
  }

  async readRange(begin, end) {
    const safeBegin = Math.max(0, begin);
    const safeEnd = Math.min(this.totalSize, end);
    const len = safeEnd - safeBegin;
    if (len <= 0) return new Uint8Array(0);

    const startChunk = Math.floor(safeBegin / CHUNK_SIZE);
    const endChunk = Math.floor((safeEnd - 1) / CHUNK_SIZE);

    if (startChunk === endChunk) {
      const ch = await this._loadChunk(startChunk);
      const localStart = safeBegin - startChunk * CHUNK_SIZE;
      return ch.slice(localStart, localStart + len);
    }

    const out = new Uint8Array(len);
    let written = 0;
    for (let idx = startChunk; idx <= endChunk; idx++) {
      const ch = await this._loadChunk(idx);
      const chunkStartByte = idx * CHUNK_SIZE;
      const from = Math.max(0, safeBegin - chunkStartByte);
      const to = Math.min(ch.length, safeEnd - chunkStartByte);
      out.set(ch.subarray(from, to), written);
      written += to - from;
    }
    return out;
  }

  /**
   * Assemble full Blob (for small files like EPUBs <= 50 MB).
   */
  async toBlob(mimeType = 'application/octet-stream') {
    const count = Math.max(1, Math.ceil(this.totalSize / CHUNK_SIZE));
    const parts = [];
    for (let i = 0; i < count; i++) {
      const buf = await getBookChunk(this.bookId, i);
      if (!buf) throw new Error(`Missing chunk ${i}`);
      parts.push(buf);
    }
    return new Blob(parts, { type: mimeType });
  }

  destroy() {
    this.cache.clear();
    this.inflight.clear();
  }
}

export async function deleteBookChunks(bookId) {
  const db = await openDB();
  const tx = db.transaction('chunks', 'readwrite');
  const idx = tx.objectStore('chunks').index('bookId');
  const keys = await reqPromise(idx.getAllKeys(bookId));
  const store = tx.objectStore('chunks');
  for (const k of keys) store.delete(k);
  await txPromise(tx);
}

export async function removeBookCache(bookId) {
  await deleteBookChunks(bookId);
  const book = await getBook(bookId);
  if (book) {
    book.cached = 0;
    book.chunkCount = 0;
    book.cachedSize = 0;
    await putBook(book);
  }
}

// ---- Covers ----

export async function saveCover(bookId, dataUrl) {
  const db = await openDB();
  const tx = db.transaction('covers', 'readwrite');
  tx.objectStore('covers').put({ bookId, dataUrl, updatedAt: Date.now() });
  await txPromise(tx);
}

export async function getCover(bookId) {
  const db = await openDB();
  const tx = db.transaction('covers', 'readonly');
  const row = await reqPromise(tx.objectStore('covers').get(bookId));
  return row ? row.dataUrl : null;
}

export async function getAllCoversMap() {
  const db = await openDB();
  const tx = db.transaction('covers', 'readonly');
  const rows = await reqPromise(tx.objectStore('covers').getAll());
  return new Map(rows.map((r) => [r.bookId, r.dataUrl]));
}

// ---- Bookmarks & Notes ----

export async function getAllBookmarks() {
  const db = await openDB();
  const tx = db.transaction('bookmarks', 'readonly');
  const rows = await reqPromise(tx.objectStore('bookmarks').getAll());
  return rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function getBookmarksForBook(bookId) {
  const db = await openDB();
  const tx = db.transaction('bookmarks', 'readonly');
  const rows = await reqPromise(tx.objectStore('bookmarks').index('bookId').getAll(bookId));
  return rows.sort((a, b) => (a.page || 0) - (b.page || 0) || (b.createdAt || 0) - (a.createdAt || 0));
}

export async function saveBookmark(bm) {
  const db = await openDB();
  const tx = db.transaction('bookmarks', 'readwrite');
  tx.objectStore('bookmarks').put(bm);
  await txPromise(tx);
}

export async function deleteBookmark(id) {
  const db = await openDB();
  const tx = db.transaction('bookmarks', 'readwrite');
  tx.objectStore('bookmarks').delete(id);
  await txPromise(tx);
}

// ---- Export / Import user reading state & notes ----

export async function exportReadingBackup() {
  const books = await getAllBooks();
  const bookmarks = await getAllBookmarks();
  const settings = await getMeta('settings', {});
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    progress: books
      .filter((b) => b.lastReadAt > 0 || b.favorite || b.currentPage > 1 || b.currentChapter > 0)
      .map((b) => ({
        id: b.id,
        filename: b.filename,
        currentPage: b.currentPage,
        totalPages: b.totalPages,
        currentChapter: b.currentChapter,
        scrollRatio: b.scrollRatio,
        favorite: b.favorite,
        lastReadAt: b.lastReadAt,
      })),
    bookmarks,
  };
}

export async function importReadingBackup(backup) {
  if (!backup || typeof backup !== 'object') throw new Error('無效的備份檔');
  if (backup.settings) await setMeta('settings', backup.settings);
  if (Array.isArray(backup.progress)) {
    const books = await getAllBooks();
    const byId = new Map(books.map((b) => [b.id, b]));
    const updated = [];
    for (const p of backup.progress) {
      const b = byId.get(p.id);
      if (b) {
        b.currentPage = p.currentPage ?? b.currentPage;
        b.totalPages = p.totalPages || b.totalPages;
        b.currentChapter = p.currentChapter ?? b.currentChapter;
        b.scrollRatio = p.scrollRatio ?? b.scrollRatio;
        b.favorite = !!p.favorite;
        b.lastReadAt = Math.max(b.lastReadAt || 0, p.lastReadAt || 0);
        updated.push(b);
      }
    }
    if (updated.length) await putBooksBulk(updated);
  }
  if (Array.isArray(backup.bookmarks)) {
    const db = await openDB();
    const tx = db.transaction('bookmarks', 'readwrite');
    const store = tx.objectStore('bookmarks');
    for (const bm of backup.bookmarks) store.put(bm);
    await txPromise(tx);
  }
}
