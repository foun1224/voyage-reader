/**
 * 航海書庫 · VoyageReader Main Application Controller
 * Privacy-first, 100% offline iPhone PWA for PDF & EPUB reading.
 */

import {
  openDB,
  getAllBooks,
  getBook,
  putBook,
  mergeCatalog,
  saveBookBlobChunked,
  removeBookCache,
  saveCover,
  getAllCoversMap,
  getAllBookmarks,
  getBookmarksForBook,
  saveBookmark,
  deleteBookmark,
  getMeta,
  setMeta,
  exportReadingBackup,
  importReadingBackup,
} from './db.js';

import {
  listZipEntries,
  extractZipEntryBlob,
  extractZipEntryText,
} from './zip-reader.js';

import {
  PdfReaderController,
  generatePdfCover,
} from './pdf-reader.js';

import {
  EpubReaderController,
  generateEpubCover,
} from './epub-reader.js';

// ---- Utilities ----

const COVER_PALETTES = [
  ['#2A394A', '#19222E'],
  ['#4A342B', '#2C1E18'],
  ['#2D423A', '#1B2B25'],
  ['#3B3548', '#231F2C'],
  ['#4D3D2A', '#2E2316'],
  ['#2B3E47', '#18262C'],
  ['#4B2F34', '#2C1A1E'],
];

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function paletteFor(str) {
  return COVER_PALETTES[hashStr(str || 'book') % COVER_PALETTES.length];
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cleanTitleFromFilename(fn) {
  return fn
    .replace(/\.(pdf|epub)$/i, '')
    .replace(/_Optimized$/i, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function makeBookId(filename, size) {
  // Deterministic local ID when importing standalone files without catalog
  return `local_${hashStr(`${filename}:${size}`).toString(36)}_${size.toString(36)}`;
}

// ---- App State ----

const state = {
  tab: 'reading',
  books: [],
  covers: new Map(),
  bookmarks: [],
  catalogInfo: null,
  search: '',
  scope: 'all', // 'all' | 'offline' | 'favorite'
  category: 'ALL',
  layout: 'grid', // 'grid' | 'list'
  settings: {
    theme: 'day', // 'day' | 'sepia' | 'night'
    autoCrop: true,
    highContrast: false,
    fontSize: 18,
    lineHeight: 1.75,
  },
  activeBook: null,
  activeReader: null,
  activeOutline: [],
  hudVisible: true,
  importing: false,
  coverQueueRunning: false,
};

// ---- DOM References ----

const $ = (id) => document.getElementById(id);

let toastTimer = null;
function showToast(msg, duration = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ---- Theme Management ----

function applyTheme(theme) {
  state.settings.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  $('readerOverlay').setAttribute('data-pdf-filter', theme);
  const metaColor = $('metaThemeColor');
  const metaIos = $('metaIosStatus');
  if (theme === 'night') {
    metaColor.content = '#12161D';
    metaIos.content = 'black';
  } else if (theme === 'sepia') {
    metaColor.content = '#EAE0CC';
    metaIos.content = 'default';
  } else {
    metaColor.content = '#F7F3EC';
    metaIos.content = 'default';
  }
  $('readerOverlay').classList.toggle('high-contrast', !!state.settings.highContrast);
  setMeta('settings', state.settings).catch(() => {});
}

// ---- Sheet Modal Helper ----

function openSheet(html, onReady) {
  $('sheetBody').innerHTML = html;
  $('sheetBackdrop').classList.add('open');
  onReady?.($('sheetBody'));
}

function closeSheet() {
  $('sheetBackdrop').classList.remove('open');
}

// ---- Network Status ----

function updateOnlineBadge() {
  const chip = $('netStatusChip');
  if (navigator.onLine) {
    chip.textContent = '線上';
    chip.classList.remove('is-offline');
  } else {
    chip.textContent = '離線模式';
    chip.classList.add('is-offline');
  }
}

// ---- Data Loading ----

async function reloadData() {
  await openDB();
  const [books, covers, bookmarks, catalogInfo, savedSettings] = await Promise.all([
    getAllBooks(),
    getAllCoversMap(),
    getAllBookmarks(),
    getMeta('catalogInfo', null),
    getMeta('settings', null),
  ]);
  state.books = books;
  state.covers = covers;
  state.bookmarks = bookmarks;
  state.catalogInfo = catalogInfo;
  if (savedSettings) {
    state.settings = { ...state.settings, ...savedSettings };
  }
  applyTheme(state.settings.theme);

  const offlineCount = books.filter((b) => b.cached).length;
  $('brandSub').textContent =
    books.length > 0
      ? `已離線 ${offlineCount} / ${books.length} 本`
      : '離線電子書閱讀器';

  renderAll();
  kickCoverGenerator();
}

// ---- Background Cover Generator (1 book at a time for low RAM) ----

async function kickCoverGenerator() {
  if (state.coverQueueRunning || state.activeReader) return;
  const targets = state.books.filter((b) => b.cached && !state.covers.has(b.id));
  if (!targets.length) return;

  state.coverQueueRunning = true;
  try {
    for (const book of targets) {
      if (state.activeReader || state.importing) break;
      try {
        const res =
          book.format === 'epub'
            ? await generateEpubCover(book.id, book.cachedSize || book.size)
            : await generatePdfCover(book.id, book.cachedSize || book.size, 240);
        if (res.dataUrl) {
          await saveCover(book.id, res.dataUrl);
          state.covers.set(book.id, res.dataUrl);
          book.hasCover = true;
        }
        if (res.numPages && !book.totalPages) {
          book.totalPages = res.numPages;
        }
        await putBook(book);
        // Update visible cover smoothly if rendered
        document
          .querySelectorAll(`[data-cover-slot="${book.id}"]`)
          .forEach((slot) => {
            if (res.dataUrl) {
              slot.innerHTML = `<img src="${res.dataUrl}" alt="" loading="lazy" />`;
            }
          });
      } catch (err) {
        console.warn('[Cover gen skipped]', book.title, err);
        // Mark attempted in-memory so we don't retry broken files in loop
        state.covers.set(book.id, '');
      }
      await new Promise((r) => setTimeout(r, 60));
    }
  } finally {
    state.coverQueueRunning = false;
  }
}

// ---- Rendering Components ----

function renderCoverInner(book) {
  const dataUrl = state.covers.get(book.id);
  if (dataUrl) {
    return `<img src="${dataUrl}" alt="" loading="lazy" />`;
  }
  const [c1, c2] = paletteFor(book.category || book.title);
  return `
    <div class="cover-placeholder" style="--cover-a:${c1};--cover-b:${c2}">
      <span class="cover-cat-tag">${escapeHtml(book.category || '電子書')}</span>
      <span class="cover-title-text">${escapeHtml(book.title)}</span>
      <span class="cover-fmt-tag">${escapeHtml((book.format || 'pdf').toUpperCase())}</span>
    </div>`;
}

function renderBookCard(book) {
  const pct =
    book.totalPages > 0
      ? Math.min(100, Math.round((book.currentPage / book.totalPages) * 100))
      : 0;
  return `
    <button type="button" class="book-card" data-open-book="${book.id}">
      <div class="book-cover">
        <div data-cover-slot="${book.id}" style="width:100%;height:100%;">${renderCoverInner(book)}</div>
        <span class="book-badge ${book.cached ? 'offline' : 'cloud'}">${book.cached ? '離線' : '雲端'}</span>
        ${pct > 0 ? `<div class="book-progress-bar"><span style="width:${pct}%"></span></div>` : ''}
      </div>
      <div class="book-title">${escapeHtml(book.title)}</div>
      <div class="book-sub">${escapeHtml(book.category || '未分類')} · ${formatBytes(book.size)}</div>
    </button>`;
}

function renderBookRow(book) {
  const pct =
    book.totalPages > 0
      ? Math.min(100, Math.round((book.currentPage / book.totalPages) * 100))
      : 0;
  return `
    <button type="button" class="book-row" data-open-book="${book.id}">
      <div class="book-row-thumb" data-cover-slot="${book.id}">${renderCoverInner(book)}</div>
      <div class="book-row-info">
        <div class="book-row-title">${escapeHtml(book.title)}</div>
        <div class="book-row-meta">
          <span class="tag ${book.cached ? 'ok' : ''}">${book.cached ? '已離線' : '未匯入'}</span>
          <span>${escapeHtml(book.category || '未分類')}</span>
          <span>${formatBytes(book.size)}</span>
          ${pct > 0 ? `<span>進度 ${pct}%</span>` : ''}
          ${book.favorite ? '<span>★</span>' : ''}
        </div>
      </div>
    </button>`;
}

function renderReadingView() {
  const cachedBooks = state.books.filter((b) => b.cached);
  const readBooks = cachedBooks
    .filter((b) => b.lastReadAt > 0)
    .sort((a, b) => b.lastReadAt - a.lastReadAt);

  const heroSlot = $('readingHeroSlot');
  if (readBooks.length > 0) {
    const cur = readBooks[0];
    const pct =
      cur.totalPages > 0
        ? Math.min(100, Math.round((cur.currentPage / cur.totalPages) * 100))
        : 0;
    const unit = cur.format === 'epub' ? '章' : '頁';
    heroSlot.innerHTML = `
      <div class="hero-card">
        <div class="hero-cover" data-cover-slot="${cur.id}">${renderCoverInner(cur)}</div>
        <div class="hero-body">
          <div class="hero-eyebrow">繼續閱讀</div>
          <h2 class="hero-title">${escapeHtml(cur.title)}</h2>
          <div class="hero-cat">${escapeHtml(cur.category || '未分類')} · ${formatBytes(cur.size)}</div>
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
          <div class="hero-progress-row">
            <span>第 ${cur.currentPage} ${cur.totalPages ? `/ ${cur.totalPages}` : ''} ${unit}</span>
            <span>${pct}%</span>
          </div>
          <button type="button" class="btn btn-primary btn-sm" data-direct-read="${cur.id}">繼續閱讀 →</button>
        </div>
      </div>`;
  } else if (cachedBooks.length > 0) {
    const first = cachedBooks[0];
    heroSlot.innerHTML = `
      <div class="welcome-panel">
        <h2>已離線就緒 ${cachedBooks.length} 本書</h2>
        <p>所有已匯入的書籍都安全存在你的 iPhone 本機空間，郵輪無網路也能隨時開讀。</p>
        <div class="row-gap">
          <button type="button" class="btn btn-primary" data-direct-read="${first.id}">開始閱讀《${escapeHtml(first.title.slice(0, 14))}》</button>
          <button type="button" class="btn btn-secondary" id="btnGoLibraryFromHero">瀏覽書庫</button>
        </div>
      </div>`;
    heroSlot.querySelector('#btnGoLibraryFromHero')?.addEventListener('click', () => switchTab('library'));
  } else {
    heroSlot.innerHTML = `
      <div class="welcome-panel">
        <h2>歡迎登上航海書庫</h2>
        <p>專為郵輪離線航程打造的 iPhone 閱讀器。所有書籍與筆記皆儲存在本機，不上傳、不需連線。</p>
        <ol class="steps-list">
          <li><span class="step-num">1</span><span>在 Safari 點擊下方「分享」→「<strong>加入主畫面</strong>」，讓離線儲存空間更穩定。</span></li>
          <li><span class="step-num">2</span><span>從你的 Google 雲端硬碟或電腦下載分類 ZIP 書包（或個別 PDF / EPUB）到 iPhone「檔案」。</span></li>
          <li><span class="step-num">3</span><span>點下方「匯入書包」一次匯入，出發前切換飛航模式測試即可安心啟航！</span></li>
        </ol>
        <button type="button" class="btn btn-primary btn-block" id="btnGoImportFromWelcome">前往匯入書包</button>
      </div>`;
    heroSlot.querySelector('#btnGoImportFromWelcome')?.addEventListener('click', () => switchTab('import'));
  }

  // Recent books (excluding hero)
  const others = readBooks.slice(1, 7);
  if (others.length > 0) {
    $('recentSection').style.display = 'block';
    $('recentCountMeta').textContent = `${others.length} 本`;
    $('recentGrid').innerHTML = others.map(renderBookCard).join('');
  } else {
    $('recentSection').style.display = 'none';
  }

  // Offline ready shelf
  if (cachedBooks.length > 0) {
    $('offlineReadySection').style.display = 'block';
    const preview = cachedBooks
      .slice()
      .sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0))
      .slice(0, 12);
    $('offlineReadyGrid').innerHTML = preview.map(renderBookCard).join('');
  } else {
    $('offlineReadySection').style.display = 'none';
  }
}

function renderLibraryView() {
  // Build category list
  const catCounts = new Map();
  for (const b of state.books) {
    const cats = b.categories?.length ? b.categories : [b.category || '未分類'];
    for (const c of cats) catCounts.set(c, (catCounts.get(c) || 0) + 1);
  }
  const orderedCats = [];
  if (state.catalogInfo?.categories?.length) {
    for (const c of state.catalogInfo.categories) {
      if (catCounts.has(c.name)) orderedCats.push(c.name);
    }
  }
  for (const c of catCounts.keys()) {
    if (!orderedCats.includes(c)) orderedCats.push(c);
  }

  const pillsHtml = [
    `<button type="button" class="pill ${state.category === 'ALL' ? 'active' : ''}" data-cat="ALL">全部分類 (${state.books.length})</button>`,
    ...orderedCats.map(
      (c) =>
        `<button type="button" class="pill ${state.category === c ? 'active' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)} (${catCounts.get(c)})</button>`
    ),
  ].join('');
  $('categoryPills').innerHTML = pillsHtml;

  // Filter books
  const q = state.search.trim().toLowerCase();
  const filtered = state.books.filter((b) => {
    if (state.scope === 'offline' && !b.cached) return false;
    if (state.scope === 'favorite' && !b.favorite) return false;
    if (state.category !== 'ALL') {
      const cats = b.categories?.length ? b.categories : [b.category || '未分類'];
      if (!cats.includes(state.category)) return false;
    }
    if (q) {
      const hay = `${b.title} ${b.filename} ${b.category}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Sort: cached first, then title
  filtered.sort((a, b) => {
    if (!!b.cached !== !!a.cached) return b.cached ? 1 : -1;
    return a.title.localeCompare(b.title, 'zh-Hant');
  });

  $('libraryCountMeta').textContent = `${filtered.length} 本`;

  const container = $('libraryContent');
  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state">找不到符合條件的書籍。<br/>可以到「匯入」頁載入書包或書目檔。</div>`;
    return;
  }

  if (state.layout === 'list') {
    container.innerHTML = `<div class="book-list">${filtered.map(renderBookRow).join('')}</div>`;
  } else {
    container.innerHTML = `<div class="book-grid">${filtered.map(renderBookCard).join('')}</div>`;
  }
}

function renderImportView() {
  const packs = state.catalogInfo?.packs || [];
  if (packs.length > 0) {
    $('packChecklistPanel').style.display = 'block';
    let fullyDonePacks = 0;
    const html = packs
      .map((pk) => {
        const members = state.books.filter((b) => (b.packs || []).includes(pk.packName));
        const cachedN = members.filter((b) => b.cached).length;
        const totalN = pk.fileCount || members.length;
        const complete = totalN > 0 && cachedN >= totalN;
        if (complete) fullyDonePacks++;
        return `
          <div class="pack-item">
            <div class="pack-item-left">
              <div class="pack-name">${escapeHtml(pk.packName)}</div>
              <div class="pack-meta">${escapeHtml(pk.category)} · ${totalN} 本 · ${formatBytes(pk.totalBytes)}</div>
            </div>
            <span class="tag ${complete ? 'ok' : ''}">${complete ? `✓ 已就緒 ${cachedN}/${totalN}` : `${cachedN}/${totalN}`}</span>
          </div>`;
      })
      .join('');
    $('packChecklist').innerHTML = html;
    const totalCached = state.books.filter((b) => b.cached).length;
    $('packChecklistSummary').textContent = `已完成 ${fullyDonePacks} / ${packs.length} 個分類書包（共離線 ${totalCached} / ${state.books.length} 本書）。`;
  } else {
    $('packChecklistPanel').style.display = 'none';
  }

  refreshStorageMeter();
}

async function refreshStorageMeter() {
  const cachedBytes = state.books.reduce((s, b) => s + (b.cached ? b.cachedSize || b.size : 0), 0);
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      const usage = est.usage || cachedBytes;
      const quota = est.quota || 0;
      $('storageUsedText').textContent = `書庫佔用約 ${formatBytes(cachedBytes)}（站點總計 ${formatBytes(usage)}）`;
      $('storageQuotaText').textContent = quota ? `可用上限 ${formatBytes(quota)}` : '';
      const pct = quota ? Math.min(100, Math.round((usage / quota) * 100)) : 0;
      $('storageBar').style.width = `${pct}%`;
      return;
    } catch (_) {}
  }
  $('storageUsedText').textContent = `書庫已離線快取約 ${formatBytes(cachedBytes)}`;
  $('storageQuotaText').textContent = '';
}

function renderNotesView() {
  $('notesCountMeta').textContent = `${state.bookmarks.length} 則`;
  const list = $('notesList');
  if (state.bookmarks.length === 0) {
    list.innerHTML = `<div class="empty-state">目前還沒有書籤或筆記。<br/>閱讀書籍時點右上角書籤圖示即可隨時記錄重點。</div>`;
    return;
  }
  const bookMap = new Map(state.books.map((b) => [b.id, b]));
  list.innerHTML = state.bookmarks
    .map((bm) => {
      const bk = bookMap.get(bm.bookId);
      const unit = bk?.format === 'epub' ? '章' : '頁';
      const dateStr = new Date(bm.createdAt).toLocaleString('zh-TW', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      return `
        <div class="note-card">
          <div class="note-card-head">
            <div class="note-book">${escapeHtml(bk?.title || bm.bookTitle || '未知書籍')}</div>
            <div class="note-page">第 ${bm.page} ${unit}</div>
          </div>
          ${bm.note ? `<div class="note-text">${escapeHtml(bm.note)}</div>` : `<div class="note-text" style="color:var(--ink-muted)">（頁碼書籤）</div>`}
          <div class="note-actions">
            <span>${dateStr}</span>
            <div class="row-gap">
              <button type="button" class="btn btn-ghost btn-sm" data-jump-bm="${bm.id}">前往閱讀</button>
              <button type="button" class="btn btn-ghost btn-sm" style="color:var(--danger)" data-del-bm="${bm.id}">刪除</button>
            </div>
          </div>
        </div>`;
    })
    .join('');
}

function renderAll() {
  renderReadingView();
  renderLibraryView();
  renderImportView();
  renderNotesView();
}

// ---- Tab Switching ----

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const map = {
    reading: 'viewReading',
    library: 'viewLibrary',
    import: 'viewImport',
    notes: 'viewNotes',
  };
  $(map[tab])?.classList.add('active');
  if (tab === 'import') refreshStorageMeter();
}

// ---- Book Detail Sheet & Actions ----

function showBookDetailSheet(bookId) {
  const book = state.books.find((b) => b.id === bookId);
  if (!book) return;

  const packHint =
    book.packs?.length > 0
      ? `<div class="setting-group"><div class="setting-label"><span>所屬離線書包</span></div><div style="font-size:13.5px;font-family:var(--font-mono);background:var(--bg);padding:8px 10px;border-radius:8px;">${escapeHtml(book.packs.join(', '))}</div></div>`
      : '';

  const driveBtn =
    book.driveFileId && !book.cached
      ? `<a class="btn btn-secondary btn-block" href="https://drive.google.com/file/d/${encodeURIComponent(book.driveFileId)}/view" target="_blank" rel="noopener">在 Google 雲端硬碟開啟原檔</a>`
      : '';

  const pct =
    book.totalPages > 0
      ? Math.min(100, Math.round((book.currentPage / book.totalPages) * 100))
      : 0;

  openSheet(
    `
    <div style="display:flex;gap:14px;margin-bottom:16px;">
      <div class="hero-cover" style="width:74px;height:105px;">${renderCoverInner(book)}</div>
      <div style="flex:1;min-width:0;">
        <h3 style="margin:0 0 6px;font-family:var(--font-serif);font-size:17px;line-height:1.35;">${escapeHtml(book.title)}</h3>
        <div style="font-size:12.5px;color:var(--ink-secondary);margin-bottom:6px;">
          ${escapeHtml((book.categories || [book.category]).join(' · '))}
        </div>
        <div class="row-gap" style="gap:6px;">
          <span class="tag ${book.cached ? 'ok' : ''}">${book.cached ? '✓ 已離線快取' : '☁ 尚未匯入本機'}</span>
          <span class="tag">${escapeHtml((book.format || 'pdf').toUpperCase())}</span>
          <span class="tag">${formatBytes(book.size)}</span>
          ${book.totalPages ? `<span class="tag">${book.totalPages} ${book.format === 'epub' ? '章' : '頁'} (${pct}%)</span>` : ''}
        </div>
      </div>
    </div>
    ${packHint}
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${
        book.cached
          ? `<button type="button" class="btn btn-primary btn-block" id="sheetReadNow">立即閱讀</button>`
          : `<button type="button" class="btn btn-primary btn-block" id="sheetImportThis">從「檔案」匯入此書或對應書包</button>`
      }
      ${driveBtn}
      <div class="row-gap">
        <button type="button" class="btn btn-secondary" style="flex:1;" id="sheetToggleFav">${book.favorite ? '★ 已收藏' : '☆ 加入收藏'}</button>
        ${book.cached ? `<button type="button" class="btn btn-danger" style="flex:1;" id="sheetRemoveCache">移除離線快取</button>` : ''}
      </div>
    </div>`,
    (el) => {
      el.querySelector('#sheetReadNow')?.addEventListener('click', () => {
        closeSheet();
        openReader(book.id);
      });
      el.querySelector('#sheetImportThis')?.addEventListener('click', () => {
        closeSheet();
        switchTab('import');
        $('filePickerInput').click();
      });
      el.querySelector('#sheetToggleFav')?.addEventListener('click', async () => {
        book.favorite = !book.favorite;
        await putBook(book);
        showToast(book.favorite ? '已加入收藏' : '已取消收藏');
        renderAll();
        closeSheet();
      });
      el.querySelector('#sheetRemoveCache')?.addEventListener('click', async () => {
        if (!confirm(`確定要清除《${book.title}》的離線快取嗎？（閱讀進度與筆記會保留）`)) return;
        await removeBookCache(book.id);
        showToast('已清除離線快取，釋放本機空間');
        closeSheet();
        await reloadData();
      });
    }
  );
}

// ---- File & Zero-Copy ZIP Importer ----

function setImportUI(visible, title = '', pct = 0, sub = '') {
  const box = $('importProgressBox');
  box.style.display = visible ? 'block' : 'none';
  if (visible) {
    $('importProgressTitle').textContent = title;
    $('importProgressPct').textContent = `${Math.round(pct)}%`;
    $('importProgressBar').style.width = `${Math.min(100, Math.max(0, pct))}%`;
    $('importProgressSub').textContent = sub;
  }
}

async function importSingleBookBlob(meta, blob, onProgress) {
  const existing = await getAllBooks();
  let target =
    existing.find((b) => b.id === meta.id) ||
    existing.find((b) => b.filename === meta.filename && b.size === blob.size) ||
    existing.find((b) => b.filename === meta.filename);

  const fmt = meta.format || (meta.filename.toLowerCase().endsWith('.epub') ? 'epub' : 'pdf');
  const id = target ? target.id : meta.id || makeBookId(meta.filename, blob.size);

  const { chunkCount, cachedSize } = await saveBookBlobChunked(id, blob, onProgress);

  const record = {
    ...(target || {}),
    id,
    filename: meta.filename,
    title: target?.title || meta.title || cleanTitleFromFilename(meta.filename),
    format: fmt,
    mimeType: meta.mimeType || (fmt === 'epub' ? 'application/epub+zip' : 'application/pdf'),
    size: blob.size,
    category: target?.category || meta.category || '本機匯入',
    categories: target?.categories || [meta.category || '本機匯入'],
    driveFileId: target?.driveFileId || meta.driveFileId || null,
    packs: target?.packs || [],
    cached: 1,
    chunkCount,
    cachedSize,
    totalPages: target?.totalPages || 0,
    currentPage: target?.currentPage || 1,
    currentChapter: target?.currentChapter || 0,
    scrollRatio: target?.scrollRatio || 0,
    favorite: !!target?.favorite,
    lastReadAt: target?.lastReadAt || 0,
    importedAt: Date.now(),
    hasCover: !!target?.hasCover,
  };

  await putBook(record);
  return record;
}

async function handleImportedFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length || state.importing) return;

  state.importing = true;
  let importedBooks = 0;
  let importedCatalogs = 0;
  let errors = 0;

  try {
    // Request persistent storage automatically on first import
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }

    for (let fIdx = 0; fIdx < files.length; fIdx++) {
      const file = files[fIdx];
      const lower = file.name.toLowerCase();

      if (lower.endsWith('.json')) {
        setImportUI(true, `載入書目檔 (${fIdx + 1}/${files.length})`, 50, file.name);
        try {
          const obj = JSON.parse(await file.text());
          if (Array.isArray(obj.books)) {
            const n = await mergeCatalog(obj);
            importedCatalogs++;
            showToast(`已載入書目：共 ${n} 本書`);
          } else if (Array.isArray(obj.progress) || Array.isArray(obj.bookmarks)) {
            await importReadingBackup(obj);
            showToast('已還原閱讀進度與筆記備份');
          } else {
            throw new Error('無法辨識的 JSON 格式');
          }
        } catch (err) {
          errors++;
          showToast(`JSON 匯入失敗：${err.message}`);
        }
        continue;
      }

      if (lower.endsWith('.zip')) {
        setImportUI(true, `解析書包 ${file.name}`, 2, '讀取 ZIP 目錄（不佔記憶體）…');
        try {
          const entries = await listZipEntries(file);
          const manifestEntry = entries.find(
            (e) => !e.isDir && (e.name === '_pack_manifest.json' || e.name.endsWith('/_pack_manifest.json'))
          );

          let packMetaByPath = new Map();
          if (manifestEntry) {
            const raw = await extractZipEntryText(file, manifestEntry);
            const packMeta = JSON.parse(raw);
            if (packMeta.catalog && Array.isArray(packMeta.catalog.books)) {
              await mergeCatalog(packMeta.catalog);
              importedCatalogs++;
            }
            for (const item of packMeta.entries || []) {
              packMetaByPath.set(item.zipPath, item);
            }
          }

          const bookEntries = entries.filter(
            (e) =>
              !e.isDir &&
              !e.name.startsWith('__MACOSX/') &&
              (e.name.toLowerCase().endsWith('.pdf') || e.name.toLowerCase().endsWith('.epub'))
          );

          for (let i = 0; i < bookEntries.length; i++) {
            const entry = bookEntries[i];
            const pm = packMetaByPath.get(entry.name);
            const baseFilename = pm?.filename || entry.name.split('/').pop();
            const fmt = baseFilename.toLowerCase().endsWith('.epub') ? 'epub' : 'pdf';
            const mime = fmt === 'epub' ? 'application/epub+zip' : 'application/pdf';

            setImportUI(
              true,
              `匯入 ${file.name} (${i + 1}/${bookEntries.length})`,
              ((i) / Math.max(1, bookEntries.length)) * 100,
              `${pm?.title || baseFilename} (${formatBytes(entry.uncompSize)})`
            );

            // Zero-copy slice for STORED zip entries!
            const entryBlob = await extractZipEntryBlob(file, entry, mime);
            await importSingleBookBlob(
              {
                id: pm?.id,
                filename: baseFilename,
                title: pm?.title || cleanTitleFromFilename(baseFilename),
                format: fmt,
                mimeType: mime,
                category: pm?.category || (entry.name.includes('/') ? entry.name.split('/')[0] : 'ZIP 書包'),
                driveFileId: pm?.driveFileId,
              },
              entryBlob,
              (doneC, totC) => {
                const overall = ((i + doneC / Math.max(1, totC)) / Math.max(1, bookEntries.length)) * 100;
                setImportUI(
                  true,
                  `匯入 ${file.name} (${i + 1}/${bookEntries.length})`,
                  overall,
                  `${pm?.title || baseFilename} · 寫入區塊 ${doneC}/${totC}`
                );
              }
            );
            importedBooks++;
          }
        } catch (err) {
          console.error('[ZIP import error]', err);
          errors++;
          showToast(`書包匯入失敗：${err.message}`, 4000);
        }
        continue;
      }

      if (lower.endsWith('.pdf') || lower.endsWith('.epub')) {
        const fmt = lower.endsWith('.epub') ? 'epub' : 'pdf';
        setImportUI(
          true,
          `匯入檔案 (${fIdx + 1}/${files.length})`,
          (fIdx / files.length) * 100,
          `${file.name} (${formatBytes(file.size)})`
        );
        try {
          await importSingleBookBlob(
            {
              filename: file.name,
              title: cleanTitleFromFilename(file.name),
              format: fmt,
              mimeType: fmt === 'epub' ? 'application/epub+zip' : 'application/pdf',
              category: '本機匯入',
            },
            file,
            (doneC, totC) => {
              const pct = ((fIdx + doneC / Math.max(1, totC)) / files.length) * 100;
              setImportUI(true, `匯入檔案 (${fIdx + 1}/${files.length})`, pct, `${file.name} · 區塊 ${doneC}/${totC}`);
            }
          );
          importedBooks++;
        } catch (err) {
          console.error('[File import error]', err);
          errors++;
          showToast(`匯入失敗：${file.name}`, 3500);
        }
      }
    }

    setImportUI(true, '匯入完成！', 100, `成功匯入 ${importedBooks} 本離線電子書`);
    if (importedBooks > 0) {
      showToast(`已成功匯入 ${importedBooks} 本離線電子書！`, 3200);
    } else if (importedCatalogs > 0 && errors === 0) {
      showToast('書目更新完成！');
    }
    await reloadData();
    setTimeout(() => setImportUI(false), 3500);
  } finally {
    state.importing = false;
    $('filePickerInput').value = '';
  }
}

