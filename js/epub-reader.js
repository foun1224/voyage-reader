/**
 * Full Offline EPUB Reader Engine (Zero external dependencies)
 * Uses zip-reader.js to parse EPUB2/EPUB3 container.xml -> OPF spine -> TOC
 * and renders chapters with resolved inline images & saved scroll progress.
 */

import { ChunkedByteReader } from './db.js';
import {
  listZipEntries,
  extractZipEntryText,
  extractZipEntryBlob,
} from './zip-reader.js';

function resolvePath(baseDir, relPath) {
  const cleanRel = decodeURIComponent(relPath.split('#')[0]);
  if (!baseDir) return cleanRel.replace(/^\/+/, '');
  const stack = baseDir.split('/').filter(Boolean);
  for (const part of cleanRel.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function guessMime(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    css: 'text/css',
  };
  return map[ext] || 'application/octet-stream';
}

async function parseEpubArchive(blob) {
  const entries = await listZipEntries(blob);
  const byPath = new Map(entries.map((e) => [e.name, e]));

  const containerEntry = byPath.get('META-INF/container.xml');
  if (!containerEntry) throw new Error('EPUB 缺少 META-INF/container.xml');
  const containerXml = await extractZipEntryText(blob, containerEntry);
  const parser = new DOMParser();
  const containerDoc = parser.parseFromString(containerXml, 'application/xml');
  const rootfile = containerDoc.querySelector('rootfile');
  const opfPath = rootfile?.getAttribute('full-path');
  if (!opfPath || !byPath.has(opfPath)) throw new Error('找不到 EPUB OPF 封裝檔');

  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const opfXml = await extractZipEntryText(blob, byPath.get(opfPath));
  const opfDoc = parser.parseFromString(opfXml, 'application/xml');

  const manifestMap = new Map();
  let navHref = null;
  let ncxId = null;
  let coverHref = null;
  let coverMetaId = null;

  for (const meta of opfDoc.querySelectorAll('metadata meta')) {
    if (meta.getAttribute('name') === 'cover') {
      coverMetaId = meta.getAttribute('content');
    }
  }

  for (const item of opfDoc.querySelectorAll('manifest item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    const mediaType = item.getAttribute('media-type') || '';
    const props = item.getAttribute('properties') || '';
    if (!id || !href) continue;
    const fullPath = resolvePath(opfDir, href);
    manifestMap.set(id, { id, href, fullPath, mediaType, props });
    if (props.split(/\s+/).includes('nav')) navHref = fullPath;
    if (props.split(/\s+/).includes('cover-image')) coverHref = fullPath;
    if (mediaType === 'application/x-dtbncx+xml') ncxId = id;
  }

  if (!coverHref && coverMetaId && manifestMap.has(coverMetaId)) {
    coverHref = manifestMap.get(coverMetaId).fullPath;
  }

  const spineEl = opfDoc.querySelector('spine');
  if (!ncxId && spineEl?.getAttribute('toc')) {
    ncxId = spineEl.getAttribute('toc');
  }

  const spine = [];
  for (const ref of opfDoc.querySelectorAll('spine itemref')) {
    const idref = ref.getAttribute('idref');
    const m = manifestMap.get(idref);
    if (m && byPath.has(m.fullPath)) {
      spine.push(m);
    }
  }

  // Parse TOC (EPUB3 nav or EPUB2 ncx)
  const toc = [];
  const spineIndexByPath = new Map(spine.map((s, idx) => [s.fullPath, idx]));

  if (navHref && byPath.has(navHref)) {
    try {
      const navDir = navHref.includes('/') ? navHref.slice(0, navHref.lastIndexOf('/')) : '';
      const navHtml = await extractZipEntryText(blob, byPath.get(navHref));
      const navDoc = parser.parseFromString(navHtml, 'text/html');
      const tocNav =
        navDoc.querySelector('nav[epub\\:type="toc"], nav[role="doc-toc"], nav') || navDoc;
      for (const a of tocNav.querySelectorAll('a[href]')) {
        const targetPath = resolvePath(navDir, a.getAttribute('href'));
        const idx = spineIndexByPath.get(targetPath);
        if (idx !== undefined) {
          toc.push({ title: a.textContent.trim() || `第 ${idx + 1} 章`, page: idx + 1, level: 0 });
        }
      }
    } catch (_) {}
  } else if (ncxId && manifestMap.has(ncxId)) {
    try {
      const ncxPath = manifestMap.get(ncxId).fullPath;
      const ncxDir = ncxPath.includes('/') ? ncxPath.slice(0, ncxPath.lastIndexOf('/')) : '';
      const ncxXml = await extractZipEntryText(blob, byPath.get(ncxPath));
      const ncxDoc = parser.parseFromString(ncxXml, 'application/xml');
      for (const np of ncxDoc.querySelectorAll('navPoint')) {
        const label = np.querySelector('navLabel text')?.textContent?.trim();
        const src = np.querySelector('content')?.getAttribute('src');
        if (src) {
          const targetPath = resolvePath(ncxDir, src);
          const idx = spineIndexByPath.get(targetPath);
          if (idx !== undefined) {
            toc.push({ title: label || `第 ${idx + 1} 章`, page: idx + 1, level: 0 });
          }
        }
      }
    } catch (_) {}
  }

  if (toc.length === 0) {
    spine.forEach((s, idx) => {
      toc.push({ title: `章節 ${idx + 1}`, page: idx + 1, level: 0 });
    });
  }

  return { blob, byPath, spine, toc, coverHref };
}

export async function generateEpubCover(bookId, fileSize) {
  const reader = new ChunkedByteReader(bookId, fileSize, 4);
  try {
    const blob = await reader.toBlob('application/epub+zip');
    const epub = await parseEpubArchive(blob);
    const numPages = epub.spine.length || 1;
    if (!epub.coverHref || !epub.byPath.has(epub.coverHref)) {
      return { dataUrl: null, numPages };
    }
    const imgBlob = await extractZipEntryBlob(
      blob,
      epub.byPath.get(epub.coverHref),
      guessMime(epub.coverHref)
    );
    const dataUrl = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(imgBlob);
    });
    return { dataUrl, numPages };
  } finally {
    reader.destroy();
  }
}

