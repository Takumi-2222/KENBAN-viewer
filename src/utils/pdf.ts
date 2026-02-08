import * as pdfjs from 'pdfjs-dist';
import { jsPDF } from 'jspdf';
import { PDFDocument } from 'pdf-lib';

// PDF.js Worker設定
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

// ============== PDF最適化処理（MojiQから移植） ==============
// pdf-lib最適化: 未参照リソースを削除してメモリ使用量を削減
// ページめくり速度にも影響（5-30%改善）
// MojiQと同様に500MB未満の全PDFに最適化を適用（閾値なし）
const PDF_COMPRESS_THRESHOLD = 500 * 1024 * 1024; // 500MB以上でCanvas圧縮
const PDF_AUTO_OPTIMIZE_ENABLED = true; // MojiQと同様に有効化
const PDF_SIZE_WARNING_THRESHOLD = 100 * 1024 * 1024; // 100MB以上で警告

// PDFファイルサイズチェック（100MB以上で拒否）
export const checkPdfFileSize = (file: File): boolean => {
  if (file.size > PDF_SIZE_WARNING_THRESHOLD) {
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    alert(`このPDFファイルは ${sizeMB}MB で、100MBを超えています。\n別のファイルを選択するか、圧縮処理をしてください。`);
    return false;
  }
  return true;
};

// フレーム待機（UIブロック回避）
export const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

/**
 * pdf-libによる軽量PDF最適化
 * ページをコピーすることで不要なリソースを削除し、ファイルサイズを削減
 */
async function optimizePdfResources(
  arrayBuffer: ArrayBuffer,
  onProgress?: (message: string, current?: number, total?: number) => void
): Promise<ArrayBuffer> {
  // UIが更新される時間を確保
  if (onProgress) onProgress('PDFを解析しています...');
  await nextFrame();
  await new Promise(resolve => setTimeout(resolve, 50)); // UI更新待ち

  // 元のPDFを読み込み
  const srcPdf = await PDFDocument.load(arrayBuffer, {
    ignoreEncryption: true
  });

  const pageCount = srcPdf.getPageCount();
  if (onProgress) onProgress('PDFを最適化しています...', 0, pageCount);
  await nextFrame();

  // 新しいPDFドキュメントを作成
  const pdfDoc = await PDFDocument.create();

  // 全ページをコピー（これにより参照されていないリソースは含まれない）
  const pageIndices = Array.from({ length: pageCount }, (_, i) => i);
  const copiedPages = await pdfDoc.copyPages(srcPdf, pageIndices);

  for (let i = 0; i < copiedPages.length; i++) {
    pdfDoc.addPage(copiedPages[i]);

    // 進捗を報告（毎ページ）
    if (onProgress) onProgress('PDFを最適化しています...', i + 1, pageCount);
    await nextFrame();
  }

  if (onProgress) onProgress('最適化されたPDFを生成しています...', pageCount, pageCount);
  await nextFrame();

  // 最適化されたPDFを出力（useObjectStreams: falseで高速化）
  const optimizedBytes = await pdfDoc.save({ useObjectStreams: false });

  if (onProgress) onProgress('最適化完了', pageCount, pageCount);

  return optimizedBytes.buffer as ArrayBuffer;
}

async function compressPdfViaCanvas(
  arrayBuffer: ArrayBuffer,
  onProgress?: (current: number, total: number) => void
): Promise<ArrayBuffer> {
  const typedArray = new Uint8Array(arrayBuffer);
  const pdfDoc = await pdfjs.getDocument({ data: typedArray }).promise;
  const numPages = pdfDoc.numPages;

  let newPdf: jsPDF | null = null;

  for (let i = 1; i <= numPages; i++) {
    if (onProgress) onProgress(i, numPages);
    await nextFrame(); // UIブロック回避

    const page = await pdfDoc.getPage(i);
    const originalViewport = page.getViewport({ scale: 1.0 });
    const renderScale = 2.0;
    const viewport = page.getViewport({ scale: renderScale });

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2Dコンテキストの取得に失敗しました');

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({ canvas, canvasContext: context, viewport }).promise;
    await nextFrame(); // レンダリング後も待機

    const imgData = canvas.toDataURL('image/png');

    const pageWidthPt = originalViewport.width * 72 / 96;
    const pageHeightPt = originalViewport.height * 72 / 96;

    if (i === 1) {
      const orientation = pageWidthPt > pageHeightPt ? 'l' : 'p';
      newPdf = new jsPDF({
        orientation: orientation as 'l' | 'p',
        unit: 'pt',
        format: [pageWidthPt, pageHeightPt],
        compress: true
      });
    } else if (newPdf) {
      const orient = pageWidthPt > pageHeightPt ? 'l' : 'p';
      newPdf.addPage([pageWidthPt, pageHeightPt], orient as 'l' | 'p');
    }

    if (newPdf) {
      newPdf.addImage(imgData, 'PNG', 0, 0, pageWidthPt, pageHeightPt, undefined, 'SLOW');
    }

    // メモリ解放
    canvas.width = 0;
    canvas.height = 0;
  }

  if (!newPdf) throw new Error('PDFの作成に失敗しました');
  return newPdf.output('arraybuffer');
}