// ---- Reader Lifecycle ----

function setHudVisible(visible) {
  state.hudVisible = visible;
  $('readerOverlay').classList.toggle('hud-hidden', !visible);
}

async function openReader(bookId, jumpToPage = null) {
  const book = await getBook(bookId);
  if (!book) return;
  if (!book.cached) {
    showBookDetailSheet(bookId);
    return;
  }

  if (state.activeReader) {
    await state.activeReader.destroy();
    state.activeReader = null;
  }

  state.activeBook = book;
  state.activeOutline = [];
  if (jumpToPage !== null) {
    book.currentPage = jumpToPage;
  }
  book.lastReadAt = Date.now();
  await putBook(book);

  $('readerBookTitle').textContent = book.title;
  $('readerOverlay').classList.add('open');
  $('readerOverlay').setAttribute('aria-hidden', 'false');
  setHudVisible(false);
  showToast('整頁模式 · 點畫面中間顯示／隱藏上下欄', 2200);

  const isPdf = book.format !== 'epub';
  $('btnToggleCrop').style.display = isPdf ? 'flex' : 'none';
  $('btnToggleReflow').style.display = isPdf ? 'flex' : 'none';
  $('btnZoomCycle').style.display = isPdf ? 'flex' : 'none';

  $('btnToggleCrop').classList.toggle('active', !!state.settings.autoCrop);
  $('btnToggleReflow').classList.remove('active');
  $('reflowLabel').textContent = '文字重排';
  $('zoomLabel').textContent = '100%';

  let saveTimer = null;
  const scheduleProgressSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (!state.activeBook) return;
      state.activeBook.lastReadAt = Date.now();
      await putBook(state.activeBook);
    }, 400);
  };

  const onPageChange = (page, total) => {
    if (!state.activeBook) return;
    state.activeBook.currentPage = page;
    state.activeBook.totalPages = total;
    const unit = isPdf ? '頁' : '章';
    const pct = total > 0 ? Math.round((page / total) * 100) : 0;
    $('readerPageStatus').textContent = `第 ${page} / ${total} ${unit} · ${pct}%`;
    const scrubber = $('pageScrubber');
    scrubber.max = String(Math.max(1, total));
    scrubber.value = String(page);
    $('btnPrevPage').disabled = page <= 1;
    $('btnNextPage').disabled = page >= total;
    scheduleProgressSave();
  };

  const opts = {
    stageEl: $('readerStage'),
    autoCrop: state.settings.autoCrop,
    fontSize: state.settings.fontSize,
    lineHeight: state.settings.lineHeight,
    onPageChange,
    onToggleHud: () => setHudVisible(!state.hudVisible),
    onAutoHideHud: () => {
      if (state.hudVisible) setHudVisible(false);
    },
    onOutlineReady: (outline) => {
      state.activeOutline = outline || [];
    },
    onScrollSave: (ratio) => {
      if (!state.activeBook) return;
      state.activeBook.scrollRatio = ratio;
      scheduleProgressSave();
    },
  };

  try {
    state.activeReader = isPdf
      ? new PdfReaderController(opts)
      : new EpubReaderController(opts);
    await state.activeReader.open(book);
  } catch (err) {
    console.error('[Open reader error]', err);
    showToast(`開啟失敗：${err.message || err}`, 4000);
    await closeReader();
  }
}