export class EpubReaderController {
  constructor(opts) {
    this.stageEl = opts.stageEl;
    this.onPageChange = opts.onPageChange;
    this.onToggleHud = opts.onToggleHud;
    this.onOutlineReady = opts.onOutlineReady;
    this.onScrollSave = opts.onScrollSave;

    this.epub = null;
    this.currentChapter = 1; // 1-indexed to align with page slider UI
    this.numChapters = 1;
    this.fontSize = opts.fontSize || 18;
    this.lineHeight = opts.lineHeight || 1.75;
    this.objectUrls = [];
    this.destroyed = false;

    this._onClick = (e) => {
      if (e.target.closest('a, button, input, textarea')) return;
      this.onToggleHud?.();
    };
    this._onScroll = () => {
      const max = Math.max(1, this.stageEl.scrollHeight - this.stageEl.clientHeight);
      const ratio = this.stageEl.scrollTop / max;
      this.onScrollSave?.(ratio);
    };
    this.stageEl.addEventListener('click', this._onClick);
    this.stageEl.addEventListener('scroll', this._onScroll, { passive: true });
  }

  async open(book) {
    this.stageEl.innerHTML = `<div class="reader-loading"><div class="spinner"></div><span>正在解析 EPUB 電子書…</span></div>`;
    const byteReader = new ChunkedByteReader(book.id, book.cachedSize || book.size, 4);
    try {
      const blob = await byteReader.toBlob('application/epub+zip');
      this.epub = await parseEpubArchive(blob);
    } finally {
      byteReader.destroy();
    }

    this.numChapters = Math.max(1, this.epub.spine.length);
    this.currentChapter = Math.max(1, Math.min(this.numChapters, book.currentPage || 1));
    this.onOutlineReady?.(this.epub.toc);
    await this.renderChapter(this.currentChapter, book.scrollRatio || 0);
  }

  setTypography(fontSize, lineHeight) {
    this.fontSize = fontSize;
    this.lineHeight = lineHeight;
    const article = this.stageEl.querySelector('.epub-article');
    if (article) {
      article.style.fontSize = `${this.fontSize}px`;
      article.style.lineHeight = String(this.lineHeight);
    }
  }

  async goToPage(chNum) {
    const target = Math.max(1, Math.min(this.numChapters, Math.round(chNum)));
    await this.renderChapter(target, 0);
  }