// ============== LRUキャッシュ（MojiQから移植） ==============
const PDF_CACHE_MAX_SIZE = 60; // 最大60エントリ（30ページ × 2ファイル）

class LRUCache<T> {
  private maxSize: number;
  private cache = new Map<string, T>();
  private onEvict?: (value: T) => void;  // メモリ解放コールバック

  constructor(maxSize: number, onEvict?: (value: T) => void) {
    this.maxSize = maxSize;
    this.onEvict = onEvict;
  }

  get(key: string): T | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // LRU更新: 削除して再追加（Mapの末尾が最新）
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: T): void {
    // 既存エントリの上書き時にメモリ解放
    if (this.cache.has(key)) {
      const old = this.cache.get(key)!;
      if (this.onEvict) this.onEvict(old);
      this.cache.delete(key);
    }
    this.cache.set(key, value);
    // 容量超過時に最古（先頭）を削除
    while (this.cache.size > this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        const oldest = this.cache.get(oldestKey)!;
        if (this.onEvict) this.onEvict(oldest);  // メモリ解放
        this.cache.delete(oldestKey);
      }
    }
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  delete(key: string): boolean {
    const value = this.cache.get(key);
    if (value && this.onEvict) this.onEvict(value);
    return this.cache.delete(key);
  }

  clear(): void {
    // 全エントリのメモリ解放
    if (this.onEvict) {
      this.cache.forEach(value => this.onEvict!(value));
    }
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// ============== PDFキャッシュマネージャー ==============
interface PdfDocCache {
  pdf: pdfjs.PDFDocumentProxy;
  numPages: number;
  compressed?: boolean;
}

// ImageBitmapキャッシュエントリ（MojiQから移植）
interface BitmapCacheEntry {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

interface PreloadItem {
  fileA: File;
  fileB: File;
  page: number;
}

// 最適化進捗のグローバルコールバック（UIから設定）
export let globalOptimizeProgress: ((fileName: string, message: string, current?: number, total?: number) => void) | null = null;
export function setOptimizeProgressCallback(cb: ((fileName: string, message: string, current?: number, total?: number) => void) | null) {
  globalOptimizeProgress = cb;
}

export class PdfCacheManager {
  docCache: Map<string, PdfDocCache>;
  bitmapCache: LRUCache<BitmapCacheEntry>;   // ImageBitmapキャッシュ（MojiQから移植）
  compressedDataCache: Map<string, ArrayBuffer>; // 圧縮済みデータのキャッシュ
  renderingPages: Set<string>;
  preloadQueue: PreloadItem[];
  isPreloading: boolean;

  constructor() {
    this.docCache = new Map();
    // ImageBitmap用LRUキャッシュ（evict時にbitmap.close()でメモリ解放）
    this.bitmapCache = new LRUCache<BitmapCacheEntry>(
      PDF_CACHE_MAX_SIZE,
      (entry) => entry.bitmap.close()
    );
    this.compressedDataCache = new Map();
    this.renderingPages = new Set();
    this.preloadQueue = [];
    this.isPreloading = false;
  }

  getFileId(file: File) {
    return `${file.name}-${file.size}-${file.lastModified}`;
  }

  async getDocument(file: File, enableOptimization = true): Promise<PdfDocCache> {
    const fileId = this.getFileId(file);
    if (this.docCache.has(fileId)) return this.docCache.get(fileId)!;

    let arrayBuffer = await file.arrayBuffer();
    let optimized = false;

    // 自動最適化が有効な場合
    if (PDF_AUTO_OPTIMIZE_ENABLED && enableOptimization) {
      // 最適化済みキャッシュがあればそれを使用
      if (this.compressedDataCache.has(fileId)) {
        arrayBuffer = this.compressedDataCache.get(fileId)!;
        optimized = true;
      } else if (file.size >= PDF_COMPRESS_THRESHOLD) {
        // 500MB以上: Canvas経由の重い圧縮処理（確認ダイアログなし、バックグラウンドで実行）
        try {
          console.log(`[PdfCache] Heavy compression for very large PDF: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
          arrayBuffer = await compressPdfViaCanvas(arrayBuffer, (current, total) => {
            if (globalOptimizeProgress) globalOptimizeProgress(file.name, 'PDFを圧縮しています...', current, total);
          });
          this.compressedDataCache.set(fileId, arrayBuffer);
          optimized = true;
          console.log(`[PdfCache] Heavy compression complete: ${file.name}`);
        } catch (err) {
          console.error('[PdfCache] Heavy compression failed, using original:', err);
          arrayBuffer = await file.arrayBuffer();
        }
      } else {
        // 500MB未満: pdf-libによる軽量最適化（MojiQと同様に全PDFに適用）
        try {
          console.log(`[PdfCache] Optimizing PDF: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
          arrayBuffer = await optimizePdfResources(arrayBuffer, (message, current, total) => {
            if (globalOptimizeProgress) globalOptimizeProgress(file.name, message, current, total);
          });
          this.compressedDataCache.set(fileId, arrayBuffer);
          optimized = true;
          console.log(`[PdfCache] Optimization complete: ${file.name}`);
        } catch (err) {
          console.error('[PdfCache] Optimization failed, using original:', err);
          arrayBuffer = await file.arrayBuffer();
        }
      }
    }

    const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
    const cached = { pdf, numPages: pdf.numPages, compressed: optimized };
    this.docCache.set(fileId, cached);
    return cached;
  }

  // ImageBitmapを取得（MojiQと同様のCanvas直接レンダリング）
  async renderPageBitmap(file: File, pageNum: number, scale = 8.0): Promise<BitmapCacheEntry | null> {
    const fileId = this.getFileId(file);
    const cacheKey = `${fileId}-${pageNum}`;

    if (this.bitmapCache.has(cacheKey)) return this.bitmapCache.get(cacheKey)!;

    if (this.renderingPages.has(cacheKey)) {
      return new Promise((resolve) => {
        const check = () => {
          if (this.bitmapCache.has(cacheKey)) resolve(this.bitmapCache.get(cacheKey)!);
          else if (this.renderingPages.has(cacheKey)) setTimeout(check, 30);
          else resolve(null);
        };
        check();
      });
    }

    this.renderingPages.add(cacheKey);
    try {
      const { pdf } = await this.getDocument(file);
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale });

      // PDF → Canvas → ImageBitmap
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;

      const bitmap = await createImageBitmap(canvas);
      const entry: BitmapCacheEntry = { bitmap, width: canvas.width, height: canvas.height };

      // 元Canvasのメモリ解放
      canvas.width = 0;
      canvas.height = 0;

      this.bitmapCache.set(cacheKey, entry);
      return entry;
    } finally {
      this.renderingPages.delete(cacheKey);
    }
  }

  // 見開き分割レンダリング（右から読み用）
  async renderSplitPageBitmap(
    file: File,
    pageNum: number,
    side: 'left' | 'right',
    scale = 8.0
  ): Promise<BitmapCacheEntry | null> {
    const fileId = this.getFileId(file);
    const cacheKey = `${fileId}-${pageNum}-${side}`;

    if (this.bitmapCache.has(cacheKey)) return this.bitmapCache.get(cacheKey)!;

    if (this.renderingPages.has(cacheKey)) {
      return new Promise((resolve) => {
        const check = () => {
          if (this.bitmapCache.has(cacheKey)) resolve(this.bitmapCache.get(cacheKey)!);
          else if (this.renderingPages.has(cacheKey)) setTimeout(check, 30);
          else resolve(null);
        };
        check();
      });
    }

    this.renderingPages.add(cacheKey);
    try {
      const { pdf } = await this.getDocument(file);
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale });

      // 全体をレンダリング
      const fullCanvas = document.createElement('canvas');
      fullCanvas.width = viewport.width;
      fullCanvas.height = viewport.height;
      await page.render({ canvas: fullCanvas, canvasContext: fullCanvas.getContext('2d')!, viewport }).promise;

      // 半分を切り出し
      const halfWidth = Math.floor(viewport.width / 2);
      const splitCanvas = document.createElement('canvas');
      splitCanvas.width = halfWidth;
      splitCanvas.height = viewport.height;
      const ctx = splitCanvas.getContext('2d')!;

      // 右から読み: rightが先（右半分）、leftが後（左半分）
      const offsetX = side === 'right' ? halfWidth : 0;
      ctx.drawImage(
        fullCanvas,
        offsetX, 0, halfWidth, viewport.height,
        0, 0, halfWidth, viewport.height
      );

      const bitmap = await createImageBitmap(splitCanvas);
      const entry: BitmapCacheEntry = { bitmap, width: splitCanvas.width, height: splitCanvas.height };

      // メモリ解放
      fullCanvas.width = 0;
      fullCanvas.height = 0;
      splitCanvas.width = 0;
      splitCanvas.height = 0;

      this.bitmapCache.set(cacheKey, entry);
      return entry;
    } finally {
      this.renderingPages.delete(cacheKey);
    }
  }

  // 後方互換性のためDataURL版も残す（差分計算等で使用）
  async renderPage(file: File, pageNum: number, scale = 8.0): Promise<string | null> {
    const entry = await this.renderPageBitmap(file, pageNum, scale);
    if (!entry) return null;

    // ImageBitmapからDataURLを生成（差分計算用）
    const canvas = document.createElement('canvas');
    canvas.width = entry.width;
    canvas.height = entry.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(entry.bitmap, 0, 0);

    const dataUrl = canvas.toDataURL('image/png');
    canvas.width = 0;
    canvas.height = 0;
    return dataUrl;
  }

  async preloadAllPages(fileA: File, fileB: File, totalPages: number, onProgress?: (page: number) => void) {
    this.preloadQueue = [];

    for (let p = 1; p <= totalPages; p++) {
      this.preloadQueue.push({ fileA, fileB, page: p });
    }

    if (!this.isPreloading) {
      this.processPreloadQueue(onProgress);
    }
  }

  async processPreloadQueue(onProgress?: (page: number) => void) {
    this.isPreloading = true;

    while (this.preloadQueue.length > 0) {
      const item = this.preloadQueue.shift()!;
      const { fileA, fileB, page } = item;
      const keyA = `${this.getFileId(fileA)}-${page}`;
      const keyB = `${this.getFileId(fileB)}-${page}`;

      const promises: Promise<BitmapCacheEntry | null>[] = [];
      if (!this.bitmapCache.has(keyA) && !this.renderingPages.has(keyA)) {
        promises.push(this.renderPageBitmap(fileA, page).catch(() => null));
      }
      if (!this.bitmapCache.has(keyB) && !this.renderingPages.has(keyB)) {
        promises.push(this.renderPageBitmap(fileB, page).catch(() => null));
      }

      if (promises.length > 0) {
        await Promise.all(promises);
        if (onProgress) onProgress(page);
      }

      await new Promise(r => setTimeout(r, 0));
    }

    this.isPreloading = false;
  }

  prioritizePage(fileA: File, fileB: File, pageNum: number, totalPages: number) {
    const priorityPages: number[] = [];
    for (let offset = 0; offset <= 5; offset++) {
      if (pageNum + offset <= totalPages) priorityPages.push(pageNum + offset);
      if (offset > 0 && pageNum - offset >= 1) priorityPages.push(pageNum - offset);
    }

    this.preloadQueue = this.preloadQueue.filter(
      item => !priorityPages.includes(item.page)
    );

    for (const p of priorityPages.reverse()) {
      const keyA = `${this.getFileId(fileA)}-${p}`;
      const keyB = `${this.getFileId(fileB)}-${p}`;
      if (!this.bitmapCache.has(keyA) || !this.bitmapCache.has(keyB)) {
        this.preloadQueue.unshift({ fileA, fileB, page: p });
      }
    }
  }

  // 最初のN件を優先的に先読み（最適化UI表示中に呼び出す）
  async preloadInitialPages(file: File, pagesToPreload: number, onProgress?: (message: string) => void): Promise<void> {
    const { numPages } = await this.getDocument(file, false); // 再最適化なし
    const maxPages = Math.min(pagesToPreload, numPages);

    for (let page = 1; page <= maxPages; page++) {
      if (onProgress) onProgress(`ページを準備中... (${page}/${maxPages})`);
      await this.renderPageBitmap(file, page);
      await new Promise(r => setTimeout(r, 0)); // UIブロック回避
    }
  }

  clear() {
    this.docCache.clear();
    this.bitmapCache.clear();  // ImageBitmap.close()が自動で呼ばれる
    this.compressedDataCache.clear();
    this.renderingPages.clear();
    this.preloadQueue = [];
  }
}

export const pdfCache = new PdfCacheManager();