async function closeReader() {
  if (state.activeBook) {
    state.activeBook.lastReadAt = Date.now();
    await putBook(state.activeBook);
  }
  if (state.activeReader) {
    await state.activeReader.destroy();
    state.activeReader = null;
  }
  state.activeBook = null;
  $('readerStage').innerHTML = '';
  $('readerOverlay').classList.remove('open');
  $('readerOverlay').setAttribute('aria-hidden', 'true');
  await reloadData();
}

// ---- Reader Bottom Sheets (Settings, TOC, Bookmark) ----

function openReaderSettingsSheet() {
  const isPdf = state.activeBook?.format !== 'epub';
  openSheet(
    `
    <h3 class="sheet-title"><span>閱讀外觀與排版</span></h3>
    <div class="setting-group">
      <div class="setting-label"><span>閱讀主題（夜間模式會自動柔化反色 PDF 頁面）</span></div>
      <div class="theme-swatches">
        <button type="button" class="swatch-btn swatch-day ${state.settings.theme === 'day' ? 'active' : ''}" data-set-theme="day">日間紙質</button>
        <button type="button" class="swatch-btn swatch-sepia ${state.settings.theme === 'sepia' ? 'active' : ''}" data-set-theme="sepia">護眼米黃</button>
        <button type="button" class="swatch-btn swatch-night ${state.settings.theme === 'night' ? 'active' : ''}" data-set-theme="night">郵輪夜讀</button>
      </div>
    </div>
    ${
      isPdf
        ? `
      <div class="setting-group">
        <div class="setting-label"><span>掃描版 PDF 清晰增強（文字加深）</span></div>
        <button type="button" class="btn ${state.settings.highContrast ? 'btn-primary' : 'btn-secondary'} btn-block" id="btnToggleContrast">
          ${state.settings.highContrast ? '✓ 已開啟清晰增強' : '開啟掃描頁對比度增強'}
        </button>
      </div>`
        : ''
    }
    <div class="setting-group">
      <div class="setting-label"><span>文字大小（EPUB / 文字重排模式）</span><span id="lblFontSize">${state.settings.fontSize} px</span></div>
      <input type="range" id="rngFontSize" min="14" max="26" step="1" value="${state.settings.fontSize}" style="width:100%;accent-color:var(--accent);" />
    </div>
    <div class="setting-group">
      <div class="setting-label"><span>行距</span><span id="lblLineHeight">${state.settings.lineHeight}</span></div>
      <input type="range" id="rngLineHeight" min="1.4" max="2.2" step="0.1" value="${state.settings.lineHeight}" style="width:100%;accent-color:var(--accent);" />
    </div>`,
    (el) => {
      el.querySelectorAll('[data-set-theme]').forEach((btn) => {
        btn.addEventListener('click', () => {
          applyTheme(btn.dataset.setTheme);
          el.querySelectorAll('[data-set-theme]').forEach((b) =>
            b.classList.toggle('active', b === btn)
          );
        });
      });
      el.querySelector('#btnToggleContrast')?.addEventListener('click', (e) => {
        state.settings.highContrast = !state.settings.highContrast;
        applyTheme(state.settings.theme);
        e.currentTarget.className = `btn ${state.settings.highContrast ? 'btn-primary' : 'btn-secondary'} btn-block`;
        e.currentTarget.textContent = state.settings.highContrast
          ? '✓ 已開啟清晰增強'
          : '開啟掃描頁對比度增強';
      });
      el.querySelector('#rngFontSize')?.addEventListener('input', (e) => {
        state.settings.fontSize = Number(e.target.value);
        el.querySelector('#lblFontSize').textContent = `${state.settings.fontSize} px`;
        state.activeReader?.setTypography?.(state.settings.fontSize, state.settings.lineHeight);
        setMeta('settings', state.settings).catch(() => {});
      });
      el.querySelector('#rngLineHeight')?.addEventListener('input', (e) => {
        state.settings.lineHeight = Number(e.target.value);
        el.querySelector('#lblLineHeight').textContent = String(state.settings.lineHeight);
        state.activeReader?.setTypography?.(state.settings.fontSize, state.settings.lineHeight);
        setMeta('settings', state.settings).catch(() => {});
      });
    }
  );
}