  prevPage() {
    if (this.currentChapter > 1) this.goToPage(this.currentChapter - 1);
  }

  nextPage() {
    if (this.currentChapter < this.numChapters) this.goToPage(this.currentChapter + 1);
  }

  _revokeUrls() {
    for (const u of this.objectUrls) URL.revokeObjectURL(u);
    this.objectUrls = [];
  }

  async renderChapter(chNum, restoreScrollRatio = 0) {
    if (!this.epub || this.destroyed) return;
    this._revokeUrls();
    this.currentChapter = chNum;
    this.onPageChange?.(this.currentChapter, this.numChapters);

    const item = this.epub.spine[chNum - 1];
    if (!item) return;

    const chPath = item.fullPath;
    const chDir = chPath.includes('/') ? chPath.slice(0, chPath.lastIndexOf('/')) : '';
    const rawHtml = await extractZipEntryText(this.epub.blob, this.epub.byPath.get(chPath));

    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, 'text/html');

    // Sanitize scripts/iframes/inline fixed colors
    doc.querySelectorAll('script, iframe, object, embed, style, link').forEach((n) => n.remove());

    // Resolve embedded images to local Blob URLs
    const imgs = [...doc.querySelectorAll('img, image')];
    for (const img of imgs) {
      const attr = img.tagName.toLowerCase() === 'image' ? 'xlink:href' : 'src';
      const rawSrc = img.getAttribute(attr) || img.getAttribute('href') || img.getAttribute('src');
      if (!rawSrc || rawSrc.startsWith('data:') || rawSrc.startsWith('http')) continue;
      const target = resolvePath(chDir, rawSrc);
      const entry = this.epub.byPath.get(target);
      if (entry) {
        try {
          const imgBlob = await extractZipEntryBlob(this.epub.blob, entry, guessMime(target));
          const url = URL.createObjectURL(imgBlob);
          this.objectUrls.push(url);
          img.setAttribute(img.tagName.toLowerCase() === 'image' ? 'href' : 'src', url);
        } catch (_) {}
      }
    }

    // Intercept internal chapter links
    const spineIndexByPath = new Map(this.epub.spine.map((s, idx) => [s.fullPath, idx + 1]));
    doc.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (!href || href.startsWith('http') || href.startsWith('mailto:')) {
        a.removeAttribute('href');
        return;
      }
      const target = resolvePath(chDir, href);
      const targetCh = spineIndexByPath.get(target);
      if (targetCh) {
        a.dataset.chapter = String(targetCh);
        a.setAttribute('href', '#');
      } else {
        a.removeAttribute('href');
      }
    });

    const article = document.createElement('article');
    article.className = 'epub-article';
    article.style.fontSize = `${this.fontSize}px`;
    article.style.lineHeight = String(this.lineHeight);
    article.innerHTML = doc.body ? doc.body.innerHTML : rawHtml;

    // Chapter footer nav buttons
    const navFooter = document.createElement('div');
    navFooter.className = 'epub-chapter-nav';
    navFooter.innerHTML = `
      <button type="button" class="btn btn-secondary" ${chNum <= 1 ? 'disabled' : ''} data-nav="prev">← 上一章</button>
      <span class="epub-ch-label">第 ${chNum} / ${this.numChapters} 章</span>
      <button type="button" class="btn btn-primary" ${chNum >= this.numChapters ? 'disabled' : ''} data-nav="next">下一章 →</button>
    `;
    navFooter.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-nav]');
      if (!btn) return;
      e.stopPropagation();
      if (btn.dataset.nav === 'prev') this.prevPage();
      else this.nextPage();
    });
    article.appendChild(navFooter);

    article.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-chapter]');
      if (a) {
        e.preventDefault();
        e.stopPropagation();
        this.goToPage(Number(a.dataset.chapter));
      }
    });

    this.stageEl.innerHTML = '';
    this.stageEl.appendChild(article);

    requestAnimationFrame(() => {
      const max = Math.max(0, this.stageEl.scrollHeight - this.stageEl.clientHeight);
      this.stageEl.scrollTop = Math.round(max * restoreScrollRatio);
    });
  }

  async destroy() {
    this.destroyed = true;
    this._revokeUrls();
    this.stageEl.removeEventListener('click', this._onClick);
    this.stageEl.removeEventListener('scroll', this._onScroll);
    this.epub = null;
  }
}