async function openTocSheet() {
  if (!state.activeBook) return;
  const bookBms = await getBookmarksForBook(state.activeBook.id);
  const unit = state.activeBook.format === 'epub' ? '章' : '頁';

  const tocHtml =
    state.activeOutline.length > 0
      ? state.activeOutline
          .map(
            (item) => `
            <button type="button" class="toc-item" data-toc-page="${item.page || 1}" style="padding-left:${10 + (item.level || 0) * 14}px;">
              <span>${escapeHtml(item.title)}</span>
              <span style="font-size:12px;color:var(--ink-muted);flex-shrink:0;">${item.page ? `P.${item.page}` : ''}</span>
            </button>`
          )
          .join('')
      : `<div class="empty-state" style="padding:18px 0;">此書未內嵌電子目錄（可直接拖動下方進度條或使用跳頁功能）</div>`;

  const bmHtml =
    bookBms.length > 0
      ? bookBms
          .map(
            (bm) => `
            <button type="button" class="toc-item" data-toc-page="${bm.page}">
              <span>${escapeHtml(bm.note || `第 ${bm.page} ${unit} 書籤`)}</span>
              <span style="font-size:12px;color:var(--accent);flex-shrink:0;">第 ${bm.page} ${unit}</span>
            </button>`
          )
          .join('')
      : `<div style="font-size:13px;color:var(--ink-muted);padding:8px 0;">本書尚無書籤</div>`;

  openSheet(
    `
    <h3 class="sheet-title"><span>目錄與本書書籤</span></h3>
    <div class="setting-group">
      <div class="setting-label"><span>本書書籤 (${bookBms.length})</span></div>
      <div class="toc-list">${bmHtml}</div>
    </div>
    <div class="setting-group">
      <div class="setting-label"><span>章節目錄 (${state.activeOutline.length})</span></div>
      <div class="toc-list">${tocHtml}</div>
    </div>`,
    (el) => {
      el.querySelectorAll('[data-toc-page]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const p = Number(btn.dataset.tocPage);
          closeSheet();
          state.activeReader?.goToPage(p);
        });
      });
    }
  );
}

function openAddBookmarkSheet() {
  if (!state.activeBook) return;
  const page = state.activeBook.currentPage || 1;
  const unit = state.activeBook.format === 'epub' ? '章' : '頁';
  openSheet(
    `
    <h3 class="sheet-title"><span>新增第 ${page} ${unit} 書籤與筆記</span></h3>
    <textarea class="textarea" id="bmNoteInput" placeholder="輸入閱讀心得或重點摘錄（留空則僅存頁碼書籤）…"></textarea>
    <div class="row-gap">
      <button type="button" class="btn btn-secondary" style="flex:1;" id="btnCancelBm">取消</button>
      <button type="button" class="btn btn-primary" style="flex:2;" id="btnSaveBm">儲存書籤</button>
    </div>`,
    (el) => {
      el.querySelector('#btnCancelBm').addEventListener('click', closeSheet);
      el.querySelector('#btnSaveBm').addEventListener('click', async () => {
        const note = el.querySelector('#bmNoteInput').value.trim();
        await saveBookmark({
          id: `bm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          bookId: state.activeBook.id,
          bookTitle: state.activeBook.title,
          page,
          note,
          createdAt: Date.now(),
        });
        state.bookmarks = await getAllBookmarks();
        renderNotesView();
        showToast(`已儲存第 ${page} ${unit} 書籤`);
        closeSheet();
      });
    }
  );
}

// ---- Offline Readiness Self-Test ----

async function runOfflineSelfTest() {
  const results = [];

  // 1. Service Worker check
  let swOk = false;
  let swDetail = '尚未啟用（需透過 HTTPS 開啟）';
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (reg && reg.active) {
        const msg = await new Promise((resolve) => {
          const ch = new MessageChannel();
          ch.port1.onmessage = (e) => resolve(e.data);
          reg.active.postMessage({ type: 'CHECK_OFFLINE' }, [ch.port2]);
          setTimeout(() => resolve(null), 2000);
        });
        if (msg?.ok) {
          swOk = true;
          swDetail = `已快取 ${msg.cachedCount} 個核心離線檔案（含 PDF.js 與中文字型表）`;
        } else {
          swOk = true;
          swDetail = 'Service Worker 已啟動';
        }
      }
    } catch (e) {
      swDetail = e.message;
    }
  }
  results.push({ label: '離線 App 外殼 (Service Worker)', ok: swOk, detail: swDetail });

  // 2. IndexedDB Vault check
  let dbOk = false;
  let dbDetail = '';
  try {
    const books = await getAllBooks();
    const cached = books.filter((b) => b.cached);
    dbOk = cached.length > 0;
    dbDetail =
      cached.length > 0
        ? `已就緒 ${cached.length} 本離線書（共 ${formatBytes(cached.reduce((s, b) => s + (b.cachedSize || b.size), 0))}）`
        : '尚未匯入任何書籍到本機';
  } catch (e) {
    dbDetail = e.message;
  }
  results.push({ label: '本機書庫 (IndexedDB)', ok: dbOk, detail: dbDetail });

  // 3. Persistent storage
  let persistOk = false;
  let persistDetail = '一般模式';
  if (navigator.storage && navigator.storage.persisted) {
    persistOk = await navigator.storage.persisted();
    persistDetail = persistOk ? '已鎖定永久儲存' : '建議點「鎖定本機儲存」並加入主畫面';
  }
  results.push({ label: '防系統清除保護', ok: persistOk, detail: persistDetail });

  // 4. Standalone PWA mode on iPhone
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
  results.push({
    label: 'iPhone 主畫面獨立 App',
    ok: isStandalone,
    detail: isStandalone ? '已透過主畫面獨立開啟' : '建議在 Safari 分享 → 加入主畫面',
  });

  $('offlineCheckResults').innerHTML = results
    .map(
      (r) => `
      <div class="check-row">
        <div>
          <div style="font-weight:600;">${escapeHtml(r.label)}</div>
          <div style="font-size:12px;color:var(--ink-muted);">${escapeHtml(r.detail)}</div>
        </div>
        <span class="tag ${r.ok ? 'ok' : ''}">${r.ok ? '✓ 正常' : '注意'}</span>
      </div>`
    )
    .join('');
}

// ---- Event Bindings ----

function bindEvents() {
  // Bottom Tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Theme cycle button in topbar
  $('btnCycleTheme').addEventListener('click', () => {
    const order = ['day', 'sepia', 'night'];
    const next = order[(order.indexOf(state.settings.theme) + 1) % order.length];
    applyTheme(next);
    const names = { day: '日間紙質', sepia: '護眼米黃', night: '郵輪夜讀' };
    showToast(`已切換：${names[next]}`);
  });

  // Delegated book clicks
  document.addEventListener('click', (e) => {
    const direct = e.target.closest('[data-direct-read]');
    if (direct) {
      openReader(direct.dataset.directRead);
      return;
    }
    const card = e.target.closest('[data-open-book]');
    if (card) {
      const id = card.dataset.openBook;
      const bk = state.books.find((b) => b.id === id);
      if (bk && bk.cached) {
        // In Reading tab open immediately; in Library tab open detail sheet if not cached, else open directly!
        openReader(id);
      } else {
        showBookDetailSheet(id);
      }
      return;
    }
    const jumpBm = e.target.closest('[data-jump-bm]');
    if (jumpBm) {
      const bm = state.bookmarks.find((x) => x.id === jumpBm.dataset.jumpBm);
      if (bm) openReader(bm.bookId, bm.page);
      return;
    }
    const delBm = e.target.closest('[data-del-bm]');
    if (delBm) {
      const id = delBm.dataset.delBm;
      deleteBookmark(id).then(async () => {
        state.bookmarks = await getAllBookmarks();
        renderNotesView();
        showToast('已刪除書籤');
      });
    }
  });

  // Long-press / contextmenu on cached book card opens management detail sheet
  document.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('[data-open-book]');
    if (card) {
      e.preventDefault();
      showBookDetailSheet(card.dataset.openBook);
    }
  });

  $('btnSeeAllOffline').addEventListener('click', () => {
    state.scope = 'offline';
    document.querySelectorAll('#scopeSegmented button').forEach((b) =>
      b.classList.toggle('active', b.dataset.scope === 'offline')
    );
    switchTab('library');
    renderLibraryView();
  });

  // Library search & filters
  $('searchInput').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderLibraryView();
  });

  $('scopeSegmented').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-scope]');
    if (!btn) return;
    state.scope = btn.dataset.scope;
    $('scopeSegmented').querySelectorAll('button').forEach((b) =>
      b.classList.toggle('active', b === btn)
    );
    renderLibraryView();
  });

  $('categoryPills').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cat]');
    if (!btn) return;
    state.category = btn.dataset.cat;
    renderLibraryView();
  });

  $('btnToggleLayout').addEventListener('click', () => {
    state.layout = state.layout === 'grid' ? 'list' : 'grid';
    renderLibraryView();
  });

  // Import file picker & drag-drop
  $('btnPickFiles').addEventListener('click', () => $('filePickerInput').click());
  $('filePickerInput').addEventListener('change', (e) => handleImportedFiles(e.target.files));

  const dz = $('importDropzone');
  dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('dragover');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('dragover');
    handleImportedFiles(e.dataTransfer.files);
  });

  // Offline self-test & persist storage
  $('btnRunOfflineCheck').addEventListener('click', runOfflineSelfTest);
  $('btnPersistStorage').addEventListener('click', async () => {
    if (!navigator.storage || !navigator.storage.persist) {
      showToast('此瀏覽器不支援儲存鎖定 API，建議加入主畫面即可');
      return;
    }
    const granted = await navigator.storage.persist();
    showToast(granted ? '已鎖定永久本機儲存！' : '請先將本頁「加入主畫面」再鎖定');
    runOfflineSelfTest();
  });

  // Backup export & import
  $('btnExportBackup').addEventListener('click', async () => {
    const data = await exportReadingBackup();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `voyage-reader-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('已匯出閱讀進度與筆記備份');
  });

  $('btnImportBackup').addEventListener('click', () => $('backupPickerInput').click());
  $('backupPickerInput').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      await importReadingBackup(JSON.parse(await f.text()));
      showToast('已還原閱讀進度與筆記！');
      await reloadData();
    } catch (err) {
      showToast(`還原失敗：${err.message}`);
    } finally {
      e.target.value = '';
    }
  });

  // Reader controls
  $('btnCloseReader').addEventListener('click', closeReader);
  $('btnPrevPage').addEventListener('click', () => state.activeReader?.prevPage());
  $('btnNextPage').addEventListener('click', () => state.activeReader?.nextPage());

  let scrubTimer = null;
  $('pageScrubber').addEventListener('input', (e) => {
    const p = Number(e.target.value);
    const total = state.activeBook?.totalPages || 1;
    const unit = state.activeBook?.format === 'epub' ? '章' : '頁';
    $('readerPageStatus').textContent = `第 ${p} / ${total} ${unit} · ${Math.round((p / total) * 100)}%`;
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(() => state.activeReader?.goToPage(p), 90);
  });

  $('btnToggleCrop').addEventListener('click', () => {
    state.settings.autoCrop = !state.settings.autoCrop;
    $('btnToggleCrop').classList.toggle('active', state.settings.autoCrop);
    state.activeReader?.setAutoCrop?.(state.settings.autoCrop);
    setMeta('settings', state.settings).catch(() => {});
    showToast(state.settings.autoCrop ? '已開啟智慧切白邊' : '已關閉切白邊（完整原頁）');
  });

  $('btnToggleReflow').addEventListener('click', () => {
    if (!state.activeReader?.setMode) return;
    const next = state.activeReader.mode === 'reflow' ? 'page' : 'reflow';
    state.activeReader.setMode(next);
    $('btnToggleReflow').classList.toggle('active', next === 'reflow');
    $('reflowLabel').textContent = next === 'reflow' ? '原版頁面' : '文字重排';
  });

  document.addEventListener('reader-mode-synced', (e) => {
    const isReflow = e.detail?.mode === 'reflow';
    $('btnToggleReflow').classList.toggle('active', isReflow);
    $('reflowLabel').textContent = isReflow ? '原版頁面' : '文字重排';
  });

  $('btnZoomCycle').addEventListener('click', () => {
    if (!state.activeReader?.setZoom) return;
    const steps = [1, 1.35, 1.7, 2.1];
    const cur = state.activeReader.zoom || 1;
    const next = steps.find((s) => s > cur + 0.05) || 1;
    state.activeReader.setZoom(next);
    $('zoomLabel').textContent = `${Math.round(next * 100)}%`;
  });

  $('btnJumpPage').addEventListener('click', () => {
    if (!state.activeBook) return;
    const total = state.activeBook.totalPages || 1;
    const unit = state.activeBook.format === 'epub' ? '章' : '頁';
    const raw = prompt(`輸入要跳轉的${unit}碼 (1 ~ ${total})：`, String(state.activeBook.currentPage || 1));
    if (raw === null) return;
    const num = parseInt(raw, 10);
    if (!Number.isNaN(num) && num >= 1) {
      state.activeReader?.goToPage(num);
    }
  });

  $('btnReaderSettings').addEventListener('click', openReaderSettingsSheet);
  $('btnOpenToc').addEventListener('click', openTocSheet);
  $('btnBookmarkPage').addEventListener('click', openAddBookmarkSheet);
  $('btnHideHud')?.addEventListener('click', () => setHudVisible(false));

  // Sheet backdrop dismiss
  $('sheetBackdrop').addEventListener('click', (e) => {
    if (e.target === $('sheetBackdrop')) closeSheet();
  });

  // Keyboard shortcuts for desktop/iPad keyboard
  document.addEventListener('keydown', (e) => {
    if (!$('readerOverlay').classList.contains('open')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowRight' || e.key === ' ') {
      e.preventDefault();
      state.activeReader?.nextPage();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      state.activeReader?.prevPage();
    } else if (e.key === 'Escape') {
      closeReader();
    }
  });

  window.addEventListener('online', updateOnlineBadge);
  window.addEventListener('offline', updateOnlineBadge);
}

// ---- Boot ----

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch (err) {
    console.warn('[SW registration skipped]', err);
  }
}

async function init() {
  updateOnlineBadge();
  bindEvents();
  registerServiceWorker();
  await reloadData();
}

init();
