import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  FolderOpen, ChevronUp, ChevronDown, HelpCircle,
  Layers, FileDiff, CheckCircle, AlertTriangle, Upload, Loader2,
  Settings, Target, HardDrive, Columns2, Eye, EyeOff, FileText, Link2, Unlink2, Edit3, RefreshCw,
  PanelLeftClose, PanelLeft, FileImage, Palette, Shuffle, Maximize2, BookOpen
} from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';
import UTIF from 'utif';
import { jsPDF } from 'jspdf';
import { PDFDocument } from 'pdf-lib';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { readFile as tauriReadFile, readDir } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import GDriveFolderBrowser from './components/GDriveFolderBrowser';
import ScreenshotEditor from './components/ScreenshotEditor';

// PDF.js Worker設定
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

// ============== 高速PSDパーサー ==============
class PsdParser {
  bytes: Uint8Array;
  offset: number;

  constructor(buffer: ArrayBuffer) {
    this.bytes = new Uint8Array(buffer);
    this.offset = 0;
  }

  readUint16() {
    const b1 = this.bytes[this.offset], b2 = this.bytes[this.offset + 1];
    this.offset += 2;
    return (b1 << 8) | b2;
  }

  readUint32() {
    const b = this.bytes, o = this.offset;
    this.offset += 4;
    return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  }

  readUint64() {
    const high = this.readUint32(), low = this.readUint32();
    return high * 0x100000000 + low;
  }

  decodeRLE(src: Uint8Array, srcStart: number, srcLen: number, dst: Uint8Array, dstStart: number, dstLen: number) {
    let s = srcStart, d = dstStart;
    const srcEnd = srcStart + srcLen, dstEnd = dstStart + dstLen;
    while (d < dstEnd && s < srcEnd) {
      const n = src[s++];
      if (n >= 128) {
        const count = 257 - n, val = src[s++];
        const end = Math.min(d + count, dstEnd);
        while (d < end) dst[d++] = val;
      } else {
        const count = n + 1;
        const end = Math.min(d + count, dstEnd);
        while (d < end) dst[d++] = src[s++];
      }
    }
  }

  parse() {
    this.offset = 0;
    const sig = String.fromCharCode(...this.bytes.slice(0, 4));
    if (sig !== '8BPS') throw new Error('Not a PSD file');

    const version = this.bytes[5];
    const isPSB = version === 2;
    this.offset = 12;

    const channels = this.readUint16();
    const height = this.readUint32();
    const width = this.readUint32();
    this.readUint16(); // depth - skip
    const colorMode = this.readUint16();

    const colorDataLen = this.readUint32();
    this.offset += colorDataLen;
    const resourceLen = this.readUint32();
    this.offset += resourceLen;
    const layerLen = isPSB ? this.readUint64() : this.readUint32();
    this.offset += layerLen;

    const compression = this.readUint16();
    const chToRead = Math.min(channels, colorMode === 4 ? 4 : 3);
    const pixelCount = width * height;
    const bytes = this.bytes;
    const channelData: Uint8Array[] = [];

    if (compression === 1) {
      const rowCounts = new Uint16Array(channels * height);
      for (let i = 0; i < channels * height; i++) rowCounts[i] = this.readUint16();

      let rowIdx = 0;
      for (let c = 0; c < channels; c++) {
        if (c < chToRead) {
          const chData = new Uint8Array(pixelCount);
          let pixelOff = 0;
          for (let y = 0; y < height; y++) {
            const rowLen = rowCounts[rowIdx++];
            this.decodeRLE(bytes, this.offset, rowLen, chData, pixelOff, width);
            this.offset += rowLen;
            pixelOff += width;
          }
          channelData[c] = chData;
        } else {
          for (let y = 0; y < height; y++) this.offset += rowCounts[rowIdx++];
        }
      }
    } else {
      for (let c = 0; c < chToRead; c++) {
        channelData[c] = bytes.slice(this.offset, this.offset + pixelCount);
        this.offset += pixelCount;
      }
      if (channels > chToRead) this.offset += pixelCount * (channels - chToRead);
    }

    const rgba = new Uint8ClampedArray(pixelCount * 4);

    if (colorMode === 4) {
      const c0 = channelData[0], c1 = channelData[1], c2 = channelData[2], c3 = channelData[3] || c0;
      for (let i = 0, j = 0; i < pixelCount; i++, j += 4) {
        const c = c0[i], m = c1[i], y = c2[i], k = c3[i];
        rgba[j] = 255 - Math.min(255, c + k);
        rgba[j + 1] = 255 - Math.min(255, m + k);
        rgba[j + 2] = 255 - Math.min(255, y + k);
        rgba[j + 3] = 255;
      }
    } else {
      const r = channelData[0], g = channelData[1] || r, b = channelData[2] || r;
      for (let i = 0, j = 0; i < pixelCount; i++, j += 4) {
        rgba[j] = r[i]; rgba[j + 1] = g[i]; rgba[j + 2] = b[i]; rgba[j + 3] = 255;
      }
    }

    return { rgba, width, height };
  }
}

// PSDをCanvasに変換
async function parsePsdToCanvas(buffer: ArrayBuffer) {
  const parser = new PsdParser(buffer);
  const { rgba, width, height } = parser.parse();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const imageData = new ImageData(rgba, width, height);
  ctx.putImageData(imageData, 0, 0);
  return { canvas, width, height };
}

// ============== PDF最適化処理（MojiQから移植） ==============
// pdf-lib最適化: 未参照リソースを削除してメモリ使用量を削減
// ページめくり速度にも影響（5-30%改善）
// MojiQと同様に500MB未満の全PDFに最適化を適用（閾値なし）
const PDF_COMPRESS_THRESHOLD = 500 * 1024 * 1024; // 500MB以上でCanvas圧縮
const PDF_AUTO_OPTIMIZE_ENABLED = true; // MojiQと同様に有効化
const PDF_SIZE_WARNING_THRESHOLD = 100 * 1024 * 1024; // 100MB以上で警告

// PDFファイルサイズチェック（100MB以上で拒否）
const checkPdfFileSize = (file: File): boolean => {
  if (file.size > PDF_SIZE_WARNING_THRESHOLD) {
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    alert(`このPDFファイルは ${sizeMB}MB で、100MBを超えています。\n別のファイルを選択するか、圧縮処理をしてください。`);
    return false;
  }
  return true;
};

// フレーム待機（UIブロック回避）
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

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
let globalOptimizeProgress: ((fileName: string, message: string, current?: number, total?: number) => void) | null = null;
function setOptimizeProgressCallback(cb: ((fileName: string, message: string, current?: number, total?: number) => void) | null) {
  globalOptimizeProgress = cb;
}

class PdfCacheManager {
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

const pdfCache = new PdfCacheManager();

// ============== 型定義 ==============
// パス情報付きFileオブジェクト
interface FileWithPath extends File {
  filePath?: string;
}

interface CropBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface DiffMarker {
  x: number;
  y: number;
  radius: number;
  count: number;
}

interface FilePair {
  index: number;
  fileA: File | null;
  fileB: File | null;
  nameA: string | null;
  nameB: string | null;
  srcA: string | null;
  srcB: string | null;
  processedA: string | null;
  processedB: string | null;
  diffSrc: string | null;
  diffSrcWithMarkers?: string | null;
  hasDiff: boolean;
  diffProbability: number;
  totalPages: number;
  status: 'pending' | 'loading' | 'done' | 'error';
  errorMessage?: string;
  markers?: DiffMarker[];
  imageWidth?: number;
  imageHeight?: number;
}

interface PageCache {
  srcA: string;
  srcB: string;
  diffSrc: string;
  diffSrcWithMarkers?: string;
  hasDiff: boolean;
  markers?: DiffMarker[];
}

// ============== 並列ビューモード用の型定義 ==============
type AppMode = 'diff-check' | 'parallel-view';

interface ParallelFileEntry {
  path: string;
  name: string;
  type: 'tiff' | 'psd' | 'pdf' | 'image';
  pageCount?: number; // PDFの場合（元ファイルの総ページ数）
  pdfPage?: number; // PDFの場合、このエントリが何ページ目か（1-indexed）
  pdfFile?: File; // PDFファイル参照（ドロップされた場合）
  spreadSide?: 'left' | 'right'; // 見開き分割時の左右（右から読みなので right が先）
}

interface ParallelImageCache {
  [key: string]: {
    dataUrl: string;
    width: number;
    height: number;
  };
}

// ============== 差分検出アプリ ==============
export default function MangaDiffDetector() {
  const [compareMode, setCompareMode] = useState<'tiff-tiff' | 'psd-psd' | 'pdf-pdf' | 'psd-tiff'>('tiff-tiff');
  const [initialModeSelect, setInitialModeSelect] = useState(true);
  const [filesA, setFilesA] = useState<File[]>([]);
  const [filesB, setFilesB] = useState<File[]>([]);
  const [diffFolderA, setDiffFolderA] = useState<string | null>(null);
  const [diffFolderB, setDiffFolderB] = useState<string | null>(null);
  const [pairs, setPairs] = useState<FilePair[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [viewMode, setViewMode] = useState<'A' | 'B' | 'diff' | 'A-full'>('A');
  const [cropBounds, setCropBounds] = useState<CropBounds | null>(null);
  const [pairingMode, setPairingMode] = useState<'order' | 'name'>('order');
  const [filterDiffOnly, setFilterDiffOnly] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showMarkers, setShowMarkers] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [diffCache, setDiffCache] = useState<Record<string, PageCache>>({});
  const [isLoadingPage, setIsLoadingPage] = useState(false);
  const [dragOverSide, setDragOverSide] = useState<string | null>(null);
  const [preloadProgress, setPreloadProgress] = useState({ loaded: 0, total: 0 });
  const [optimizeProgress, setOptimizeProgress] = useState<{ fileName: string; message: string; current?: number; total?: number } | null>(null);
  const [isGDriveBrowserOpen, setIsGDriveBrowserOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [panPosition, setPanPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true); // デフォルトで折りたたみ
  const dragStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const imageContainerRef = useRef<HTMLDivElement>(null);
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);  // PDF表示用Canvas（差分モード）
  const parallelPdfCanvasARef = useRef<HTMLCanvasElement>(null);  // PDF表示用Canvas（ダブルビューワーA）
  const parallelPdfCanvasBRef = useRef<HTMLCanvasElement>(null);  // PDF表示用Canvas（ダブルビューワーB）
  const fileListRef = useRef<HTMLDivElement>(null);  // ファイルリスト用
  const pageListRef = useRef<HTMLDivElement>(null);  // PDFページリスト用
  const parallelFileListRef = useRef<HTMLDivElement>(null);  // 並列ビューファイルリスト用

  // ============== 並列ビューモード用のstate ==============
  const [appMode, setAppMode] = useState<AppMode>('diff-check');
  const [parallelFolderA, setParallelFolderA] = useState<string | null>(null);
  const [parallelFolderB, setParallelFolderB] = useState<string | null>(null);
  const [parallelFilesA, setParallelFilesA] = useState<ParallelFileEntry[]>([]);
  const [parallelFilesB, setParallelFilesB] = useState<ParallelFileEntry[]>([]);
  const [parallelCurrentIndex, setParallelCurrentIndex] = useState(0);
  const [parallelIndexA, setParallelIndexA] = useState(0); // 非同期モード用の個別インデックス
  const [parallelIndexB, setParallelIndexB] = useState(0); // 非同期モード用の個別インデックス
  const [parallelSyncMode, setParallelSyncMode] = useState(true); // 同期モード（デフォルト）
  const [parallelActivePanel, setParallelActivePanel] = useState<'A' | 'B'>('A'); // 非同期モードでアクティブなパネル
  const [showSyncOptions, setShowSyncOptions] = useState(false); // 再同期オプション表示
  const [showPsSelectPopup, setShowPsSelectPopup] = useState(false); // Photoshop選択ポップアップ
  const [showMojiQSelectPopup, setShowMojiQSelectPopup] = useState(false); // MojiQ選択ポップアップ（並列ビューワー用）
  const [showFolderSelectPopup, setShowFolderSelectPopup] = useState(false); // フォルダ選択ポップアップ（並列ビューワー用）
  const [spreadSplitModeA, setSpreadSplitModeA] = useState(false); // 見開き分割モード（A側）
  const [spreadSplitModeB, setSpreadSplitModeB] = useState(false); // 見開き分割モード（B側）
  const [firstPageSingleA, setFirstPageSingleA] = useState(true); // 1ページ目を単ページ扱い（A側）
  const [firstPageSingleB, setFirstPageSingleB] = useState(true); // 1ページ目を単ページ扱い（B側）
  const [parallelImageA, setParallelImageA] = useState<string | null>(null);
  const [parallelImageB, setParallelImageB] = useState<string | null>(null);
  const [parallelLoading, setParallelLoading] = useState(false);
  const [parallelImageCache, setParallelImageCache] = useState<ParallelImageCache>({});
  const [parallelCapturedImageA, setParallelCapturedImageA] = useState<string | null>(null); // 指示エディタ用
  const [parallelCapturedImageB, setParallelCapturedImageB] = useState<string | null>(null); // 指示エディタ用
  const [parallelZoomA, setParallelZoomA] = useState(1); // ズーム（A側）
  const [parallelZoomB, setParallelZoomB] = useState(1); // ズーム（B側）
  const [parallelPanA, setParallelPanA] = useState({ x: 0, y: 0 }); // パン位置（A側）
  const [parallelPanB, setParallelPanB] = useState({ x: 0, y: 0 }); // パン位置（B側）
  const [isDraggingParallelA, setIsDraggingParallelA] = useState(false); // ドラッグ中（A側）
  const [isDraggingParallelB, setIsDraggingParallelB] = useState(false); // ドラッグ中（B側）
  const [isFullscreen, setIsFullscreen] = useState(false); // 全画面表示
  const [showFullscreenHint, setShowFullscreenHint] = useState(false); // 全画面ヒント表示
  const [instructionButtonsHidden, setInstructionButtonsHidden] = useState(false); // 指示エディタボタン非表示状態

  const processingRef = useRef(false);
  const compareModeRef = useRef(compareMode); // モード変更を追跡
  const parallelDragStartRefA = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const parallelDragStartRefB = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  // モード切り替え関数（即座にペアをクリアして誤った処理を防ぐ）
  const handleModeChange = useCallback((newMode: 'tiff-tiff' | 'psd-psd' | 'pdf-pdf' | 'psd-tiff') => {
    // 現在のモードと同じなら何もしない
    if (newMode === compareMode) return;
    // まず処理フラグをリセットして進行中の処理を止める
    processingRef.current = false;
    // ペアとファイルを即座にクリア（自動処理が走らないように）
    setPairs([]);
    setFilesA([]);
    setFilesB([]);
    // モードを変更
    setCompareMode(newMode);
    setInitialModeSelect(false);
    setSidebarCollapsed(false);
  }, [compareMode]);

  // モード変更時にリセット
  useEffect(() => {
    processingRef.current = false; // 進行中の処理フラグをリセット
    compareModeRef.current = compareMode; // モード追跡を更新
    setFilesA([]);
    setFilesB([]);
    setDiffFolderA(null);
    setDiffFolderB(null);
    setPairs([]);
    setSelectedIndex(0);
    setCropBounds(null);
    setDiffCache({});
    setCurrentPage(1);
    setPreloadProgress({ loaded: 0, total: 0 });
    setZoom(1);
    setPanPosition({ x: 0, y: 0 });
    setViewMode('A'); // ビューモードをリセット
    pdfCache.clear();
  }, [compareMode]);

  // PDF最適化進捗コールバックの設定
  useEffect(() => {
    setOptimizeProgressCallback((fileName, message, current, total) => {
      // PDFモード以外では進捗表示を無視
      if (compareModeRef.current !== 'pdf-pdf') return;
      setOptimizeProgress({ fileName, message, current, total });
    });
    return () => setOptimizeProgressCallback(null);
  }, []);

  // 最適化完了後に進捗をクリア
  useEffect(() => {
    if (optimizeProgress) {
      // 「生成しています」または「完了」メッセージの場合は遅延後にクリア
      if (optimizeProgress.message.includes('生成しています') || optimizeProgress.message.includes('完了')) {
        const timer = setTimeout(() => setOptimizeProgress(null), 1000);
        return () => clearTimeout(timer);
      }
    }
  }, [optimizeProgress]);

  // モード切り替え時に最適化進捗をクリア（PDF以外のモードに切り替えた場合や、前回の処理が残っている場合）
  useEffect(() => {
    setOptimizeProgress(null);
  }, [compareMode]);

  // ファイル・ページ切り替え時にズームリセット（viewMode変更時は維持、Ctrl+0で手動リセット）
  useEffect(() => {
    setZoom(1);
    setPanPosition({ x: 0, y: 0 });
  }, [selectedIndex, currentPage]);

  // PDF Canvas表示更新（差分モード用）- ImageBitmapから直接描画
  useEffect(() => {
    if (compareMode !== 'pdf-pdf' || viewMode === 'diff') return;
    if (!pdfCanvasRef.current) return;

    const file = viewMode === 'B' ? filesB[0] : filesA[0];
    if (!file) return;

    (async () => {
      const entry = await pdfCache.renderPageBitmap(file, currentPage);
      if (entry && pdfCanvasRef.current) {
        const canvas = pdfCanvasRef.current;
        canvas.width = entry.width;
        canvas.height = entry.height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(entry.bitmap, 0, 0);
      }
    })();
  }, [compareMode, viewMode, currentPage, filesA, filesB]);

  // PDF Canvas表示更新（ダブルビューワー用）- ImageBitmapから直接描画
  useEffect(() => {
    if (appMode !== 'parallel-view') return;

    const entryA = parallelFilesA[parallelIndexA];
    const entryB = parallelFilesB[parallelIndexB];

    // パネルA: PDF表示（見開き分割対応）
    if (entryA?.type === 'pdf' && entryA.pdfFile && entryA.pdfPage && parallelPdfCanvasARef.current) {
      (async () => {
        const entry = entryA.spreadSide
          ? await pdfCache.renderSplitPageBitmap(entryA.pdfFile!, entryA.pdfPage!, entryA.spreadSide)
          : await pdfCache.renderPageBitmap(entryA.pdfFile!, entryA.pdfPage!);
        if (entry && parallelPdfCanvasARef.current) {
          const canvas = parallelPdfCanvasARef.current;
          canvas.width = entry.width;
          canvas.height = entry.height;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(entry.bitmap, 0, 0);
        }
      })();
    }

    // パネルB: PDF表示（見開き分割対応）
    if (entryB?.type === 'pdf' && entryB.pdfFile && entryB.pdfPage && parallelPdfCanvasBRef.current) {
      (async () => {
        const entry = entryB.spreadSide
          ? await pdfCache.renderSplitPageBitmap(entryB.pdfFile!, entryB.pdfPage!, entryB.spreadSide)
          : await pdfCache.renderPageBitmap(entryB.pdfFile!, entryB.pdfPage!);
        if (entry && parallelPdfCanvasBRef.current) {
          const canvas = parallelPdfCanvasBRef.current;
          canvas.width = entry.width;
          canvas.height = entry.height;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(entry.bitmap, 0, 0);
        }
      })();
    }
  }, [appMode, parallelFilesA, parallelFilesB, parallelIndexA, parallelIndexB]);

  // モードに応じたファイル拡張子フィルタ
  const getAcceptedExtensions = useCallback((side: 'A' | 'B') => {
    switch (compareMode) {
      case 'tiff-tiff': return ['.tif', '.tiff'];
      case 'psd-psd': return ['.psd'];
      case 'pdf-pdf': return ['.pdf'];
      case 'psd-tiff': return side === 'A' ? ['.psd'] : ['.tif', '.tiff'];
      default: return [];
    }
  }, [compareMode]);

  const isAcceptedFile = useCallback((file: File, side: 'A' | 'B') => {
    const ext = getAcceptedExtensions(side);
    const name = file.name.toLowerCase();
    return ext.some(e => name.endsWith(e));
  }, [getAcceptedExtensions]);

  const getFileType = (file: File) => {
    const name = file.name.toLowerCase();
    if (name.endsWith('.psd')) return 'psd';
    if (name.endsWith('.tif') || name.endsWith('.tiff')) return 'tiff';
    if (name.endsWith('.pdf')) return 'pdf';
    return 'image';
  };

  // PSD読み込み（統合画像のみを読む軽量パーサー）
  const readPsdFile = async (file: FileWithPath) => {
    let buffer: ArrayBuffer;

    if (file.filePath) {
      // Tauriでファイル読み込み
      const bytes = await tauriReadFile(file.filePath);
      buffer = bytes.buffer;
    } else {
      // ブラウザFile API
      buffer = await file.arrayBuffer();
    }

    const { canvas, width, height } = await parsePsdToCanvas(buffer);
    return { dataUrl: canvas.toDataURL('image/png'), width, height, canvas };
  };

  // TIFF/画像読み込み
  const readTiffFile = async (file: File): Promise<{ dataUrl: string; width: number; height: number; canvas: HTMLCanvasElement }> => {
    return new Promise((resolve, reject) => {
      const isTiffFile = file.name.toLowerCase().endsWith('.tif') || file.name.toLowerCase().endsWith('.tiff');
      const reader = new FileReader();

      if (isTiffFile) {
        reader.onload = (e) => {
          try {
            const buffer = e.target?.result as ArrayBuffer;
            const ifds = UTIF.decode(buffer);
            if (!ifds || ifds.length === 0) throw new Error("Invalid TIFF");
            const page0 = ifds[0];
            UTIF.decodeImage(buffer, page0);
            const rgba = UTIF.toRGBA8(page0);
            const canvas = document.createElement('canvas');
            canvas.width = page0.width;
            canvas.height = page0.height;
            const ctx = canvas.getContext('2d')!;
            const imageData = new ImageData(new Uint8ClampedArray(rgba), page0.width, page0.height);
            ctx.putImageData(imageData, 0, 0);
            resolve({ dataUrl: canvas.toDataURL('image/png'), width: page0.width, height: page0.height, canvas });
          } catch (err) { reject(err); }
        };
        reader.readAsArrayBuffer(file);
      } else {
        reader.onload = (e) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(img, 0, 0);
            resolve({ dataUrl: e.target?.result as string, width: img.width, height: img.height, canvas });
          };
          img.onerror = reject;
          img.src = e.target?.result as string;
        };
        reader.readAsDataURL(file);
      }
    });
  };

  // 汎用ファイル読み込み
  const readFile = async (file: File) => {
    const type = getFileType(file);
    if (type === 'psd') return readPsdFile(file);
    return readTiffFile(file);
  };

  // JSON読み込み
  const loadJsonFile = useCallback((file: File): Promise<CropBounds> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const json = JSON.parse(ev.target?.result as string);

          // パターン1: presetData.selectionRanges[0].bounds (新形式)
          if (json.presetData?.selectionRanges?.length > 0 && json.presetData.selectionRanges[0].bounds) {
            const bounds = json.presetData.selectionRanges[0].bounds;
            setCropBounds(bounds);
            resolve(bounds);
            return;
          }

          // パターン2: selectionRanges[0].bounds (従来形式)
          if (json.selectionRanges && json.selectionRanges.length > 0 && json.selectionRanges[0].bounds) {
            const bounds = json.selectionRanges[0].bounds;
            setCropBounds(bounds);
            resolve(bounds);
            return;
          }

          // パターン3: bounds直接 (レガシー)
          if (json.bounds) {
            setCropBounds(json.bounds);
            resolve(json.bounds);
            return;
          }

          reject(new Error('boundsが見つかりません'));
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }, []);

  // PSDをクロップしてTIFFサイズにリサイズ
  const cropAndResizePsd = (psdCanvas: HTMLCanvasElement, tiffWidth: number, tiffHeight: number, bounds: CropBounds) => {
    const { left, top, right, bottom } = bounds;
    const cropWidth = right - left;
    const cropHeight = bottom - top;

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = cropWidth;
    cropCanvas.height = cropHeight;
    const cropCtx = cropCanvas.getContext('2d')!;
    cropCtx.drawImage(psdCanvas, left, top, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

    const resizedCanvas = document.createElement('canvas');
    resizedCanvas.width = tiffWidth;
    resizedCanvas.height = tiffHeight;
    const resizedCtx = resizedCanvas.getContext('2d')!;
    resizedCtx.imageSmoothingEnabled = false;
    resizedCtx.drawImage(cropCanvas, 0, 0, cropWidth, cropHeight, 0, 0, tiffWidth, tiffHeight);

    return resizedCanvas.toDataURL('image/png');
  };

  // 差分計算（PSD-TIFF用 - ヒートマップ + マーカー）
  const computeDiffHeatmap = (imgA: string, imgB: string, threshold = 70): Promise<{
    diffSrc: string;
    diffSrcWithMarkers: string;
    hasDiff: boolean;
    diffProbability: number;
    highDensityCount: number;
    markers: DiffMarker[];
    imageWidth: number;
    imageHeight: number;
  }> => {
    return new Promise((resolve) => {
      const imageA = new Image();
      const imageB = new Image();
      let loaded = 0;

      const onLoad = () => {
        loaded++;
        if (loaded < 2) return;

        const width = Math.max(imageA.width, imageB.width);
        const height = Math.max(imageA.height, imageB.height);

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;

        ctx.drawImage(imageA, 0, 0, width, height);
        const dataA = ctx.getImageData(0, 0, width, height);

        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(imageB, 0, 0, width, height);
        const dataB = ctx.getImageData(0, 0, width, height);

        const diffMask = new Uint8Array(width * height);

        for (let i = 0; i < dataA.data.length; i += 4) {
          const r1 = dataA.data[i], g1 = dataA.data[i + 1], b1 = dataA.data[i + 2];
          const r2 = dataB.data[i], g2 = dataB.data[i + 1], b2 = dataB.data[i + 2];
          const pixelIdx = i / 4;

          if (Math.abs(r1 - r2) > threshold || Math.abs(g1 - g2) > threshold || Math.abs(b1 - b2) > threshold) {
            diffMask[pixelIdx] = 1;
          }
        }

        const densityMap = new Float32Array(width * height);
        const radius = 15;
        const integral = new Float32Array((width + 1) * (height + 1));

        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            const intIdx = (y + 1) * (width + 1) + (x + 1);
            integral[intIdx] = diffMask[idx] + integral[intIdx - 1] + integral[intIdx - (width + 1)] - integral[intIdx - (width + 1) - 1];
          }
        }

        let maxDensity = 0;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const x1 = Math.max(0, x - radius);
            const y1 = Math.max(0, y - radius);
            const x2 = Math.min(width - 1, x + radius);
            const y2 = Math.min(height - 1, y + radius);
            const area = (x2 - x1 + 1) * (y2 - y1 + 1);
            const sum = integral[(y2 + 1) * (width + 1) + (x2 + 1)] - integral[(y1) * (width + 1) + (x2 + 1)] - integral[(y2 + 1) * (width + 1) + (x1)] + integral[(y1) * (width + 1) + (x1)];
            const density = sum / area;
            densityMap[y * width + x] = density;
            if (density > maxDensity) maxDensity = density;
          }
        }

        const diffData = ctx.createImageData(width, height);
        let highDensityCount = 0;
        const densityThreshold = 0.05;
        const highDensityPixels: { x: number; y: number }[] = [];

        for (let i = 0; i < width * height; i++) {
          const di = i * 4;
          const density = densityMap[i];
          const normalizedDensity = maxDensity > 0 ? density / maxDensity : 0;

          if (diffMask[i] === 1 && density > densityThreshold) {
            let r, g, b;
            if (normalizedDensity < 0.3) {
              r = 0; g = Math.floor(normalizedDensity / 0.3 * 200); b = 200;
            } else if (normalizedDensity < 0.6) {
              const t = (normalizedDensity - 0.3) / 0.3;
              r = Math.floor(t * 255); g = 200 + Math.floor(t * 55); b = Math.floor((1 - t) * 200);
            } else {
              const t = (normalizedDensity - 0.6) / 0.4;
              r = 255; g = Math.floor((1 - t) * 255); b = 0;
              highDensityCount++;
              highDensityPixels.push({ x: i % width, y: Math.floor(i / width) });
            }
            diffData.data[di] = r; diffData.data[di + 1] = g; diffData.data[di + 2] = b; diffData.data[di + 3] = 255;
          } else {
            diffData.data[di] = 0; diffData.data[di + 1] = 0; diffData.data[di + 2] = 0; diffData.data[di + 3] = 255;
          }
        }

        ctx.putImageData(diffData, 0, 0);
        const diffSrcNoMarkers = canvas.toDataURL();

        const markers: DiffMarker[] = [];
        if (highDensityPixels.length > 0) {
          const gridSize = 250;
          const grid = new Map<string, { gx: number; gy: number; pixels: { x: number; y: number }[]; minX: number; maxX: number; minY: number; maxY: number }>();
          for (const p of highDensityPixels) {
            const gx = Math.floor(p.x / gridSize);
            const gy = Math.floor(p.y / gridSize);
            const key = `${gx},${gy}`;
            if (!grid.has(key)) grid.set(key, { gx, gy, pixels: [], minX: p.x, maxX: p.x, minY: p.y, maxY: p.y });
            const cell = grid.get(key)!;
            cell.pixels.push(p);
            cell.minX = Math.min(cell.minX, p.x);
            cell.maxX = Math.max(cell.maxX, p.x);
            cell.minY = Math.min(cell.minY, p.y);
            cell.maxY = Math.max(cell.maxY, p.y);
          }

          const cells = Array.from(grid.values()).filter(c => c.pixels.length >= 10);
          const parent = new Map<number, number>();
          cells.forEach((_, i) => parent.set(i, i));

          const find = (i: number): number => {
            if (parent.get(i) !== i) parent.set(i, find(parent.get(i)!));
            return parent.get(i)!;
          };
          const union = (i: number, j: number) => {
            const pi = find(i), pj = find(j);
            if (pi !== pj) parent.set(pi, pj);
          };

          for (let i = 0; i < cells.length; i++) {
            for (let j = i + 1; j < cells.length; j++) {
              const dx = Math.abs(cells[i].gx - cells[j].gx);
              const dy = Math.abs(cells[i].gy - cells[j].gy);
              if (dx <= 1 && dy <= 1) union(i, j);
            }
          }

          const groups = new Map<number, { minX: number; maxX: number; minY: number; maxY: number; count: number }>();
          cells.forEach((cell, i) => {
            const root = find(i);
            if (!groups.has(root)) groups.set(root, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, count: 0 });
            const g = groups.get(root)!;
            g.minX = Math.min(g.minX, cell.minX);
            g.maxX = Math.max(g.maxX, cell.maxX);
            g.minY = Math.min(g.minY, cell.minY);
            g.maxY = Math.max(g.maxY, cell.maxY);
            g.count += cell.pixels.length;
          });

          for (const group of groups.values()) {
            if (group.count >= 20) {
              const cx = (group.minX + group.maxX) / 2;
              const cy = (group.minY + group.maxY) / 2;
              const radiusX = (group.maxX - group.minX) / 2 + 60;
              const radiusY = (group.maxY - group.minY) / 2 + 60;
              const markerRadius = Math.max(80, Math.max(radiusX, radiusY));
              markers.push({ x: cx, y: cy, radius: markerRadius, count: group.count });
            }
          }

          markers.sort((a, b) => b.count - a.count);

          ctx.lineWidth = 8;
          markers.forEach((marker, idx) => {
            ctx.strokeStyle = 'cyan';
            ctx.beginPath();
            ctx.arc(marker.x, marker.y, marker.radius, 0, Math.PI * 2);
            ctx.stroke();

            ctx.strokeStyle = 'white';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(marker.x, marker.y, marker.radius - 5, 0, Math.PI * 2);
            ctx.stroke();
            ctx.lineWidth = 8;

            const badgeY = marker.y - marker.radius - 30;
            ctx.fillStyle = 'cyan';
            ctx.beginPath();
            ctx.arc(marker.x, badgeY, 24, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = 'black';
            ctx.font = 'bold 28px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(idx + 1), marker.x, badgeY);
          });
        }

        const diffSrcWithMarkers = canvas.toDataURL();

        let diffProbability = 0;
        if (highDensityCount > 0) {
          const baseProb = 70;
          const totalPixels = width * height;
          const additionalProb = Math.min(30, (highDensityCount / totalPixels) * 50000);
          diffProbability = baseProb + additionalProb;
        }

        resolve({
          diffSrc: diffSrcNoMarkers, diffSrcWithMarkers,
          hasDiff: highDensityCount > 0,
          diffProbability: Math.round(diffProbability * 10) / 10,
          highDensityCount, markers, imageWidth: width, imageHeight: height
        });
      };

      imageA.onload = onLoad; imageB.onload = onLoad;
      imageA.src = imgA; imageB.src = imgB;
    });
  };

  // 差分計算（シンプル版 + マーカー機能）
  const computeDiffSimple = async (srcA: string, srcB: string, threshold: number): Promise<{
    diffSrc: string;
    diffSrcWithMarkers: string;
    hasDiff: boolean;
    diffCount: number;
    markers: DiffMarker[];
    imageWidth: number;
    imageHeight: number;
  }> => {
    return new Promise((resolve) => {
      const imageA = new Image();
      const imageB = new Image();
      let loaded = 0;

      const onLoad = () => {
        loaded++;
        if (loaded < 2) return;

        const width = Math.max(imageA.width, imageB.width);
        const height = Math.max(imageA.height, imageB.height);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;

        ctx.drawImage(imageA, 0, 0, width, height);
        const dataA = ctx.getImageData(0, 0, width, height);

        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(imageB, 0, 0, width, height);
        const dataB = ctx.getImageData(0, 0, width, height);

        const diffData = ctx.createImageData(width, height);
        let diffCount = 0;
        const diffPixels: { x: number; y: number }[] = [];

        for (let i = 0; i < dataA.data.length; i += 4) {
          const dr = Math.abs(dataA.data[i] - dataB.data[i]);
          const dg = Math.abs(dataA.data[i + 1] - dataB.data[i + 1]);
          const db = Math.abs(dataA.data[i + 2] - dataB.data[i + 2]);

          if (dr > threshold || dg > threshold || db > threshold) {
            diffData.data[i] = 255;
            diffData.data[i + 1] = 0;
            diffData.data[i + 2] = 0;
            diffData.data[i + 3] = 255;
            diffCount++;
            const pixelIdx = i / 4;
            diffPixels.push({ x: pixelIdx % width, y: Math.floor(pixelIdx / width) });
          } else {
            diffData.data[i + 3] = 255;
          }
        }

        ctx.putImageData(diffData, 0, 0);
        const diffSrc = canvas.toDataURL();

        const markers: DiffMarker[] = [];
        if (diffPixels.length > 0) {
          const gridSize = 200;
          const grid = new Map<string, { gx: number; gy: number; pixels: { x: number; y: number }[]; minX: number; maxX: number; minY: number; maxY: number }>();
          for (const p of diffPixels) {
            const gx = Math.floor(p.x / gridSize);
            const gy = Math.floor(p.y / gridSize);
            const key = `${gx},${gy}`;
            if (!grid.has(key)) grid.set(key, { gx, gy, pixels: [], minX: p.x, maxX: p.x, minY: p.y, maxY: p.y });
            const cell = grid.get(key)!;
            cell.pixels.push(p);
            cell.minX = Math.min(cell.minX, p.x);
            cell.maxX = Math.max(cell.maxX, p.x);
            cell.minY = Math.min(cell.minY, p.y);
            cell.maxY = Math.max(cell.maxY, p.y);
          }

          const cells = Array.from(grid.values());
          const parent = new Map<number, number>();
          cells.forEach((_, i) => parent.set(i, i));

          const find = (i: number): number => {
            if (parent.get(i) !== i) parent.set(i, find(parent.get(i)!));
            return parent.get(i)!;
          };
          const union = (i: number, j: number) => {
            const pi = find(i), pj = find(j);
            if (pi !== pj) parent.set(pi, pj);
          };

          for (let i = 0; i < cells.length; i++) {
            for (let j = i + 1; j < cells.length; j++) {
              const dx = Math.abs(cells[i].gx - cells[j].gx);
              const dy = Math.abs(cells[i].gy - cells[j].gy);
              if (dx <= 1 && dy <= 1) union(i, j);
            }
          }

          const groups = new Map<number, { minX: number; maxX: number; minY: number; maxY: number; count: number }>();
          cells.forEach((cell, i) => {
            const root = find(i);
            if (!groups.has(root)) groups.set(root, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, count: 0 });
            const g = groups.get(root)!;
            g.minX = Math.min(g.minX, cell.minX);
            g.maxX = Math.max(g.maxX, cell.maxX);
            g.minY = Math.min(g.minY, cell.minY);
            g.maxY = Math.max(g.maxY, cell.maxY);
            g.count += cell.pixels.length;
          });

          for (const group of groups.values()) {
            if (group.count >= 1) {
              const cx = (group.minX + group.maxX) / 2;
              const cy = (group.minY + group.maxY) / 2;
              const radiusX = (group.maxX - group.minX) / 2 + 100;
              const radiusY = (group.maxY - group.minY) / 2 + 100;
              const markerRadius = Math.max(300, Math.max(radiusX, radiusY));
              markers.push({ x: cx, y: cy, radius: markerRadius, count: group.count });
            }
          }

          markers.sort((a, b) => b.count - a.count);

          ctx.lineWidth = 6;
          markers.forEach((marker, idx) => {
            ctx.strokeStyle = 'cyan';
            ctx.beginPath();
            ctx.arc(marker.x, marker.y, marker.radius, 0, Math.PI * 2);
            ctx.stroke();

            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(marker.x, marker.y, marker.radius - 4, 0, Math.PI * 2);
            ctx.stroke();
            ctx.lineWidth = 6;

            const badgeY = marker.y - marker.radius - 20;
            ctx.fillStyle = 'cyan';
            ctx.beginPath();
            ctx.arc(marker.x, badgeY, 18, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = 'black';
            ctx.font = 'bold 20px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(idx + 1), marker.x, badgeY);
          });
        }

        const diffSrcWithMarkers = canvas.toDataURL();

        resolve({ diffSrc, diffSrcWithMarkers, hasDiff: diffCount > 0, diffCount, markers, imageWidth: width, imageHeight: height });
      };

      imageA.onload = onLoad;
      imageB.onload = onLoad;
      imageA.src = srcA;
      imageB.src = srcB;
    });
  };

  // モードラベル
  const getModeLabels = () => {
    switch (compareMode) {
      case 'tiff-tiff': return { a: 'TIFF (元)', b: 'TIFF (修正)', accept: '.tif,.tiff' };
      case 'psd-psd': return { a: 'PSD (元)', b: 'PSD (修正)', accept: '.psd' };
      case 'pdf-pdf': return { a: 'PDF (元)', b: 'PDF (修正)', accept: '.pdf' };
      case 'psd-tiff': return { a: 'PSD (元)', b: 'TIFF (出力)', accept: { a: '.psd', b: '.tif,.tiff' } };
      default: return { a: 'A', b: 'B', accept: '*' };
    }
  };

  const modeLabels = getModeLabels();

  // ドラッグ中のサイドを追跡するref（Tauriイベント用）
  const dragOverSideRef = useRef<string | null>(null);
  const dropZoneARef = useRef<HTMLDivElement>(null);
  const dropZoneBRef = useRef<HTMLDivElement>(null);
  const dropZoneJsonRef = useRef<HTMLDivElement>(null);
  const parallelDropZoneARef = useRef<HTMLDivElement>(null);
  const parallelDropZoneBRef = useRef<HTMLDivElement>(null);
  useEffect(() => { dragOverSideRef.current = dragOverSide; }, [dragOverSide]);
  const appModeRef = useRef<AppMode>(appMode);
  useEffect(() => { appModeRef.current = appMode; }, [appMode]);

  // Tauriパスからファイルを読み込んでFileオブジェクトに変換
  const readFilesFromPaths = useCallback(async (paths: string[]): Promise<File[]> => {
    const mimeTypes: Record<string, string> = {
      'tif': 'image/tiff', 'tiff': 'image/tiff',
      'psd': 'image/vnd.adobe.photoshop',
      'pdf': 'application/pdf',
      'json': 'application/json'
    };
    const supportedExts = ['psd', 'tif', 'tiff', 'pdf', 'json'];

    // ファイルパスを収集（読み込みはまだしない）
    const filePaths: string[] = [];

    const addFileIfSupported = (filePath: string, fileName: string) => {
      const dotIndex = fileName.lastIndexOf('.');
      const ext = dotIndex > 0 ? fileName.substring(dotIndex + 1).toLowerCase() : '';
      if (supportedExts.includes(ext)) {
        filePaths.push(filePath);
      }
    };

    const collectFromDir = async (dirPath: string): Promise<void> => {
      // readDirはディレクトリでない場合にエラーをスロー
      const entries = await readDir(dirPath);
      for (const entry of entries) {
        if (!entry.name) continue;
        const childPath = dirPath + '\\' + entry.name;
        if (entry.isDirectory) {
          await collectFromDir(childPath);
        } else {
          addFileIfSupported(childPath, entry.name);
        }
      }
    };

    // パスを収集
    for (const p of paths) {
      try {
        // ディレクトリとして試す（ファイルならエラーになる）
        await collectFromDir(p);
      } catch {
        // ディレクトリでなければファイルとして追加
        const pathParts = p.replace(/\//g, '\\').split('\\');
        const name = pathParts[pathParts.length - 1] || '';
        addFileIfSupported(p, name);
      }
    }

    // 並列でファイルを読み込み（パス情報を保持）
    const filePromises = filePaths.map(async (filePath): Promise<FileWithPath | null> => {
      const pathParts = filePath.replace(/\//g, '\\').split('\\');
      const name = pathParts[pathParts.length - 1] || 'unknown';
      const dotIndex = name.lastIndexOf('.');
      const ext = dotIndex > 0 ? name.substring(dotIndex + 1).toLowerCase() : '';

      try {
        // PSDファイルはRust側で読むので、ここではダミーのFileを作成してパスだけ保持
        if (ext === 'psd') {
          const file = new File([], name, { type: 'image/vnd.adobe.photoshop' }) as FileWithPath;
          file.filePath = filePath;
          return file;
        }

        const data = await tauriReadFile(filePath);
        const file = new File([data], name, { type: mimeTypes[ext] || 'application/octet-stream' }) as FileWithPath;
        file.filePath = filePath;
        return file;
      } catch {
        return null;
      }
    });

    const results = await Promise.all(filePromises);
    return results.filter((f): f is FileWithPath => f !== null);
  }, []);

  // 位置からドロップゾーンを判定
  const getDropZoneFromPosition = useCallback((x: number, y: number): string | null => {
    // DPIスケーリングを考慮（Tauriは物理ピクセル、DOMは論理ピクセルを使用）
    const scale = window.devicePixelRatio || 1;
    const scaledX = x / scale;
    const scaledY = y / scale;

    const checkZone = (ref: React.RefObject<HTMLDivElement | null>, name: string): string | null => {
      if (!ref.current) return null;
      const rect = ref.current.getBoundingClientRect();
      if (scaledX >= rect.left && scaledX <= rect.right && scaledY >= rect.top && scaledY <= rect.bottom) {
        return name;
      }
      return null;
    };
    // parallel-viewモードのドロップゾーンも検出
    return checkZone(dropZoneJsonRef, 'json')
      || checkZone(dropZoneARef, 'A')
      || checkZone(dropZoneBRef, 'B')
      || checkZone(parallelDropZoneARef, 'parallelA')
      || checkZone(parallelDropZoneBRef, 'parallelB');
  }, []);

  // parallel-viewモードのTauriドロップ処理関数
  const handleParallelTauriDrop = useCallback(async (paths: string[], side: 'A' | 'B') => {
    if (paths.length === 0) return;
    const firstPath = paths[0];

    // ディレクトリかどうかチェック
    try {
      await readDir(firstPath); // ディレクトリでなければエラーをスロー
      // ディレクトリの場合
      await expandFolderToParallelEntries(firstPath, side);
    } catch {
      // ファイルの場合
      const fileName = firstPath.split(/[/\\]/).pop() || '';
      const ext = fileName.split('.').pop()?.toLowerCase() || '';

      if (ext === 'pdf') {
        // PDFファイルの場合はTauriから読み込んでFileオブジェクトを作成
        try {
          const bytes = await tauriReadFile(firstPath);
          const blob = new Blob([bytes], { type: 'application/pdf' });
          const file = new File([blob], fileName, { type: 'application/pdf' });
          // 実際のファイルパスを使用（MojiQ連携で必要）
          await expandPdfToParallelEntries(firstPath, side, file);
        } catch (err) {
          console.error('PDF load error:', err);
        }
      } else if (['tif', 'tiff', 'psd', 'png', 'jpg', 'jpeg'].includes(ext)) {
        // 画像ファイルの場合は単一エントリとして追加
        let type: ParallelFileEntry['type'] = 'image';
        if (ext === 'tif' || ext === 'tiff') type = 'tiff';
        else if (ext === 'psd') type = 'psd';

        const entry: ParallelFileEntry = { path: firstPath, name: fileName, type };

        if (side === 'A') {
          setParallelFolderA(firstPath);
          setParallelFilesA([entry]);
        } else {
          setParallelFolderB(firstPath);
          setParallelFilesB([entry]);
        }
        setParallelCurrentIndex(0);
        setParallelIndexA(0);
        setParallelIndexB(0);
      }
    }
  }, []);

  // Tauriドラッグ&ドロップイベントリスナー
  useEffect(() => {
    const setupDragDrop = async () => {
      const appWindow = getCurrentWebviewWindow();
      const unlisten = await appWindow.onDragDropEvent(async (event) => {
        if (event.payload.type === 'over') {
          const { x, y } = event.payload.position;
          const zone = getDropZoneFromPosition(x, y);
          setDragOverSide(zone);
        } else if (event.payload.type === 'drop') {
          const paths = event.payload.paths;
          const { x, y } = event.payload.position;
          const side = getDropZoneFromPosition(x, y) || dragOverSideRef.current;
          setDragOverSide(null);

          if (!side || paths.length === 0) return;

          // parallel-viewモードのドロップ処理
          if (side === 'parallelA') {
            await handleParallelTauriDrop(paths, 'A');
            return;
          }
          if (side === 'parallelB') {
            await handleParallelTauriDrop(paths, 'B');
            return;
          }

          // 並列ビューモードのときは差分モード用のドロップを無視
          if (appModeRef.current === 'parallel-view' && (side === 'A' || side === 'B' || side === 'json')) {
            return;
          }

          const allFiles = await readFilesFromPaths(paths);
          if (allFiles.length === 0) {
            alert(`ファイル読み込みエラー\nパス: ${paths.join(', ')}`);
            return;
          }

          if (side === 'json') {
            const jsonFile = allFiles.find(f => f.name.toLowerCase().endsWith('.json'));
            if (!jsonFile) { alert('JSONファイルが見つかりません'); return; }
            try { await loadJsonFile(jsonFile); } catch { alert('JSONの解析に失敗しました'); }
            return;
          }

          const filteredFiles = allFiles.filter(f => isAcceptedFile(f, side as 'A' | 'B'));
          if (filteredFiles.length === 0) {
            const ext = getAcceptedExtensions(side as 'A' | 'B').join(', ');
            alert(`対応ファイルが見つかりません\n（${ext}）`);
            return;
          }

          const sortedFiles = filteredFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
          if (side === 'A') setFilesA(sortedFiles);
          else if (side === 'B') setFilesB(sortedFiles);
        } else if (event.payload.type === 'leave') {
          setDragOverSide(null);
        }
      });
      return unlisten;
    };

    const unlistenPromise = setupDragDrop();
    return () => { unlistenPromise.then(fn => fn()); };
  }, [readFilesFromPaths, isAcceptedFile, getAcceptedExtensions, loadJsonFile, getDropZoneFromPosition, handleParallelTauriDrop]);

  // DataTransferItemからファイルを再帰的に取得（ブラウザ用フォールバック）
  const getAllFilesFromDataTransfer = useCallback(async (dataTransfer: DataTransfer) => {
    const files: File[] = [];
    const items = Array.from(dataTransfer.items);

    const readDirectory = async (entry: FileSystemEntry, path = ''): Promise<void> => {
      if (entry.isFile) {
        return new Promise((resolve) => {
          (entry as FileSystemFileEntry).file((file) => {
            Object.defineProperty(file, 'webkitRelativePath', { value: path + file.name, writable: false });
            files.push(file);
            resolve();
          }, () => resolve());
        });
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        return new Promise((resolve) => {
          const readEntries = () => {
            reader.readEntries(async (entries) => {
              if (entries.length === 0) {
                resolve();
              } else {
                for (const e of entries) await readDirectory(e, path + entry.name + '/');
                readEntries();
              }
            }, () => resolve());
          };
          readEntries();
        });
      }
    };

    for (const item of items) {
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry?.();
        if (entry) await readDirectory(entry);
        else {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
    }
    return files;
  }, []);

  // ホイールハンドラ（分割ビューワー/差分モード用ページめくり）
  const handleWheelPageTurn = useCallback((e: React.WheelEvent) => {
    // 分割ビューワーまたは差分モードでホイールによるページめくり
    e.preventDefault();
    if (e.deltaY > 0) {
      // 下スクロール = 次のファイル/ページ
      setSelectedIndex(i => Math.min(i + 1, pairs.length - 1));
    } else {
      // 上スクロール = 前のファイル/ページ
      setSelectedIndex(i => Math.max(i - 1, 0));
    }
  }, [pairs.length]);


  const handleImageMouseDown = useCallback((e: React.MouseEvent) => {
    if (zoom <= 1) return;
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY, panX: panPosition.x, panY: panPosition.y };
  }, [zoom, panPosition]);

  const handleImageMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setPanPosition({ x: dragStartRef.current.panX + dx, y: dragStartRef.current.panY + dy });
  }, [isDragging]);

  const handleImageMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleImageDoubleClick = useCallback(() => {
    setZoom(1);
    setPanPosition({ x: 0, y: 0 });
  }, []);

  // 分割ビューワー用ドラッグハンドラ（A側）
  const handleParallelMouseDownA = useCallback((e: React.MouseEvent) => {
    if (parallelZoomA <= 1) return;
    e.preventDefault();
    setIsDraggingParallelA(true);
    parallelDragStartRefA.current = { x: e.clientX, y: e.clientY, panX: parallelPanA.x, panY: parallelPanA.y };
  }, [parallelZoomA, parallelPanA]);

  const handleParallelMouseMoveA = useCallback((e: React.MouseEvent) => {
    if (!isDraggingParallelA) return;
    const dx = e.clientX - parallelDragStartRefA.current.x;
    const dy = e.clientY - parallelDragStartRefA.current.y;
    setParallelPanA({ x: parallelDragStartRefA.current.panX + dx, y: parallelDragStartRefA.current.panY + dy });
  }, [isDraggingParallelA]);

  const handleParallelMouseUpA = useCallback(() => {
    setIsDraggingParallelA(false);
  }, []);

  // 分割ビューワー用ドラッグハンドラ（B側）
  const handleParallelMouseDownB = useCallback((e: React.MouseEvent) => {
    if (parallelZoomB <= 1) return;
    e.preventDefault();
    setIsDraggingParallelB(true);
    parallelDragStartRefB.current = { x: e.clientX, y: e.clientY, panX: parallelPanB.x, panY: parallelPanB.y };
  }, [parallelZoomB, parallelPanB]);

  const handleParallelMouseMoveB = useCallback((e: React.MouseEvent) => {
    if (!isDraggingParallelB) return;
    const dx = e.clientX - parallelDragStartRefB.current.x;
    const dy = e.clientY - parallelDragStartRefB.current.y;
    setParallelPanB({ x: parallelDragStartRefB.current.panX + dx, y: parallelDragStartRefB.current.panY + dy });
  }, [isDraggingParallelB]);

  const handleParallelMouseUpB = useCallback(() => {
    setIsDraggingParallelB(false);
  }, []);

  // ドラッグ＆ドロップハンドラ
  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); }, []);
  const handleDragEnter = useCallback((side: string) => (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOverSide(side); }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverSide(null); }, []);

  const handleDrop = useCallback((side: string) => async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverSide(null);

    const allFiles = await getAllFilesFromDataTransfer(e.dataTransfer);

    if (side === 'json') {
      const jsonFile = allFiles.find(f => f.name.toLowerCase().endsWith('.json'));
      if (!jsonFile) { alert('JSONファイルが見つかりません'); return; }
      try { await loadJsonFile(jsonFile); } catch { alert('JSONの解析に失敗しました'); }
      return;
    }

    const filteredFiles = allFiles.filter(f => isAcceptedFile(f, side as 'A' | 'B'));
    if (filteredFiles.length === 0) {
      const ext = getAcceptedExtensions(side as 'A' | 'B').join(', ');
      alert(`対応ファイルが見つかりません\n（${ext}）`);
      return;
    }

    // PDFファイルのサイズチェック（100MB以上で警告）
    const pdfFile = filteredFiles.find(f => f.name.toLowerCase().endsWith('.pdf'));
    if (pdfFile && !checkPdfFileSize(pdfFile)) {
      return; // キャンセルされた場合は処理中断
    }

    const sortedFiles = filteredFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (side === 'A') setFilesA(sortedFiles);
    else setFilesB(sortedFiles);
  }, [getAllFilesFromDataTransfer, isAcceptedFile, getAcceptedExtensions, loadJsonFile]);

  // Tauriフォルダ/ファイルダイアログで選択
  const handleFilesAUpload = async () => {
    try {
      const extensions = getAcceptedExtensions('A').map(e => e.replace('.', ''));

      // PDFモードの場合はファイル選択、その他はフォルダ選択
      if (compareMode === 'pdf-pdf') {
        const selected = await open({
          directory: false,
          multiple: false,
          title: 'PDFファイルAを選択',
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        });
        if (!selected || typeof selected !== 'string') return;

        const files = await readFilesFromPaths([selected]);
        const filtered = files.filter(f => isAcceptedFile(f, 'A'));
        if (filtered.length === 0) return;

        // PDFファイルのサイズチェック（100MB以上で警告）
        const pdfFile = filtered[0];
        if (pdfFile && !checkPdfFileSize(pdfFile)) {
          return; // キャンセルされた場合は処理中断
        }
        setDiffFolderA(null);
        setFilesA(filtered);
      } else {
        const selected = await open({
          directory: true,
          multiple: false,
          title: 'フォルダAを選択',
        });
        if (!selected || typeof selected !== 'string') return;

        // フォルダパスを保存
        setDiffFolderA(selected);

        // Rustでファイル一覧を取得
        const filePaths = await invoke<string[]>('list_files_in_folder', {
          path: selected,
          extensions,
        });

        const files = await readFilesFromPaths(filePaths);
        const filtered = files.filter(f => isAcceptedFile(f, 'A'));
        // PDFファイルのサイズチェック（100MB以上で警告）
        const pdfFile = filtered.find(f => f.name.toLowerCase().endsWith('.pdf'));
        if (pdfFile && !checkPdfFileSize(pdfFile)) {
          return; // キャンセルされた場合は処理中断
        }
        setFilesA(filtered.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })));
      }
    } catch (err) {
      console.error('File/Folder selection error:', err);
    }
  };

  const handleFilesBUpload = async () => {
    try {
      const extensions = getAcceptedExtensions('B').map(e => e.replace('.', ''));

      // PDFモードの場合はファイル選択、その他はフォルダ選択
      if (compareMode === 'pdf-pdf') {
        const selected = await open({
          directory: false,
          multiple: false,
          title: 'PDFファイルBを選択',
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        });
        if (!selected || typeof selected !== 'string') return;

        const files = await readFilesFromPaths([selected]);
        const filtered = files.filter(f => isAcceptedFile(f, 'B'));
        if (filtered.length === 0) return;

        // PDFファイルのサイズチェック（100MB以上で警告）
        const pdfFile = filtered[0];
        if (pdfFile && !checkPdfFileSize(pdfFile)) {
          return; // キャンセルされた場合は処理中断
        }
        setDiffFolderB(null);
        setFilesB(filtered);
      } else {
        const selected = await open({
          directory: true,
          multiple: false,
          title: 'フォルダBを選択',
        });
        if (!selected || typeof selected !== 'string') return;

        // フォルダパスを保存
        setDiffFolderB(selected);

        // Rustでファイル一覧を取得
        const filePaths = await invoke<string[]>('list_files_in_folder', {
          path: selected,
          extensions,
        });

        const files = await readFilesFromPaths(filePaths);
        const filtered = files.filter(f => isAcceptedFile(f, 'B'));
        // PDFファイルのサイズチェック（100MB以上で警告）
        const pdfFile = filtered.find(f => f.name.toLowerCase().endsWith('.pdf'));
        if (pdfFile && !checkPdfFileSize(pdfFile)) {
          return; // キャンセルされた場合は処理中断
        }
        setFilesB(filtered.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })));
      }
    } catch (err) {
      console.error('File/Folder selection error:', err);
    }
  };

  // ペアリング
  useEffect(() => {
    if (filesA.length === 0 && filesB.length === 0) { setPairs([]); return; }

    let newPairs: FilePair[] = [];
    if (pairingMode === 'order') {
      const maxLen = Math.max(filesA.length, filesB.length);
      for (let i = 0; i < maxLen; i++) {
        newPairs.push({
          index: i, fileA: filesA[i] || null, fileB: filesB[i] || null,
          nameA: filesA[i]?.name || null, nameB: filesB[i]?.name || null,
          srcA: null, srcB: null, processedA: null, processedB: null,
          diffSrc: null, hasDiff: false, diffProbability: 0, totalPages: 1, status: 'pending'
        });
      }
    } else {
      const getBaseName = (name: string) => name.replace(/\.[^/.]+$/, "");
      const mapA = new Map<string, File>(), mapB = new Map<string, File>();
      filesA.forEach(f => mapA.set(getBaseName(f.name), f));
      filesB.forEach(f => mapB.set(getBaseName(f.name), f));
      const allNames = new Set([...mapA.keys(), ...mapB.keys()]);
      const sortedNames = Array.from(allNames).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

      sortedNames.forEach((baseName, idx) => {
        newPairs.push({
          index: idx, fileA: mapA.get(baseName) || null, fileB: mapB.get(baseName) || null,
          nameA: mapA.get(baseName)?.name || null, nameB: mapB.get(baseName)?.name || null,
          srcA: null, srcB: null, processedA: null, processedB: null,
          diffSrc: null, hasDiff: false, diffProbability: 0, totalPages: 1, status: 'pending'
        });
      });
    }

    setPairs(newPairs);
    setDiffCache({});
    setCurrentPage(1);
    setPreloadProgress({ loaded: 0, total: 0 });
    pdfCache.clear();
    if (newPairs.length > 0 && selectedIndex < 0) setSelectedIndex(0);
  }, [filesA, filesB, pairingMode]);

  useEffect(() => { setCurrentPage(1); }, [selectedIndex]);

  // ファイルリストの自動スクロール
  useEffect(() => {
    if (fileListRef.current && selectedIndex >= 0) {
      const item = fileListRef.current.querySelector(`[data-index="${selectedIndex}"]`);
      if (item) item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  // PDFページリストの自動スクロール
  useEffect(() => {
    if (pageListRef.current && currentPage >= 1) {
      const item = pageListRef.current.querySelector(`[data-page="${currentPage}"]`);
      if (item) item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [currentPage]);

  // 並列ビューファイルリストの自動スクロール
  useEffect(() => {
    if (parallelFileListRef.current) {
      // 同期モードまたはアクティブパネルに応じてスクロール
      const targetIndex = parallelSyncMode ? parallelIndexA : (parallelActivePanel === 'A' ? parallelIndexA : parallelIndexB);
      const item = parallelFileListRef.current.querySelector(`[data-index="${targetIndex}"]`);
      if (item) item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [parallelIndexA, parallelIndexB, parallelSyncMode, parallelActivePanel]);

  // ペア処理
  const processPair = useCallback(async (index: number) => {
    const pair = pairs[index];
    if (!pair || !pair.fileA || !pair.fileB) return;
    if (compareMode === 'psd-tiff' && !cropBounds) return;

    const startMode = compareMode; // 処理開始時のモードを記録

    setPairs(prev => {
      const next = [...prev];
      next[index] = { ...next[index], status: 'loading' };
      return next;
    });

    try {
      if (compareMode === 'psd-tiff') {
        // PSDとTIFFを並列読み込み
        const [psdResult, tiffResult] = await Promise.all([
          readPsdFile(pair.fileA),
          readTiffFile(pair.fileB)
        ]);
        // モードが変わっていたら処理を中断
        if (compareModeRef.current !== startMode) return;

        const srcA = psdResult.dataUrl;
        const srcB = tiffResult.dataUrl;
        const processedA = cropAndResizePsd(psdResult.canvas, tiffResult.width, tiffResult.height, cropBounds!);
        const processedB = tiffResult.dataUrl;
        const { diffSrc, diffSrcWithMarkers, hasDiff, diffProbability, markers, imageWidth, imageHeight } = await computeDiffHeatmap(processedA, processedB, 70);
        // モードが変わっていたら処理を中断
        if (compareModeRef.current !== startMode) return;

        setPairs(prev => {
          const next = [...prev];
          next[index] = { ...next[index], srcA, srcB, processedA, processedB, diffSrc, diffSrcWithMarkers, hasDiff, diffProbability, markers, imageWidth, imageHeight, status: 'done' };
          return next;
        });
      } else if (compareMode === 'pdf-pdf') {
        // 最適化（UIが表示される）
        const [docA, docB] = await Promise.all([
          pdfCache.getDocument(pair.fileA),
          pdfCache.getDocument(pair.fileB)
        ]);
        // モードが変わっていたら処理を中断
        if (compareModeRef.current !== startMode) return;

        const totalPages = Math.min(docA.numPages, docB.numPages);

        // 最初のページのみ読み込み（全ページ事前読み込みはメモリ消費が大きいため廃止）
        // LRUキャッシュでオンデマンドにページを管理
        if (globalOptimizeProgress) {
          globalOptimizeProgress(pair.fileA?.name || 'PDF', '1ページ目を準備中...', 1, totalPages);
        }

        // 1ページ目のみ読み込み（直列で処理してメモリ負荷を軽減）
        const srcA = await pdfCache.renderPage(pair.fileA!, 1);
        const srcB = await pdfCache.renderPage(pair.fileB!, 1);
        // モードが変わっていたら処理を中断
        if (compareModeRef.current !== startMode) return;

        if (globalOptimizeProgress) {
          globalOptimizeProgress(pair.fileA?.name || 'PDF', '準備完了', totalPages, totalPages);
        }

        const { diffSrc, diffSrcWithMarkers, hasDiff, markers } = await computeDiffSimple(srcA!, srcB!, 5);
        // モードが変わっていたら処理を中断
        if (compareModeRef.current !== startMode) return;

        const cacheKey = `${index}-1`;
        setDiffCache(prev => ({ ...prev, [cacheKey]: { srcA: srcA!, srcB: srcB!, diffSrc, diffSrcWithMarkers, hasDiff, markers } }));

        setPreloadProgress({ loaded: totalPages, total: totalPages });

        setPairs(prev => {
          const next = [...prev];
          next[index] = { ...next[index], srcA, srcB, processedA: srcA, processedB: srcB, diffSrc, hasDiff, totalPages, status: 'done' };
          return next;
        });
      } else {
        // 2つのファイルを並列読み込み
        const [resultA, resultB] = await Promise.all([
          readFile(pair.fileA),
          readFile(pair.fileB)
        ]);
        // モードが変わっていたら処理を中断
        if (compareModeRef.current !== startMode) return;

        const { diffSrc, diffSrcWithMarkers, hasDiff, markers } = await computeDiffSimple(resultA.dataUrl, resultB.dataUrl, 5);
        // モードが変わっていたら処理を中断
        if (compareModeRef.current !== startMode) return;

        setPairs(prev => {
          const next = [...prev];
          next[index] = { ...next[index], srcA: resultA.dataUrl, srcB: resultB.dataUrl, processedA: resultA.dataUrl, processedB: resultB.dataUrl, diffSrc, diffSrcWithMarkers, hasDiff, markers, status: 'done' };
          return next;
        });
      }
    } catch (err: any) {
      // モードが変わっていたらエラー処理もスキップ
      if (compareModeRef.current !== startMode) return;
      console.error("Processing error:", err);
      setPairs(prev => {
        const next = [...prev];
        next[index] = { ...next[index], status: 'error', errorMessage: err.message };
        return next;
      });
    }
  }, [pairs, compareMode, cropBounds]);

  // 自動処理
  useEffect(() => {
    if (processingRef.current) return;

    const pendingIndex = pairs.findIndex(p => p.status === 'pending' && p.fileA && p.fileB);
    if (pendingIndex >= 0 && (compareMode !== 'psd-tiff' || cropBounds)) {
      processingRef.current = true;
      processPair(pendingIndex).finally(() => { processingRef.current = false; });
    }
  }, [pairs, processPair, compareMode, cropBounds]);

  // PDFページ切り替え
  useEffect(() => {
    if (compareMode !== 'pdf-pdf') return;
    const pair = pairs[selectedIndex];
    if (!pair || pair.status !== 'done') return;

    const cacheKey = `${selectedIndex}-${currentPage}`;
    if (diffCache[cacheKey]) return;

    pdfCache.prioritizePage(pair.fileA!, pair.fileB!, currentPage, pair.totalPages);

    const loadPage = async () => {
      setIsLoadingPage(true);
      try {
        // 直列処理でメモリ負荷を軽減
        const srcA = await pdfCache.renderPage(pair.fileA!, currentPage);
        const srcB = await pdfCache.renderPage(pair.fileB!, currentPage);

        if (!srcA || !srcB) {
          setIsLoadingPage(false);
          return;
        }

        const { diffSrc, diffSrcWithMarkers, hasDiff, markers } = await computeDiffSimple(srcA, srcB, 5);

        setDiffCache(prev => ({ ...prev, [cacheKey]: { srcA, srcB, diffSrc, diffSrcWithMarkers, hasDiff, markers } }));
      } catch (err) {
        console.error("Page load error:", err);
      }
      setIsLoadingPage(false);
    };

    loadPage();
  }, [currentPage, selectedIndex, pairs, compareMode, diffCache]);

  // PDF全ページの差分を一斉計算（バックグラウンド）
  useEffect(() => {
    if (compareMode !== 'pdf-pdf') return;
    const pair = pairs[selectedIndex];
    if (!pair || pair.status !== 'done' || !pair.totalPages || pair.totalPages <= 1) return;

    const calculateAllPages = async () => {
      for (let page = 1; page <= pair.totalPages!; page++) {
        const cacheKey = `${selectedIndex}-${page}`;
        if (diffCache[cacheKey]) continue; // 既にキャッシュ済みならスキップ

        try {
          // 直列処理でメモリ負荷を軽減（並列処理を廃止）
          const srcA = await pdfCache.renderPage(pair.fileA!, page);
          const srcB = await pdfCache.renderPage(pair.fileB!, page);

          if (!srcA || !srcB) continue;

          const { diffSrc, diffSrcWithMarkers, hasDiff, markers } = await computeDiffSimple(srcA, srcB, 5);

          setDiffCache(prev => {
            // 既に計算済みならスキップ（競合防止）
            if (prev[cacheKey]) return prev;
            return { ...prev, [cacheKey]: { srcA, srcB, diffSrc, diffSrcWithMarkers, hasDiff, markers } };
          });

          // ページ間で少し待機してGCの機会を与える
          await new Promise(r => setTimeout(r, 50));
        } catch (err) {
          console.error(`Page ${page} diff calculation error:`, err);
        }
      }
    };

    calculateAllPages();
  }, [selectedIndex, pairs, compareMode]); // diffCacheは依存配列から除外（無限ループ防止）

  // ============== 並列ビューモード用の関数 ==============

  // 画像サイズ取得（画面サイズの50%）
  const getParallelDisplaySize = useCallback(() => {
    const width = Math.floor(window.innerWidth * 0.45);
    const height = Math.floor(window.innerHeight * 0.8);
    return { maxWidth: width, maxHeight: height };
  }, []);

  // 差分モードから並列ビューモードへの状態引き継ぎ
  const transferDiffToParallelView = useCallback(async () => {
    // ファイルリストが空の場合は何もしない
    if (filesA.length === 0 && filesB.length === 0) return;

    const { maxWidth, maxHeight } = getParallelDisplaySize();

    // PDF-PDFモードの場合、各ページを個別のエントリとして作成
    if (compareMode === 'pdf-pdf' && pairs.length > 0 && pairs[0].totalPages && pairs[0].totalPages > 1) {
      const totalPages = pairs[0].totalPages;
      const pdfFileA = filesA[0];
      const pdfFileB = filesB[0];
      const filePathA = (pdfFileA as FileWithPath).filePath || '';
      const filePathB = (pdfFileB as FileWithPath).filePath || '';

      // === MojiQ同様: 全ページ事前変換 ===
      if (globalOptimizeProgress) {
        globalOptimizeProgress(pdfFileA.name, 'ダブルビューワー準備中...', 0, totalPages);
      }

      // 全ページをDataURL変換してparallelImageCacheに保存
      // PDF表示はCanvas直接レンダリングを使用するため、事前変換は不要
      // useEffectのparallelPdfCanvasA/BRefで必要時にImageBitmapから描画される
      // diffCacheにある分のみキャッシュに追加（メモリ節約）
      const newCache: ParallelImageCache = {};
      for (let page = 1; page <= totalPages; page++) {
        const cacheKeyA = `${filePathA}:page${page}:${maxWidth}x${maxHeight}`;
        const cacheKeyB = `${filePathB}:page${page}:${maxWidth}x${maxHeight}`;

        const diffKey = `0-${page}`;
        const pageData = diffCache[diffKey];

        // diffCacheにある分だけキャッシュに追加（新規変換は行わない）
        if (pageData?.srcA) {
          newCache[cacheKeyA] = { dataUrl: pageData.srcA, width: 0, height: 0 };
        }
        if (pageData?.srcB) {
          newCache[cacheKeyB] = { dataUrl: pageData.srcB, width: 0, height: 0 };
        }
      }

      // キャッシュを更新
      setParallelImageCache(prev => ({ ...prev, ...newCache }));
      // === PDFキャッシュ移行ここまで ===

      // A側のPDFページエントリを作成
      const entriesA: ParallelFileEntry[] = [];
      for (let page = 1; page <= totalPages; page++) {
        entriesA.push({
          path: filePathA,
          name: `${pdfFileA.name} (P.${page})`,
          type: 'pdf',
          pageCount: totalPages,
          pdfPage: page,
          pdfFile: pdfFileA,
        });
      }
      const folderPathA = filePathA.substring(0, filePathA.lastIndexOf(/[/\\]/.test(filePathA) ? (filePathA.includes('\\') ? '\\' : '/') : '/')) || 'diff-mode';
      setParallelFolderA(folderPathA);
      setParallelFilesA(entriesA);

      // B側のPDFページエントリを作成
      const entriesB: ParallelFileEntry[] = [];
      for (let page = 1; page <= totalPages; page++) {
        entriesB.push({
          path: filePathB,
          name: `${pdfFileB.name} (P.${page})`,
          type: 'pdf',
          pageCount: totalPages,
          pdfPage: page,
          pdfFile: pdfFileB,
        });
      }
      const folderPathB = filePathB.substring(0, filePathB.lastIndexOf(/[/\\]/.test(filePathB) ? (filePathB.includes('\\') ? '\\' : '/') : '/')) || 'diff-mode';
      setParallelFolderB(folderPathB);
      setParallelFilesB(entriesB);

      // 現在のページに対応するインデックスを設定
      const pageIndex = currentPage - 1;
      setParallelCurrentIndex(pageIndex);
      setParallelIndexA(pageIndex);
      setParallelIndexB(pageIndex);

      // 進捗表示をクリア
      if (globalOptimizeProgress) {
        globalOptimizeProgress('', '完了', totalPages, totalPages);
      }
      return;
    }

    // ファイルをParallelFileEntry形式に変換するヘルパー関数
    const convertToParallelEntry = (file: File): ParallelFileEntry => {
      const fileWithPath = file as FileWithPath;
      const filePath = fileWithPath.filePath || '';
      const name = file.name;
      const ext = name.split('.').pop()?.toLowerCase() || '';
      let type: ParallelFileEntry['type'] = 'image';
      if (ext === 'tif' || ext === 'tiff') type = 'tiff';
      else if (ext === 'psd') type = 'psd';
      else if (ext === 'pdf') type = 'pdf';

      return { path: filePath, name, type };
    };

    // filesAをParallelFileEntry[]に変換
    if (filesA.length > 0) {
      const entriesA = filesA.map(convertToParallelEntry);
      const firstFilePath = (filesA[0] as FileWithPath).filePath || '';
      const folderPath = firstFilePath.substring(0, firstFilePath.lastIndexOf(/[/\\]/.test(firstFilePath) ? (firstFilePath.includes('\\') ? '\\' : '/') : '/')) || 'diff-mode';
      setParallelFolderA(folderPath);
      setParallelFilesA(entriesA);

      // 処理済み画像をキャッシュに追加
      pairs.forEach((pair) => {
        if (pair.processedA && pair.fileA) {
          const fileWithPath = pair.fileA as FileWithPath;
          if (fileWithPath.filePath) {
            const cacheKey = `${fileWithPath.filePath}:${maxWidth}x${maxHeight}`;
            setParallelImageCache(prev => ({
              ...prev,
              [cacheKey]: { dataUrl: pair.processedA!, width: 0, height: 0 },
            }));
          }
        }
      });
    }

    // filesBをParallelFileEntry[]に変換
    if (filesB.length > 0) {
      const entriesB = filesB.map(convertToParallelEntry);
      const firstFilePath = (filesB[0] as FileWithPath).filePath || '';
      const folderPath = firstFilePath.substring(0, firstFilePath.lastIndexOf(/[/\\]/.test(firstFilePath) ? (firstFilePath.includes('\\') ? '\\' : '/') : '/')) || 'diff-mode';
      setParallelFolderB(folderPath);
      setParallelFilesB(entriesB);

      // 処理済み画像をキャッシュに追加
      pairs.forEach((pair) => {
        if (pair.processedB && pair.fileB) {
          const fileWithPath = pair.fileB as FileWithPath;
          if (fileWithPath.filePath) {
            const cacheKey = `${fileWithPath.filePath}:${maxWidth}x${maxHeight}`;
            setParallelImageCache(prev => ({
              ...prev,
              [cacheKey]: { dataUrl: pair.processedB!, width: 0, height: 0 },
            }));
          }
        }
      });
    }

    // 現在選択中のインデックスを引き継ぐ
    setParallelCurrentIndex(selectedIndex);
    setParallelIndexA(selectedIndex);
    setParallelIndexB(selectedIndex);
  }, [filesA, filesB, pairs, selectedIndex, getParallelDisplaySize, compareMode, currentPage, diffCache]);

  // フォルダ選択
  const handleSelectParallelFolder = async (side: 'A' | 'B') => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: `フォルダ${side}を選択`,
      });

      if (selected && typeof selected === 'string') {
        // Rustでファイル一覧を取得
        const files = await invoke<string[]>('list_files_in_folder', {
          path: selected,
          extensions: ['tif', 'tiff', 'psd', 'png', 'jpg', 'jpeg', 'pdf'],
        });

        const entries: ParallelFileEntry[] = files.map(filePath => {
          const name = filePath.split(/[/\\]/).pop() || '';
          const ext = name.split('.').pop()?.toLowerCase() || '';
          let type: ParallelFileEntry['type'] = 'image';
          if (ext === 'tif' || ext === 'tiff') type = 'tiff';
          else if (ext === 'psd') type = 'psd';
          else if (ext === 'pdf') type = 'pdf';
          return { path: filePath, name, type };
        });

        if (side === 'A') {
          setParallelFolderA(selected);
          setParallelFilesA(entries);
        } else {
          setParallelFolderB(selected);
          setParallelFilesB(entries);
        }
        setParallelCurrentIndex(0);
      }
    } catch (err) {
      console.error('Folder selection error:', err);
    }
  };

  // PDFファイル選択（並列ビュー用）
  const handleSelectParallelPdf = async (side: 'A' | 'B') => {
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        title: `PDF${side}を選択`,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });

      if (selected && typeof selected === 'string') {
        await expandPdfToParallelEntries(selected, side);
      }
    } catch (err) {
      console.error('PDF selection error:', err);
    }
  };

  // PDFをページエントリに展開する
  const expandPdfToParallelEntries = async (pdfPath: string, side: 'A' | 'B', droppedFile?: File, forceSplitMode?: boolean) => {
    try {
      const fileName = pdfPath.split(/[/\\]/).pop() || 'PDF';

      // PDFページ数を取得
      let numPages: number;
      if (droppedFile) {
        // ドロップされたファイルのサイズチェック
        if (!checkPdfFileSize(droppedFile)) {
          return; // キャンセルされた場合は処理中断
        }
        const cached = await pdfCache.getDocument(droppedFile);
        numPages = cached.numPages;
      } else {
        // ファイルパスから読み込み
        const response = await tauriReadFile(pdfPath);
        const blob = new Blob([response.buffer], { type: 'application/pdf' });
        const file = new File([blob], fileName, { type: 'application/pdf' });
        // ファイルサイズチェック（100MB以上で警告）
        if (!checkPdfFileSize(file)) {
          return; // キャンセルされた場合は処理中断
        }
        const cached = await pdfCache.getDocument(file);
        numPages = cached.numPages;
        droppedFile = file;
      }

      // 各ページをエントリとして展開
      const entries: ParallelFileEntry[] = [];
      const splitMode = forceSplitMode !== undefined ? forceSplitMode : (side === 'A' ? spreadSplitModeA : spreadSplitModeB);
      const firstSingle = side === 'A' ? firstPageSingleA : firstPageSingleB;
      for (let page = 1; page <= numPages; page++) {
        if (splitMode) {
          // 見開き分割モード
          const isFirstPage = page === 1;
          if (isFirstPage && firstSingle) {
            // 1ページ目を単ページ扱い
            entries.push({
              path: pdfPath,
              name: `${fileName} (P.${page}/${numPages})`,
              type: 'pdf',
              pageCount: numPages,
              pdfPage: page,
              pdfFile: droppedFile,
            });
          } else {
            // 見開きを分割（右から読み: right→left）
            entries.push({
              path: pdfPath,
              name: `${fileName} (P.${page}右/${numPages})`,
              type: 'pdf',
              pageCount: numPages,
              pdfPage: page,
              pdfFile: droppedFile,
              spreadSide: 'right',
            });
            entries.push({
              path: pdfPath,
              name: `${fileName} (P.${page}左/${numPages})`,
              type: 'pdf',
              pageCount: numPages,
              pdfPage: page,
              pdfFile: droppedFile,
              spreadSide: 'left',
            });
          }
        } else {
          // 通常モード
          entries.push({
            path: pdfPath,
            name: `${fileName} (P.${page}/${numPages})`,
            type: 'pdf',
            pageCount: numPages,
            pdfPage: page,
            pdfFile: droppedFile,
          });
        }
      }

      if (side === 'A') {
        setParallelFolderA(pdfPath);
        setParallelFilesA(entries);
      } else {
        setParallelFolderB(pdfPath);
        setParallelFilesB(entries);
      }
      setParallelCurrentIndex(0);
    } catch (err) {
      console.error('PDF expansion error:', err);
    }
  };

  // 並列ビューモードでのドロップ処理
  const handleParallelDrop = async (e: React.DragEvent, side: 'A' | 'B') => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverSide(null);

    const items = e.dataTransfer.items;
    const files = Array.from(e.dataTransfer.files);

    // webkitGetAsEntryでディレクトリかどうかを判定
    if (items.length > 0) {
      const firstItem = items[0];
      const entry = firstItem.webkitGetAsEntry?.();

      if (entry?.isDirectory) {
        // フォルダがドロップされた場合
        // Tauriではファイルオブジェクトのpathプロパティからパスを取得
        const file = files[0] as File & { path?: string };
        if (file?.path) {
          await expandFolderToParallelEntries(file.path, side);
          return;
        }
      }
    }

    // ファイルがドロップされた場合
    if (files.length > 0) {
      const file = files[0] as File & { path?: string };
      const fileName = file.name;
      const ext = fileName.split('.').pop()?.toLowerCase() || '';

      if (ext === 'pdf') {
        // PDFファイルのサイズチェック（100MB以上で警告）
        if (!checkPdfFileSize(file)) {
          return; // キャンセルされた場合は処理中断
        }
        // Tauriの場合は実際のファイルパスを使用、ブラウザの場合は疑似パス
        const pdfPath = file.path || `dropped:${fileName}`;
        await expandPdfToParallelEntries(pdfPath, side, file);
      } else if (['tif', 'tiff', 'psd', 'png', 'jpg', 'jpeg'].includes(ext)) {
        // 画像ファイルの場合は単一エントリとして追加
        let type: ParallelFileEntry['type'] = 'image';
        if (ext === 'tif' || ext === 'tiff') type = 'tiff';
        else if (ext === 'psd') type = 'psd';

        // Tauriの場合はpathプロパティを使用、ブラウザの場合はObjectURLを作成
        const filePath = file.path || URL.createObjectURL(file);
        const entry: ParallelFileEntry = { path: filePath, name: fileName, type };

        if (side === 'A') {
          setParallelFolderA(filePath);
          setParallelFilesA([entry]);
        } else {
          setParallelFolderB(filePath);
          setParallelFilesB([entry]);
        }
        setParallelCurrentIndex(0);
        setParallelIndexA(0);
        setParallelIndexB(0);
      }
    }
  };

  // フォルダをエントリに展開
  const expandFolderToParallelEntries = async (folderPath: string, side: 'A' | 'B') => {
    try {
      const files = await invoke<string[]>('list_files_in_folder', {
        path: folderPath,
        extensions: ['tif', 'tiff', 'psd', 'png', 'jpg', 'jpeg', 'pdf'],
      });

      const entries: ParallelFileEntry[] = files.map(filePath => {
        const name = filePath.split(/[/\\]/).pop() || '';
        const ext = name.split('.').pop()?.toLowerCase() || '';
        let type: ParallelFileEntry['type'] = 'image';
        if (ext === 'tif' || ext === 'tiff') type = 'tiff';
        else if (ext === 'psd') type = 'psd';
        else if (ext === 'pdf') type = 'pdf';
        return { path: filePath, name, type };
      });

      if (side === 'A') {
        setParallelFolderA(folderPath);
        setParallelFilesA(entries);
      } else {
        setParallelFolderB(folderPath);
        setParallelFilesB(entries);
      }
      setParallelCurrentIndex(0);
    } catch (err) {
      console.error('Folder expansion error:', err);
    }
  };

  // 並列ビューモードの画像読み込み
  const loadParallelImages = useCallback(async (skipCache: boolean = false) => {
    if (appMode !== 'parallel-view') return;

    // 常に個別インデックスを使用（同期モードでも両方のインデックスは同時に更新される）
    const fileA = parallelFilesA[parallelIndexA];
    const fileB = parallelFilesB[parallelIndexB];

    if (!fileA && !fileB) {
      setParallelImageA(null);
      setParallelImageB(null);
      return;
    }

    setParallelLoading(true);
    const { maxWidth, maxHeight } = getParallelDisplaySize();

    try {
      // 両方の画像を並列で読み込み
      const [imageA, imageB] = await Promise.all([
        fileA ? loadSingleParallelImage(fileA, maxWidth, maxHeight, skipCache) : null,
        fileB ? loadSingleParallelImage(fileB, maxWidth, maxHeight, skipCache) : null,
      ]);

      setParallelImageA(imageA);
      setParallelImageB(imageB);

      // 先読み（前後5件）
      preloadParallelImages(Math.max(parallelIndexA, parallelIndexB), maxWidth, maxHeight);
    } catch (err) {
      console.error('Parallel image load error:', err);
    }

    setParallelLoading(false);
  }, [appMode, parallelFilesA, parallelFilesB, parallelIndexA, parallelIndexB, getParallelDisplaySize]);

  // 単一画像の読み込み
  const loadSingleParallelImage = async (
    entry: ParallelFileEntry,
    maxWidth: number,
    maxHeight: number,
    skipCache: boolean = false
  ): Promise<string | null> => {
    // PDFの場合はページ番号とspreadSideもキーに含める
    const spreadSuffix = entry.spreadSide ? `:${entry.spreadSide}` : '';
    const cacheKey = entry.type === 'pdf' && entry.pdfPage
      ? `${entry.path}:page${entry.pdfPage}${spreadSuffix}:${maxWidth}x${maxHeight}`
      : `${entry.path}:${maxWidth}x${maxHeight}`;

    // PDF/image(JPEG/PNG)は更新処理をスキップ（キャッシュがあれば使用）
    const shouldSkipRefresh = entry.type === 'pdf' || entry.type === 'image';
    const useCache = !skipCache || shouldSkipRefresh;

    // フロントエンドキャッシュチェック
    if (useCache && parallelImageCache[cacheKey]) {
      return parallelImageCache[cacheKey].dataUrl;
    }

    try {
      if (entry.type === 'pdf' && entry.pdfFile && entry.pdfPage) {
        // PDFページのレンダリング（見開き分割対応）
        let dataUrl: string | null;
        if (entry.spreadSide) {
          // 見開き分割モード
          const bitmapEntry = await pdfCache.renderSplitPageBitmap(entry.pdfFile, entry.pdfPage, entry.spreadSide);
          if (!bitmapEntry) return null;
          // ImageBitmapからDataURLを生成
          const canvas = document.createElement('canvas');
          canvas.width = bitmapEntry.width;
          canvas.height = bitmapEntry.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;
          ctx.drawImage(bitmapEntry.bitmap, 0, 0);
          dataUrl = canvas.toDataURL('image/png');
          canvas.width = 0;
          canvas.height = 0;
        } else {
          dataUrl = await pdfCache.renderPage(entry.pdfFile, entry.pdfPage);
        }
        if (!dataUrl) return null;

        setParallelImageCache(prev => ({
          ...prev,
          [cacheKey]: { dataUrl, width: 0, height: 0 }, // サイズは後で取得可能
        }));
        return dataUrl;
      } else if (entry.type === 'psd') {
        // PSDはTypeScript側で処理（Rust PSDに問題があるため）
        const response = await tauriReadFile(entry.path);
        const buffer = response.buffer;
        const { canvas } = await parsePsdToCanvas(buffer);
        const dataUrl = canvas.toDataURL('image/png');

        setParallelImageCache(prev => ({
          ...prev,
          [cacheKey]: { dataUrl, width: canvas.width, height: canvas.height },
        }));
        return dataUrl;
      } else {
        // TIFF/PNG/JPGはRust側で高速処理
        const result = await invoke<{
          data_url: string;
          width: number;
          height: number;
        }>('decode_and_resize_image', {
          path: entry.path,
          maxWidth,
          maxHeight,
        });

        setParallelImageCache(prev => ({
          ...prev,
          [cacheKey]: { dataUrl: result.data_url, width: result.width, height: result.height },
        }));
        return result.data_url;
      }
    } catch (err) {
      console.error('Image load error:', entry.path, err);
      return null;
    }
  };

  // 先読み処理（PSD対応 + 並列化）
  const preloadParallelImages = useCallback(async (
    currentIdx: number,
    maxWidth: number,
    maxHeight: number,
    filesA: ParallelFileEntry[] = parallelFilesA,
    filesB: ParallelFileEntry[] = parallelFilesB
  ) => {
    const preloadRange = 5;
    const pathsToPreload: string[] = [];
    const psdEntriesToPreload: ParallelFileEntry[] = [];

    for (let offset = 1; offset <= preloadRange; offset++) {
      const nextIdx = currentIdx + offset;
      const prevIdx = currentIdx - offset;

      // A側
      if (nextIdx < filesA.length) {
        const entry = filesA[nextIdx];
        if (entry.type === 'psd') {
          psdEntriesToPreload.push(entry);
        } else if (entry.type !== 'pdf') {
          pathsToPreload.push(entry.path);
        }
      }
      if (prevIdx >= 0) {
        const entry = filesA[prevIdx];
        if (entry.type === 'psd') {
          psdEntriesToPreload.push(entry);
        } else if (entry.type !== 'pdf') {
          pathsToPreload.push(entry.path);
        }
      }

      // B側
      if (nextIdx < filesB.length) {
        const entry = filesB[nextIdx];
        if (entry.type === 'psd') {
          psdEntriesToPreload.push(entry);
        } else if (entry.type !== 'pdf') {
          pathsToPreload.push(entry.path);
        }
      }
      if (prevIdx >= 0) {
        const entry = filesB[prevIdx];
        if (entry.type === 'psd') {
          psdEntriesToPreload.push(entry);
        } else if (entry.type !== 'pdf') {
          pathsToPreload.push(entry.path);
        }
      }
    }

    // TIFF/PNG/JPGをRust側で並列先読み
    if (pathsToPreload.length > 0) {
      invoke('preload_images', { paths: pathsToPreload, maxWidth, maxHeight }).catch(console.error);
    }

    // PSDをTypeScript側で先読み（バックグラウンド）
    if (psdEntriesToPreload.length > 0) {
      // 重複除去
      const uniquePsdPaths = [...new Set(psdEntriesToPreload.map(e => e.path))];
      for (const path of uniquePsdPaths) {
        const cacheKey = `${path}:${maxWidth}x${maxHeight}`;
        // 既にキャッシュにあればスキップ
        if (parallelImageCache[cacheKey]) continue;

        // バックグラウンドで先読み（awaitしない）
        (async () => {
          try {
            const response = await tauriReadFile(path);
            const { canvas } = await parsePsdToCanvas(response.buffer);
            const dataUrl = canvas.toDataURL('image/png');
            setParallelImageCache(prev => ({
              ...prev,
              [cacheKey]: { dataUrl, width: canvas.width, height: canvas.height },
            }));
          } catch (err) {
            console.error('PSD preload error:', path, err);
          }
        })();
      }
    }
  }, [parallelFilesA, parallelFilesB, parallelImageCache]);

  // フォルダ/PDF読み込み直後に先読みを即座に開始
  useEffect(() => {
    if (appMode !== 'parallel-view') return;
    if (parallelFilesA.length === 0 && parallelFilesB.length === 0) return;

    const { maxWidth, maxHeight } = getParallelDisplaySize();
    // 現在位置から前後の画像を先読み
    preloadParallelImages(
      Math.max(parallelIndexA, parallelIndexB),
      maxWidth,
      maxHeight,
      parallelFilesA,
      parallelFilesB
    );
  }, [parallelFilesA, parallelFilesB]); // ファイルリスト変更時のみ発火

  // 並列ビューのインデックス変更時に画像を読み込み
  useEffect(() => {
    if (appMode === 'parallel-view') {
      loadParallelImages();
    }
  }, [appMode, parallelIndexA, parallelIndexB, loadParallelImages]);

  // 並列ビュークリア
  const clearParallelView = () => {
    setParallelFolderA(null);
    setParallelFolderB(null);
    setParallelFilesA([]);
    setParallelFilesB([]);
    setParallelCurrentIndex(0);
    setParallelIndexA(0);
    setParallelIndexB(0);
    setParallelSyncMode(true);
    setParallelActivePanel('A');
    setParallelImageA(null);
    setParallelImageB(null);
    setParallelImageCache({});
    setParallelCapturedImageA(null);
    setParallelCapturedImageB(null);
    pdfCache.clear(); // PDFキャッシュもクリア
    invoke('clear_image_cache').catch(console.error);
  };

  // 差分モード更新（フォルダ再スキャン＋キャッシュクリア＋再処理）
  const refreshDiffMode = useCallback(async () => {
    if (appMode !== 'diff-check') return;

    // キャッシュクリア
    pdfCache.clear();
    setDiffCache({});
    invoke('clear_image_cache').catch(console.error);

    // フォルダパスが保存されている場合、フォルダを再スキャンしてファイルを更新
    const extensionsA = getAcceptedExtensions('A').map(e => e.replace('.', ''));
    const extensionsB = getAcceptedExtensions('B').map(e => e.replace('.', ''));

    try {
      // フォルダAを再スキャン
      if (diffFolderA) {
        const filePathsA = await invoke<string[]>('list_files_in_folder', {
          path: diffFolderA,
          extensions: extensionsA,
        });
        const filesFromA = await readFilesFromPaths(filePathsA);
        const filteredA = filesFromA.filter(f => isAcceptedFile(f, 'A'));
        setFilesA(filteredA.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })));
      }

      // フォルダBを再スキャン
      if (diffFolderB) {
        const filePathsB = await invoke<string[]>('list_files_in_folder', {
          path: diffFolderB,
          extensions: extensionsB,
        });
        const filesFromB = await readFilesFromPaths(filePathsB);
        const filteredB = filesFromB.filter(f => isAcceptedFile(f, 'B'));
        setFilesB(filteredB.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })));
      }
    } catch (err) {
      console.error('Folder rescan error:', err);
    }

    // フォルダが設定されていない場合（従来の動作）は現在のペアを再処理
    if (!diffFolderA && !diffFolderB) {
      const pair = pairs[selectedIndex];
      if (!pair || !pair.fileA || !pair.fileB) return;

      // 現在のペアをpending状態に戻して再処理
      setPairs(prev => {
        const next = [...prev];
        next[selectedIndex] = { ...next[selectedIndex], status: 'pending' };
        return next;
      });
    }
  }, [appMode, pairs, selectedIndex, diffFolderA, diffFolderB, getAcceptedExtensions, readFilesFromPaths, isAcceptedFile]);

  // パラレルビュー更新（キャッシュクリア＋再読み込み）
  const refreshParallelView = useCallback(() => {
    if (appMode !== 'parallel-view') return;
    if (parallelFilesA.length === 0 && parallelFilesB.length === 0) return;

    // キャッシュクリア
    setParallelImageCache({});
    pdfCache.clear();
    invoke('clear_image_cache').catch(console.error);

    // 画像を再読み込み（キャッシュをスキップ）
    loadParallelImages(true);
  }, [appMode, parallelFilesA.length, parallelFilesB.length, loadParallelImages]);

  // MojiQ起動前のメモリ解放（重いPDFでのOut of Memoryエラー対策）
  const releaseMemoryBeforeMojiQ = useCallback(() => {
    // PDFキャッシュをクリア
    pdfCache.clear();
    // diffキャッシュをクリア
    setDiffCache({});
    // 並列ビューのイメージキャッシュをクリア
    setParallelImageCache({});
    // Rust側のイメージキャッシュをクリア
    invoke('clear_image_cache').catch(console.error);
  }, []);

  // ============== フォルダを開く機能 ==============
  // ファイルパスから親フォルダパスを取得
  const getDirectoryFromPath = (filePath: string): string | null => {
    const parts = filePath.split(/[/\\]/);
    if (parts.length < 2) return null;
    parts.pop();
    return parts.join('\\');
  };

  // 差分モード: フォルダパスを取得
  const getDiffFolderPath = useCallback((side: 'A' | 'B'): string | null => {
    const files = side === 'A' ? filesA : filesB;
    if (files.length === 0) return null;
    const firstFile = files[0] as FileWithPath;
    if (!firstFile.filePath) return null;
    return getDirectoryFromPath(firstFile.filePath);
  }, [filesA, filesB]);

  // ダブルビューワー: フォルダパスを取得
  const getParallelFolderPath = useCallback((side: 'A' | 'B'): string | null => {
    const folderPath = side === 'A' ? parallelFolderA : parallelFolderB;
    const files = side === 'A' ? parallelFilesA : parallelFilesB;
    if (!folderPath) return null;
    // PDFの場合はファイルパスなので親フォルダを取得
    if (files.length > 0 && files[0].type === 'pdf') {
      return getDirectoryFromPath(folderPath);
    }
    return folderPath;
  }, [parallelFolderA, parallelFolderB, parallelFilesA, parallelFilesB]);

  // フォルダを開く
  const openFolderInExplorer = useCallback(async (folderPath: string | null) => {
    if (!folderPath) return;
    try {
      await invoke('open_folder', { path: folderPath });
    } catch (err) {
      console.error('Failed to open folder:', err);
    }
  }, []);

  // 全画面切り替え時のズームアニメーション（MojiQ方式）
  const animateFullscreenZoom = useCallback((entering: boolean) => {
    const duration = 300; // 300ms
    const startTime = performance.now();
    const startScale = entering ? 0.92 : 1.08;
    const endScale = 1;

    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const easedProgress = easeOutCubic(progress);
      const currentScale = startScale + (endScale - startScale) * easedProgress;

      // コンテンツエリアにscaleを適用
      const content = document.querySelector('.fullscreen-zoom-target');
      if (content) {
        (content as HTMLElement).style.transform = `scale(${currentScale})`;
      }

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        // アニメーション完了後にtransformをリセット
        if (content) {
          (content as HTMLElement).style.transform = '';
        }
      }
    };

    requestAnimationFrame(animate);
  }, []);

  // 全画面トグル
  const toggleFullscreen = useCallback(async () => {
    const window = getCurrentWebviewWindow();
    const current = await window.isFullscreen();
    const goingFullscreen = !current;

    // アニメーション開始
    animateFullscreenZoom(goingFullscreen);

    // 全画面切り替え実行
    await window.setFullscreen(goingFullscreen);
    setIsFullscreen(goingFullscreen);

    // 全画面に入った時にヒントを表示
    if (goingFullscreen) {
      setShowFullscreenHint(true);
      setTimeout(() => setShowFullscreenHint(false), 3000);
    }

  }, [animateFullscreenZoom]);

  // 並列ビューの最大ページ数
  const parallelMaxIndex = Math.max(parallelFilesA.length, parallelFilesB.length) - 1;

  // キーボード操作
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // ScreenshotEditor（指示エディタ）が開いている場合は、そちらでキーイベントを処理させる
      if (capturedImage || parallelCapturedImageA || parallelCapturedImageB) {
        return;
      }

      // Ctrl+Q: アプリ終了
      if (e.code === 'KeyQ' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        getCurrentWebviewWindow().close();
        return;
      }

      // Ctrl+W: 開いているフォルダをクリア
      if (e.code === 'KeyW' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (appMode === 'diff-check') {
          setFilesA([]);
          setFilesB([]);
          setPairs([]);
          setCropBounds(null);
          setPreloadProgress({ loaded: 0, total: 0 });
          pdfCache.clear();
        } else {
          clearParallelView();
        }
        return;
      }

      // F11キー: 全画面トグル
      if (e.code === 'F11') {
        e.preventDefault();
        toggleFullscreen();
        return;
      }

      // Escapeキー: 全画面解除
      if (e.code === 'Escape' && isFullscreen) {
        e.preventDefault();
        toggleFullscreen();
        return;
      }

      // F5キー: 更新（キャッシュクリア＋再読み込み）※PDFモードでは無効
      if (e.code === 'F5') {
        e.preventDefault();
        if (appMode === 'diff-check' && compareMode !== 'pdf-pdf') {
          refreshDiffMode();
        } else if (appMode === 'parallel-view') {
          refreshParallelView();
        }
        return;
      }

      // Vキー: モード切り替え
      if (e.code === 'KeyV' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (appMode === 'diff-check') {
          // 差分モードから並列ビューモードへ切り替え時に状態を引き継ぐ
          transferDiffToParallelView();
          setAppMode('parallel-view');
        } else {
          setAppMode('diff-check');
          setInitialModeSelect(false);
        }
        return;
      }

      // 並列ビューモードのキー操作
      if (appMode === 'parallel-view') {
        // Sキー: 同期/非同期モード切り替え
        if (e.code === 'KeyS' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          if (parallelSyncMode) {
            // 同期→非同期: インデックスはそのまま維持
            setParallelSyncMode(false);
          } else {
            if (e.shiftKey) {
              // Shift+S: 元に戻して再同期（小さい方に合わせる）
              const minIndex = Math.min(parallelIndexA, parallelIndexB);
              setParallelIndexA(minIndex);
              setParallelIndexB(minIndex);
            }
            // S: 現ページで再同期（インデックス維持）
            setParallelSyncMode(true);
          }
          return;
        }
        // 非同期モードでTab/←→でアクティブパネル切り替え
        if (!parallelSyncMode && (e.code === 'Tab' || e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
          e.preventDefault();
          setParallelActivePanel(prev => prev === 'A' ? 'B' : 'A');
          return;
        }
        const maxIndexA = parallelFilesA.length - 1;
        const maxIndexB = parallelFilesB.length - 1;
        if (e.code === 'ArrowDown') {
          e.preventDefault();
          if (parallelSyncMode) {
            // 同期モード: 両方のインデックスを同時に変更
            setParallelIndexA(prev => Math.min(prev + 1, maxIndexA));
            setParallelIndexB(prev => Math.min(prev + 1, maxIndexB));
          } else {
            // 非同期モード: ページめくり時にズームをリセット
            if (parallelActivePanel === 'A') {
              setParallelIndexA(prev => Math.min(prev + 1, maxIndexA));
              setParallelZoomA(1);
              setParallelPanA({ x: 0, y: 0 });
            } else {
              setParallelIndexB(prev => Math.min(prev + 1, maxIndexB));
              setParallelZoomB(1);
              setParallelPanB({ x: 0, y: 0 });
            }
          }
          return;
        }
        if (e.code === 'ArrowUp') {
          e.preventDefault();
          if (parallelSyncMode) {
            // 同期モード: 両方のインデックスを同時に変更
            setParallelIndexA(prev => Math.max(prev - 1, 0));
            setParallelIndexB(prev => Math.max(prev - 1, 0));
          } else {
            // 非同期モード: ページめくり時にズームをリセット
            if (parallelActivePanel === 'A') {
              setParallelIndexA(prev => Math.max(prev - 1, 0));
              setParallelZoomA(1);
              setParallelPanA({ x: 0, y: 0 });
            } else {
              setParallelIndexB(prev => Math.max(prev - 1, 0));
              setParallelZoomB(1);
              setParallelPanB({ x: 0, y: 0 });
            }
          }
          return;
        }
        if (e.code === 'Home') {
          e.preventDefault();
          if (parallelSyncMode) {
            // 同期モード: 両方のインデックスを同時に変更
            setParallelIndexA(0);
            setParallelIndexB(0);
          } else {
            // 非同期モード: ページめくり時にズームをリセット
            if (parallelActivePanel === 'A') {
              setParallelIndexA(0);
              setParallelZoomA(1);
              setParallelPanA({ x: 0, y: 0 });
            } else {
              setParallelIndexB(0);
              setParallelZoomB(1);
              setParallelPanB({ x: 0, y: 0 });
            }
          }
          return;
        }
        if (e.code === 'End') {
          e.preventDefault();
          if (parallelSyncMode) {
            // 同期モード: 両方のインデックスを同時に変更
            setParallelIndexA(maxIndexA);
            setParallelIndexB(maxIndexB);
          } else {
            // 非同期モード: ページめくり時にズームをリセット
            if (parallelActivePanel === 'A') {
              setParallelIndexA(maxIndexA);
              setParallelZoomA(1);
              setParallelPanA({ x: 0, y: 0 });
            } else {
              setParallelIndexB(maxIndexB);
              setParallelZoomB(1);
              setParallelPanB({ x: 0, y: 0 });
            }
          }
          return;
        }
        // Cキー: 指示エディタを開く
        if (e.code === 'KeyC') {
          e.preventDefault();
          if (parallelSyncMode) {
            // 同期モード: アクティブパネルの画像を開く
            if (parallelActivePanel === 'A' && parallelImageA) {
              setParallelCapturedImageA(parallelImageA);
            } else if (parallelActivePanel === 'B' && parallelImageB) {
              setParallelCapturedImageB(parallelImageB);
            }
          } else {
            // 非同期モード: アクティブパネルの画像を開く
            if (parallelActivePanel === 'A' && parallelImageA) {
              setParallelCapturedImageA(parallelImageA);
            } else if (parallelActivePanel === 'B' && parallelImageB) {
              setParallelCapturedImageB(parallelImageB);
            }
          }
          return;
        }
        // Pキー: Photoshopで開く
        if (e.code === 'KeyP') {
          const fileA = parallelFilesA[parallelIndexA];
          const fileB = parallelFilesB[parallelIndexB];
          const hasPsdA = fileA?.type === 'psd';
          const hasPsdB = fileB?.type === 'psd';

          if (!hasPsdA && !hasPsdB) return;

          e.preventDefault();
          if (!parallelSyncMode) {
            // 非同期モード: アクティブパネル側を直接開く
            const file = parallelActivePanel === 'A' ? fileA : fileB;
            if (file?.type === 'psd') {
              invoke('open_file_with_default_app', { path: file.path });
            }
          } else {
            // 同期モード: ポップアップ表示
            setShowPsSelectPopup(true);
          }
          return;
        }
        // Qキー: MojiQでPDFを開く
        if (e.code === 'KeyQ') {
          const fileA = parallelFilesA[parallelIndexA];
          const fileB = parallelFilesB[parallelIndexB];
          const hasPdfA = fileA?.type === 'pdf';
          const hasPdfB = fileB?.type === 'pdf';

          if (!hasPdfA && !hasPdfB) return;

          e.preventDefault();
          // 非同期モードまたは片方のみPDFの場合は直接開く
          if (!parallelSyncMode || !(hasPdfA && hasPdfB)) {
            const file = parallelActivePanel === 'A' ? fileA : fileB;
            if (file?.type === 'pdf') {
              releaseMemoryBeforeMojiQ();
              setTimeout(() => invoke('open_pdf_in_mojiq', { pdfPath: file.path, page: file.pdfPage || 1 }), 100);
            }
          } else {
            // 同期モードで両方PDFの場合はポップアップ
            setShowMojiQSelectPopup(!showMojiQSelectPopup);
          }
          return;
        }
        // Ctrl+/-/0/;: 非同期モードでのズーム操作
        if (e.ctrlKey && !parallelSyncMode) {
          if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.code === 'Semicolon' || e.key === ';') {
            e.preventDefault();
            if (parallelActivePanel === 'A') {
              setParallelZoomA(z => Math.min(5, z * 1.25));
            } else {
              setParallelZoomB(z => Math.min(5, z * 1.25));
            }
            return;
          } else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
            e.preventDefault();
            if (parallelActivePanel === 'A') {
              setParallelZoomA(z => Math.max(0.1, z / 1.25));
            } else {
              setParallelZoomB(z => Math.max(0.1, z / 1.25));
            }
            return;
          } else if (e.code === 'Digit0' || e.code === 'Numpad0') {
            e.preventDefault();
            if (parallelActivePanel === 'A') {
              setParallelZoomA(1);
              setParallelPanA({ x: 0, y: 0 });
            } else {
              setParallelZoomB(1);
              setParallelPanB({ x: 0, y: 0 });
            }
            return;
          }
        }
        return; // 並列ビューモードでは他のキーは無視
      }

      // 検版モードのキー操作
      if (e.code === 'Space' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setViewMode(prev => prev === 'diff' ? 'A' : 'diff');
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        setViewMode(prev => prev === 'diff' ? 'A' : prev === 'A' ? 'B' : 'A');
      }
      // PDF-PDFモードでは上下キーでページ移動
      if (compareMode === 'pdf-pdf' && pairs[selectedIndex]?.status === 'done') {
        const totalPages = pairs[selectedIndex]?.totalPages || 1;
        if (e.code === 'ArrowDown') { e.preventDefault(); setCurrentPage(prev => Math.min(prev + 1, totalPages)); return; }
        if (e.code === 'ArrowUp') { e.preventDefault(); setCurrentPage(prev => Math.max(prev - 1, 1)); return; }
      }
      // その他のモードでは上下キーでファイル選択
      if (e.code === 'ArrowDown') { e.preventDefault(); setSelectedIndex(prev => Math.min(prev + 1, pairs.length - 1)); }
      if (e.code === 'ArrowUp') { e.preventDefault(); setSelectedIndex(prev => Math.max(prev - 1, 0)); }
      // Pキー: PSDモードでPhotoshopで開く
      if (e.code === 'KeyP' && (compareMode === 'psd-psd' || compareMode === 'psd-tiff')) {
        const currentPair = pairs[selectedIndex];
        if (!currentPair) return;
        let psdFile: FileWithPath | null = null;
        if (viewMode === 'A' || viewMode === 'A-full') {
          psdFile = currentPair.fileA as FileWithPath | null;
        } else if (viewMode === 'B' && compareMode === 'psd-psd') {
          psdFile = currentPair.fileB as FileWithPath | null;
        }
        if (psdFile?.filePath && psdFile.name.toLowerCase().endsWith('.psd')) {
          e.preventDefault();
          invoke('open_file_with_default_app', { path: psdFile.filePath });
        }
      }
      // Qキー: PDF-PDFモードでMojiQで開く
      if (e.code === 'KeyQ' && compareMode === 'pdf-pdf') {
        const currentPair = pairs[selectedIndex];
        if (!currentPair || currentPair.status !== 'done') return;
        let pdfFile: FileWithPath | null = null;
        if (viewMode === 'A' || viewMode === 'A-full' || viewMode === 'diff') {
          pdfFile = currentPair.fileA as FileWithPath | null;
        } else if (viewMode === 'B') {
          pdfFile = currentPair.fileB as FileWithPath | null;
        }
        if (pdfFile?.filePath && pdfFile.name.toLowerCase().endsWith('.pdf')) {
          e.preventDefault();
          releaseMemoryBeforeMojiQ();
          setTimeout(() => invoke('open_pdf_in_mojiq', { pdfPath: pdfFile.filePath, page: currentPage }), 100);
        }
      }
      // Cキー: 修正指示モード（即座にScreenshotEditorを開く）
      if (e.code === 'KeyC' && pairs[selectedIndex]?.status === 'done') {
        e.preventDefault();
        const displayImg = (() => {
          const pair = pairs[selectedIndex];
          if (!pair) return null;
          if (viewMode === 'diff') {
            if (pair.diffSrcWithMarkers) return pair.diffSrcWithMarkers;
            return pair.diffSrc;
          }
          if (viewMode === 'B') return pair.processedB;
          if (viewMode === 'A-full') return pair.srcA;
          return pair.processedA;
        })();
        if (displayImg) {
          setCapturedImage(displayImg);
        }
      }
      // Ctrl+/-/0/;: ズーム操作（検版モード）
      if (e.ctrlKey) {
        if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.code === 'Semicolon' || e.key === ';') {
          e.preventDefault();
          setZoom(z => Math.min(5, z * 1.25));
        } else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
          e.preventDefault();
          setZoom(z => Math.max(0.1, z / 1.25));
        } else if (e.code === 'Digit0' || e.code === 'Numpad0') {
          e.preventDefault();
          setZoom(1);
          setPanPosition({ x: 0, y: 0 });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pairs, selectedIndex, compareMode, viewMode, appMode, parallelMaxIndex, parallelSyncMode, parallelActivePanel, parallelCurrentIndex, parallelIndexA, parallelIndexB, parallelFilesA, parallelFilesB, parallelImageA, parallelImageB, transferDiffToParallelView, capturedImage, parallelCapturedImageA, parallelCapturedImageB, refreshDiffMode, refreshParallelView, toggleFullscreen, isFullscreen, clearParallelView]);

  // 表示画像取得
  const currentPair = pairs[selectedIndex];

  const getCurrentMarkers = () => {
    if (!currentPair || currentPair.status !== 'done') return [];
    if (compareMode === 'pdf-pdf') {
      const cacheKey = `${selectedIndex}-${currentPage}`;
      const pageData = diffCache[cacheKey];
      return pageData?.markers || currentPair.markers || [];
    }
    return currentPair.markers || [];
  };

  const currentMarkers = getCurrentMarkers();

  const getDiffImage = () => {
    if (!currentPair) return null;
    if (showMarkers && currentPair.diffSrcWithMarkers) return currentPair.diffSrcWithMarkers;
    return currentPair.diffSrc;
  };

  const getDisplayImage = (): string | null => {
    if (!currentPair || currentPair.status !== 'done') return null;

    if (compareMode === 'pdf-pdf') {
      const cacheKey = `${selectedIndex}-${currentPage}`;
      const pageData = diffCache[cacheKey];
      if (!pageData && currentPage === 1) {
        if (viewMode === 'A') return currentPair.processedA;
        if (viewMode === 'B') return currentPair.processedB;
        return showMarkers && currentPair.diffSrcWithMarkers ? currentPair.diffSrcWithMarkers : currentPair.diffSrc;
      }
      if (!pageData) return null;
      if (viewMode === 'A') return pageData.srcA;
      if (viewMode === 'B') return pageData.srcB;
      return showMarkers && pageData.diffSrcWithMarkers ? pageData.diffSrcWithMarkers : pageData.diffSrc;
    }

    if (viewMode === 'A') return currentPair.processedA;
    if (viewMode === 'A-full') return currentPair.srcA;
    if (viewMode === 'B') return currentPair.processedB;
    return getDiffImage();
  };

  const filteredPairs = filterDiffOnly ? pairs.filter(p => p.status === 'done' && p.hasDiff) : pairs;

  const stats = {
    total: pairs.length,
    done: pairs.filter(p => p.status === 'done').length,
    diff: pairs.filter(p => p.status === 'done' && p.hasDiff).length,
    pending: pairs.filter(p => p.status === 'pending' && p.fileA && p.fileB).length
  };

  return (
    <div className="h-screen flex flex-col bg-neutral-900 text-white font-sans select-none fullscreen-zoom-target">
      {/* PDF最適化進捗オーバーレイ（MojiQと同じスタイル） */}
      {optimizeProgress && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-neutral-800 rounded-lg p-6 shadow-xl border border-neutral-600 min-w-96">
            <div className="flex items-center gap-3 mb-4">
              <Loader2 className="animate-spin text-orange-400" size={24} />
              <span className="text-lg font-semibold">{optimizeProgress.message}</span>
            </div>
            <div className="text-sm text-neutral-400 mb-3 truncate" title={optimizeProgress.fileName}>
              {optimizeProgress.fileName}
            </div>
            {/* プログレスバー */}
            {optimizeProgress.total !== undefined && optimizeProgress.total > 0 && (
              <>
                <div className="w-full h-2 bg-neutral-700 rounded-full overflow-hidden mb-2">
                  <div
                    className="h-full bg-orange-400 transition-all duration-150"
                    style={{ width: `${((optimizeProgress.current || 0) / optimizeProgress.total) * 100}%` }}
                  />
                </div>
                <div className="text-sm text-neutral-300 text-center">
                  {optimizeProgress.current || 0} / {optimizeProgress.total} ページ
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {/* Header */}
      {!isFullscreen && (
      <div className="h-10 bg-neutral-950 border-b border-neutral-800 flex items-center px-4 gap-4 shrink-0">
        <button
          onClick={() => {
            // 初期画面に戻る
            setSidebarCollapsed(true);
            setInitialModeSelect(true);
            setAppMode('diff-check');
            setFilesA([]);
            setFilesB([]);
            setPairs([]);
            setCropBounds(null);
            setPreloadProgress({ loaded: 0, total: 0 });
            setParallelFilesA([]);
            setParallelFilesB([]);
            setParallelFolderA(null);
            setParallelFolderB(null);
            setDiffCache({});
            pdfCache.clear();
          }}
          className="text-sm font-bold flex items-center gap-2 hover:text-orange-300 transition-colors"
          title="初期画面に戻る"
        >
          <Layers size={18} className="text-orange-400" />
          漫画差分検出
        </button>
        <div className="flex-1" />
        <span className="text-xs px-2 py-0.5 rounded bg-green-900/50 text-green-300">
          Ready
        </span>
      </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* Sidebar */}
        {!isFullscreen && (
        <div className={`${sidebarCollapsed ? 'w-10' : 'w-72'} bg-neutral-800 border-r border-neutral-700 flex flex-col shrink-0 transition-all duration-200`}>
          {/* 折りたたみボタン */}
          <div className={`flex items-center border-b border-neutral-700 ${sidebarCollapsed ? 'justify-center p-2' : 'justify-end px-2 py-1'}`}>
            <button
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="p-1.5 text-neutral-400 hover:text-white hover:bg-neutral-700 rounded transition"
              title={sidebarCollapsed ? 'サイドバーを開く' : 'サイドバーを閉じる'}
            >
              {sidebarCollapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
            </button>
          </div>

          {!sidebarCollapsed && (
          <>
          {/* モード切り替え */}
          <div className="p-3 border-b border-neutral-700">
            <div className="flex gap-1">
              <button
                onClick={() => { setAppMode('diff-check'); setInitialModeSelect(false); }}
                className={`flex-1 flex items-center justify-center gap-1 py-2 text-xs rounded transition ${
                  appMode === 'diff-check'
                    ? 'bg-blue-600 text-white'
                    : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'
                }`}
              >
                <Eye size={14} />
                検版
              </button>
              <button
                onClick={() => {
                  if (appMode === 'diff-check') {
                    transferDiffToParallelView();
                  }
                  setAppMode('parallel-view');
                }}
                className={`flex-1 flex items-center justify-center gap-1 py-2 text-xs rounded transition ${
                  appMode === 'parallel-view'
                    ? 'bg-green-600 text-white'
                    : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'
                }`}
              >
                <Columns2 size={14} />
                並列ビュー
              </button>
            </div>
            <p className="text-xs text-neutral-600 text-center mt-1">Vキーで切り替え</p>
          </div>

          {appMode === 'diff-check' ? (
          <>
          <div className="p-3 border-b border-neutral-700">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-neutral-400">比較モード</span>
              <span className="text-xs text-neutral-500">{stats.done}/{stats.total}</span>
            </div>

            <div className="flex gap-1 mb-3">
              <button onClick={() => handleModeChange('tiff-tiff')} className={`flex-1 text-xs py-1.5 rounded transition ${compareMode === 'tiff-tiff' ? 'bg-blue-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}>TIFF</button>
              <button onClick={() => handleModeChange('psd-psd')} className={`flex-1 text-xs py-1.5 rounded transition ${compareMode === 'psd-psd' ? 'bg-purple-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}>PSD</button>
              <button onClick={() => handleModeChange('pdf-pdf')} className={`flex-1 text-xs py-1.5 rounded transition ${compareMode === 'pdf-pdf' ? 'bg-rose-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}>PDF</button>
              <button onClick={() => handleModeChange('psd-tiff')} className={`flex-1 text-xs py-1.5 rounded transition ${compareMode === 'psd-tiff' ? 'bg-orange-600 text-white' : 'bg-neutral-700 text-neutral-400 hover:bg-neutral-600'}`}>混合</button>
            </div>

            <div className="flex gap-2">
              <div className={`flex-1 relative rounded transition-colors ${dragOverSide === 'A' ? 'ring-2 ring-blue-500 bg-blue-900/30' : ''}`} onDragOver={handleDragOver} onDragEnter={handleDragEnter('A')} onDragLeave={handleDragLeave} onDrop={handleDrop('A')}>
                <button onClick={handleFilesAUpload} className="w-full text-center py-2 bg-neutral-700 hover:bg-neutral-600 rounded cursor-pointer text-xs transition">
                  {modeLabels.a} ({filesA.length})
                </button>
                {dragOverSide === 'A' && <div className="absolute inset-0 flex items-center justify-center bg-blue-600/80 rounded text-white text-xs font-bold pointer-events-none">ドロップ</div>}
              </div>
              <div className={`flex-1 relative rounded transition-colors ${dragOverSide === 'B' ? 'ring-2 ring-green-500 bg-green-900/30' : ''}`} onDragOver={handleDragOver} onDragEnter={handleDragEnter('B')} onDragLeave={handleDragLeave} onDrop={handleDrop('B')}>
                <button onClick={handleFilesBUpload} className="w-full text-center py-2 bg-neutral-700 hover:bg-neutral-600 rounded cursor-pointer text-xs transition">
                  {modeLabels.b} ({filesB.length})
                </button>
                {dragOverSide === 'B' && <div className="absolute inset-0 flex items-center justify-center bg-green-600/80 rounded text-white text-xs font-bold pointer-events-none">ドロップ</div>}
              </div>
            </div>

            <div className="mt-1 text-xs text-neutral-500 text-center">ファイル/フォルダをドロップ可能</div>

            {/* ファイル名表示 */}
            {(filesA.length > 0 || filesB.length > 0) && (
              <div className="mt-2 space-y-1 text-xs">
                <div className="flex items-center gap-1.5 px-1">
                  <span className="text-blue-400 font-medium shrink-0">A:</span>
                  <span className="text-neutral-300 truncate">
                    {filesA.length > 0 ? ((filesA[0] as FileWithPath).filePath?.split(/[/\\]/).slice(-2, -1)[0] || filesA[0].name) : '-'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 px-1">
                  <span className="text-green-400 font-medium shrink-0">B:</span>
                  <span className="text-neutral-300 truncate">
                    {filesB.length > 0 ? ((filesB[0] as FileWithPath).filePath?.split(/[/\\]/).slice(-2, -1)[0] || filesB[0].name) : '-'}
                  </span>
                </div>
              </div>
            )}

            {compareMode === 'psd-tiff' && (
              <div className="mt-2 space-y-1">
                <div
                  className={`relative rounded transition-colors ${dragOverSide === 'json' ? 'ring-2 ring-orange-500 bg-orange-900/30' : ''}`}
                  onDragOver={handleDragOver}
                  onDragEnter={handleDragEnter('json')}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop('json')}
                >
                  <button
                    onClick={() => setIsGDriveBrowserOpen(true)}
                    className="w-full flex items-center justify-center gap-2 py-2 bg-neutral-700 hover:bg-neutral-600 rounded cursor-pointer text-xs transition"
                  >
                    <HardDrive size={14} />
                    {cropBounds ? <span className="text-green-400">JSON OK</span> : <span className="text-orange-400">Gドライブ</span>}
                  </button>
                  {dragOverSide === 'json' && <div className="absolute inset-0 flex items-center justify-center bg-orange-600/80 rounded text-white text-xs font-bold pointer-events-none">ドロップ</div>}
                </div>
                <p className="text-xs text-neutral-600 text-center">JSONドロップも可能</p>
              </div>
            )}

            {stats.pending > 0 && <div className="mt-2 w-full bg-neutral-700 rounded h-1"><div className="bg-blue-500 h-1 rounded transition-all" style={{ width: `${(stats.done / stats.total) * 100}%` }} /></div>}
          </div>

          <div className="border-b border-neutral-700">
            <button onClick={() => setSettingsOpen(!settingsOpen)} className="w-full px-3 py-2 flex items-center justify-between text-xs text-neutral-400 hover:bg-neutral-700/50 transition">
              <span className="flex items-center gap-1">
                <Settings size={12} />設定
                {filterDiffOnly && <span className="text-blue-400 ml-1">フィルター中</span>}
                {showMarkers && <span className="text-cyan-400 ml-1">マーカーON</span>}
              </span>
              {settingsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>

            {settingsOpen && (
              <div className="px-3 pb-3 space-y-2">
                <div className="flex gap-1">
                  <button onClick={() => setPairingMode('order')} className={`flex-1 text-xs py-1 rounded transition ${pairingMode === 'order' ? 'bg-blue-600 text-white' : 'bg-neutral-700 text-neutral-400'}`}>順番でペア</button>
                  <button onClick={() => setPairingMode('name')} className={`flex-1 text-xs py-1 rounded transition ${pairingMode === 'name' ? 'bg-blue-600 text-white' : 'bg-neutral-700 text-neutral-400'}`}>名前でペア</button>
                </div>
                <label className="flex items-center gap-2 text-xs cursor-pointer text-neutral-300">
                  <input type="checkbox" checked={filterDiffOnly} onChange={(e) => setFilterDiffOnly(e.target.checked)} className="rounded w-3 h-3" />
                  差分ありのみ表示
                </label>
                <label className="flex items-center gap-2 text-xs cursor-pointer text-neutral-300">
                  <input type="checkbox" checked={showMarkers} onChange={(e) => setShowMarkers(e.target.checked)} className="rounded w-3 h-3" />
                  <Target size={12} className="text-cyan-400" />
                  差分箇所を丸枠で強調
                </label>
                <button onClick={() => { setFilesA([]); setFilesB([]); setPairs([]); setCropBounds(null); setPreloadProgress({ loaded: 0, total: 0 }); pdfCache.clear(); }} className="w-full py-1 bg-red-900/50 hover:bg-red-900 text-red-300 rounded text-xs transition">クリア</button>
              </div>
            )}
          </div>

          <div ref={fileListRef} className={`overflow-y-auto ${compareMode === 'pdf-pdf' && currentPair?.totalPages && currentPair.totalPages > 1 ? 'shrink-0 max-h-32' : 'flex-1'}`}>
            {pairs.length === 0 && <div className="p-4 text-center text-neutral-500 text-xs">ファイルをアップロード</div>}
            {stats.diff > 0 && <div className="px-3 py-2 bg-red-900/20 text-xs text-red-300 border-b border-neutral-700">差分: {stats.diff}件</div>}

            {filteredPairs.map((pair) => (
              <button key={pair.index} data-index={pair.index} onClick={() => setSelectedIndex(pair.index)} className={`w-full text-left px-3 py-2 border-b border-neutral-700/50 transition-colors ${selectedIndex === pair.index ? 'bg-blue-900/50 border-l-2 border-l-blue-400' : 'hover:bg-neutral-700/50'}`}>
                <div className="flex items-center justify-between mb-0.5">
                  <div className="flex items-center gap-1 flex-1 min-w-0 mr-2">
                    <span className="text-blue-400 text-[10px] shrink-0">A:</span>
                    <span className="text-xs text-neutral-300 truncate">{pair.nameA?.replace(/\.(psd|tiff?|pdf)/i, '') || '-'}</span>
                  </div>
                  {pair.status === 'done' && (pair.hasDiff ? <AlertTriangle size={12} className="text-red-400 shrink-0" /> : <CheckCircle size={12} className="text-green-500 shrink-0" />)}
                  {pair.status === 'loading' && <Loader2 size={12} className="text-blue-400 animate-spin shrink-0" />}
                  {pair.status === 'pending' && pair.fileA && pair.fileB && <span className="text-xs text-neutral-600 shrink-0">...</span>}
                  {pair.status === 'error' && <span className="text-xs text-red-500 shrink-0">!</span>}
                </div>
                <div className="flex items-center gap-1 min-w-0">
                  <span className="text-green-400 text-[10px] shrink-0">B:</span>
                  <span className="text-xs text-neutral-400 truncate">{pair.nameB?.replace(/\.(psd|tiff?|pdf)/i, '') || '-'}</span>
                </div>
              </button>
            ))}

          </div>

          {/* PDF-PDFモード: ページごとの差分リスト */}
          {compareMode === 'pdf-pdf' && currentPair?.status === 'done' && currentPair.totalPages && currentPair.totalPages > 1 && (
            <div className="flex-1 flex flex-col min-h-0 border-t border-neutral-600">
              <div className="px-3 py-2 text-xs text-neutral-400 bg-neutral-800/50 shrink-0">
                ページ一覧 ({currentPair.totalPages}p)
              </div>
              <div ref={pageListRef} className="flex-1 overflow-y-auto">
                {Array.from({ length: currentPair.totalPages }, (_, i) => i + 1).map(pageNum => {
                  const cacheKey = `${selectedIndex}-${pageNum}`;
                  const pageData = diffCache[cacheKey];
                  const isCurrentPage = currentPage === pageNum;
                  return (
                    <button
                      key={pageNum}
                      data-page={pageNum}
                      onClick={() => setCurrentPage(pageNum)}
                      className={`w-full text-left px-3 py-1.5 text-xs border-b border-neutral-700/30 transition-colors flex items-center justify-between ${isCurrentPage ? 'bg-rose-900/40 border-l-2 border-l-rose-400' : 'hover:bg-neutral-700/50'}`}
                    >
                      <span className={isCurrentPage ? 'text-rose-200' : 'text-neutral-400'}>P.{pageNum}</span>
                      {pageData ? (
                        pageData.hasDiff ? <AlertTriangle size={10} className="text-red-400" /> : <CheckCircle size={10} className="text-green-500" />
                      ) : (
                        <span className="text-neutral-600 text-[10px]">...</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          </>
          ) : (
          /* 並列ビューモードのサイドバー */
          <>
          <div className="p-3 border-b border-neutral-700">
            <div className="text-xs text-neutral-400 mb-3">フォルダ / PDF選択</div>
            <div className="space-y-3">
              {/* A側 */}
              <div>
                <div className="flex gap-1">
                  <button
                    onClick={() => handleSelectParallelFolder('A')}
                    className="flex-1 min-w-0 flex items-center gap-2 py-2 px-3 bg-neutral-700 hover:bg-neutral-600 rounded-l text-xs transition"
                    title="フォルダを選択"
                  >
                    <FolderOpen size={14} className="text-blue-400 shrink-0" />
                    <span className="flex-1 min-w-0 text-left truncate">
                      {parallelFolderA ? parallelFolderA.split(/[/\\]/).pop() : 'A'}
                    </span>
                    <span className="text-neutral-500 shrink-0">({parallelFilesA.length})</span>
                  </button>
                  <button
                    onClick={() => handleSelectParallelPdf('A')}
                    className="py-2 px-2 bg-blue-900/50 hover:bg-blue-800 rounded-r text-xs transition"
                    title="PDFを選択"
                  >
                    <FileText size={14} className="text-blue-300" />
                  </button>
                </div>
              </div>

              {/* B側 */}
              <div>
                <div className="flex gap-1">
                  <button
                    onClick={() => handleSelectParallelFolder('B')}
                    className="flex-1 min-w-0 flex items-center gap-2 py-2 px-3 bg-neutral-700 hover:bg-neutral-600 rounded-l text-xs transition"
                    title="フォルダを選択"
                  >
                    <FolderOpen size={14} className="text-green-400 shrink-0" />
                    <span className="flex-1 min-w-0 text-left truncate">
                      {parallelFolderB ? parallelFolderB.split(/[/\\]/).pop() : 'B'}
                    </span>
                    <span className="text-neutral-500 shrink-0">({parallelFilesB.length})</span>
                  </button>
                  <button
                    onClick={() => handleSelectParallelPdf('B')}
                    className="py-2 px-2 bg-green-900/50 hover:bg-green-800 rounded-r text-xs transition"
                    title="PDFを選択"
                  >
                    <FileText size={14} className="text-green-300" />
                  </button>
                </div>
              </div>
            </div>

            {parallelFilesA.length > 0 || parallelFilesB.length > 0 ? (
              <button
                onClick={clearParallelView}
                className="w-full mt-3 py-1 bg-red-900/50 hover:bg-red-900 text-red-300 rounded text-xs transition"
              >
                クリア
              </button>
            ) : null}
          </div>

          <div ref={parallelFileListRef} className="flex-1 overflow-y-auto">
            {parallelFilesA.length === 0 && parallelFilesB.length === 0 && (
              <div className="p-4 text-center text-neutral-500 text-xs">フォルダまたはPDFを選択</div>
            )}
            {Array.from({ length: Math.max(parallelFilesA.length, parallelFilesB.length) }).map((_, idx) => {
              const fileA = parallelFilesA[idx];
              const fileB = parallelFilesB[idx];
              const isSelectedA = parallelIndexA === idx;
              const isSelectedB = parallelIndexB === idx;
              const isSelected = isSelectedA || isSelectedB;
              return (
                <button
                  key={idx}
                  data-index={idx}
                  onClick={() => {
                    if (parallelSyncMode) {
                      setParallelIndexA(idx);
                      setParallelIndexB(idx);
                    } else {
                      if (parallelActivePanel === 'A') {
                        setParallelIndexA(idx);
                      } else {
                        setParallelIndexB(idx);
                      }
                    }
                    setParallelCurrentIndex(idx);
                  }}
                  className={`w-full text-left px-3 py-2 border-b border-neutral-700/50 transition-colors ${
                    isSelected
                      ? isSelectedA && isSelectedB
                        ? 'bg-green-900/50 border-l-2 border-l-green-400'
                        : isSelectedA
                          ? 'bg-blue-900/50 border-l-2 border-l-blue-400'
                          : 'bg-green-900/50 border-l-2 border-l-green-400'
                      : 'hover:bg-neutral-700/50'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-neutral-500 w-8">#{idx + 1}</span>
                    <span className="flex-1 truncate text-neutral-300 mx-2">
                      {fileA?.name || '-'}
                    </span>
                    <span className="flex-1 truncate text-neutral-300 mx-2">
                      {fileB?.name || '-'}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
          </>
          )}
          </>
          )}
        </div>
        )}

        {/* Main Viewer */}
        {appMode === 'diff-check' ? (
        <div className="flex-1 flex flex-col bg-black relative">
          {!isFullscreen && (
          <div className="h-12 bg-neutral-800 border-b border-neutral-700 flex items-center justify-between z-10 shrink-0 px-3">
            <div className="flex items-center gap-1.5">
              <div className="bg-neutral-900 rounded flex p-0.5 gap-0.5">
                <button onClick={() => setViewMode('A')} disabled={!currentPair || currentPair.status !== 'done'} className={`text-xs rounded px-2 py-1 ${viewMode === 'A' ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-white disabled:opacity-30'}`}>{modeLabels.a}</button>
                {compareMode === 'psd-tiff' && <button onClick={() => setViewMode('A-full')} disabled={!currentPair || currentPair.status !== 'done'} className={`px-2 py-1 text-xs rounded ${viewMode === 'A-full' ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-white disabled:opacity-30'}`}>全体</button>}
                <button onClick={() => setViewMode('B')} disabled={!currentPair || currentPair.status !== 'done'} className={`text-xs rounded px-2 py-1 ${viewMode === 'B' ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-white disabled:opacity-30'}`}>{modeLabels.b}</button>
                <button onClick={() => setViewMode('diff')} disabled={!currentPair || currentPair.status !== 'done'} className={`text-xs rounded flex items-center gap-1 px-2 py-1 ${viewMode === 'diff' ? 'bg-red-900/50 text-red-100' : 'text-neutral-400 hover:text-white disabled:opacity-30'}`}><FileDiff size={12} />差分</button>
              </div>
              {(compareMode === 'psd-psd' || compareMode === 'psd-tiff') && (
                <button
                  onClick={() => {
                    const psdFile = (viewMode === 'A' || viewMode === 'A-full')
                      ? currentPair?.fileA as FileWithPath | null
                      : (viewMode === 'B' && compareMode === 'psd-psd')
                        ? currentPair?.fileB as FileWithPath | null
                        : null;
                    if (psdFile?.filePath) invoke('open_file_with_default_app', { path: psdFile.filePath });
                  }}
                  disabled={!currentPair || currentPair.status !== 'done' || viewMode === 'diff' || (viewMode === 'B' && compareMode === 'psd-tiff')}
                  className="px-2.5 py-1.5 text-xs rounded bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1"
                  title="Photoshopで開く"
                >
                  <Layers size={12} />Photoshop<span className="opacity-60 text-[11px]">[P]</span>
                </button>
              )}
              {compareMode === 'pdf-pdf' && (
                <button
                  onClick={() => {
                    const pdfFile = (viewMode === 'A' || viewMode === 'A-full' || viewMode === 'diff')
                      ? currentPair?.fileA as FileWithPath | null
                      : currentPair?.fileB as FileWithPath | null;
                    if (pdfFile?.filePath) {
                      releaseMemoryBeforeMojiQ();
                      setTimeout(() => invoke('open_pdf_in_mojiq', { pdfPath: pdfFile.filePath, page: currentPage }), 100);
                    }
                  }}
                  disabled={!currentPair || currentPair.status !== 'done'}
                  className="px-2.5 py-1.5 text-xs rounded bg-rose-600 hover:bg-rose-500 text-white disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1"
                  title="MojiQで開く (Q)"
                >
                  <FileText size={12} />MojiQ<span className="opacity-60 text-[11px]">[Q]</span>
                </button>
              )}
              <button
                onClick={() => {
                  const displayImg = (() => {
                    const pair = pairs[selectedIndex];
                    if (!pair || pair.status !== 'done') return null;
                    if (viewMode === 'diff') {
                      if (pair.diffSrcWithMarkers) return pair.diffSrcWithMarkers;
                      return pair.diffSrc;
                    }
                    if (viewMode === 'B') return pair.processedB;
                    if (viewMode === 'A-full') return pair.srcA;
                    return pair.processedA;
                  })();
                  if (displayImg) setCapturedImage(displayImg);
                }}
                disabled={!currentPair || currentPair.status !== 'done'}
                className="text-xs rounded bg-yellow-600 hover:bg-yellow-500 text-white disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1 px-2.5 py-1.5"
                title="指示"
              >
                指示<span className="opacity-60 text-[11px]">[C]</span>
              </button>
              {compareMode !== 'pdf-pdf' && (
                <button
                  onClick={refreshDiffMode}
                  disabled={!currentPair || currentPair.status === 'loading'}
                  className="text-xs rounded bg-teal-600 hover:bg-teal-500 text-white disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1 px-2.5 py-1.5"
                  title="ファイルを再読み込み (F5)"
                >
                  <RefreshCw size={12} />更新<span className="opacity-60 text-[11px]">[F5]</span>
                </button>
              )}
              {/* フォルダを開くボタン（差分モード） */}
              {(() => {
                const folderPathA = getDiffFolderPath('A');
                const folderPathB = getDiffFolderPath('B');
                if (!folderPathA && !folderPathB) return null;
                const hasBothFolders = folderPathA && folderPathB;
                return (
                  <div className="relative">
                    <button
                      onClick={() => {
                        if (!hasBothFolders) {
                          openFolderInExplorer(folderPathA || folderPathB);
                        } else {
                          setShowFolderSelectPopup(!showFolderSelectPopup);
                        }
                      }}
                      className="text-xs rounded flex items-center gap-1 px-2.5 py-1.5 bg-amber-900/50 border border-amber-700 text-amber-300 hover:bg-amber-800/50"
                      title="フォルダを開く"
                    >
                      <FolderOpen size={12} />フォルダ
                    </button>

                    {showFolderSelectPopup && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setShowFolderSelectPopup(false)} />
                        <div className="absolute top-full left-0 mt-2 p-2 bg-neutral-800 rounded-lg shadow-xl border border-neutral-600 z-50 min-w-48">
                          <button
                            onClick={() => {
                              openFolderInExplorer(folderPathA);
                              setShowFolderSelectPopup(false);
                            }}
                            disabled={!folderPathA}
                            className="w-full text-left px-3 py-2 rounded text-sm hover:bg-neutral-700 disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2"
                          >
                            <span className="text-blue-400 shrink-0">A側</span>
                            <span className="text-neutral-400 truncate">{(filesA[0] as FileWithPath)?.filePath?.split(/[/\\]/).slice(-2, -1)[0] || '-'}</span>
                          </button>
                          <button
                            onClick={() => {
                              openFolderInExplorer(folderPathB);
                              setShowFolderSelectPopup(false);
                            }}
                            disabled={!folderPathB}
                            className="w-full text-left px-3 py-2 rounded text-sm hover:bg-neutral-700 disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2"
                          >
                            <span className="text-green-400 shrink-0">B側</span>
                            <span className="text-neutral-400 truncate">{(filesB[0] as FileWithPath)?.filePath?.split(/[/\\]/).slice(-2, -1)[0] || '-'}</span>
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}
              <button
                onClick={toggleFullscreen}
                className="text-xs rounded bg-neutral-700 hover:bg-neutral-600 text-white flex items-center gap-1 px-2.5 py-1.5"
                title="全画面表示 (F11)"
              >
                <Maximize2 size={12} /><span className="opacity-60 text-[11px]">[F11]</span>
              </button>
            </div>

            <div className="flex items-center text-xs text-neutral-400 gap-1.5">
              {compareMode === 'pdf-pdf' && currentPair?.status === 'done' && currentPair.totalPages > 1 && (
                <div className="flex items-center gap-1 px-2 py-1 bg-neutral-900 rounded border border-neutral-700">
                  <button onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))} disabled={currentPage <= 1} tabIndex={-1} className="px-2 py-1 rounded hover:bg-neutral-700 disabled:opacity-30">◀</button>
                  <span className="px-2 min-w-[80px] text-center">{isLoadingPage ? <Loader2 size={12} className="inline animate-spin" /> : <>{currentPage} / {currentPair.totalPages}</>}</span>
                  <button onClick={() => setCurrentPage(prev => Math.min(prev + 1, currentPair.totalPages))} disabled={currentPage >= currentPair.totalPages} tabIndex={-1} className="px-2 py-1 rounded hover:bg-neutral-700 disabled:opacity-30">▶</button>
                  {preloadProgress.total > 0 && preloadProgress.loaded < preloadProgress.total && (
                    <span className="ml-2 text-neutral-500 text-xs">
                      先読み {Math.round((preloadProgress.loaded / preloadProgress.total) * 100)}%
                    </span>
                  )}
                </div>
              )}
              {/* ショートカットヒント */}
              <button
                onClick={() => setShowHelp(!showHelp)}
                className="flex items-center gap-2 text-[11px] px-2 py-1 bg-neutral-900 rounded border border-neutral-700 hover:bg-neutral-700 transition-colors"
                title="クリックで詳細表示"
              >
                <span className="flex items-center gap-1">
                  <kbd className="px-1 py-0.5 bg-neutral-700 rounded text-neutral-200 font-mono text-[10px] border border-neutral-500">Space</kbd>
                  <span className="text-neutral-300">A/B</span>
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1 py-0.5 bg-neutral-700 rounded text-neutral-200 font-mono text-[10px] border border-neutral-500">Ctrl+Space</kbd>
                  <span className="text-neutral-300">差分</span>
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1 py-0.5 bg-neutral-700 rounded text-neutral-200 font-mono text-[10px] border border-neutral-500">↑↓</kbd>
                  <span className="text-neutral-300">{compareMode === 'pdf-pdf' ? 'ページ' : '選択'}</span>
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1 py-0.5 bg-neutral-700 rounded text-neutral-200 font-mono text-[10px] border border-neutral-500">C</kbd>
                  <span className="text-neutral-300">指示</span>
                </span>
                <HelpCircle size={11} className="text-neutral-400" />
              </button>
            </div>
          </div>
          )}

          <div className={`flex-1 relative overflow-hidden flex items-center justify-center bg-neutral-950 ${isFullscreen ? '' : 'p-4'} transition-colors ${!currentPair && dragOverSide ? 'bg-neutral-900' : ''}`} onDragOver={handleDragOver}>
            {currentPair ? (
              currentPair.status === 'loading' ? (
                <div className="flex flex-col items-center text-blue-400"><Loader2 size={48} className="animate-spin mb-4" /><p>解析中...</p></div>
              ) : currentPair.status === 'error' ? (
                <div className="text-red-400 text-center"><p>読み込みに失敗しました</p><p className="text-xs text-neutral-500 mt-2">{currentPair.errorMessage}</p></div>
              ) : currentPair.status === 'pending' ? (
                <div className="flex flex-col items-center w-full max-w-3xl">
                  {currentPair.fileA && currentPair.fileB && (compareMode !== 'psd-tiff' || cropBounds) ? (
                    <><Loader2 size={48} className="animate-spin mb-4 opacity-50 text-blue-400" /><p className="text-neutral-500">順番待ち...</p></>
                  ) : (
                    <>
                      <Upload size={48} className="mb-4 opacity-20 text-neutral-500" />
                      <p className="text-neutral-500 mb-6">{compareMode === 'psd-tiff' ? '3つのファイルをドロップしてください' : 'ファイルをドロップしてください'}</p>

                      <div className="flex gap-4 w-full">
                        {compareMode === 'psd-tiff' && (
                          <div
                            ref={dropZoneJsonRef}
                            className={`flex-1 border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center transition-all cursor-pointer ${dragOverSide === 'json' ? 'border-orange-500 bg-orange-900/30' : cropBounds ? 'border-green-600 bg-green-900/20' : 'border-neutral-700 hover:border-neutral-500 hover:bg-neutral-900/50'}`}
                            onDragOver={handleDragOver}
                            onDragEnter={handleDragEnter('json')}
                            onDragLeave={handleDragLeave}
                            onDrop={handleDrop('json')}
                            onClick={() => setIsGDriveBrowserOpen(true)}
                          >
                            <HardDrive size={28} className={`mb-2 ${dragOverSide === 'json' ? 'text-orange-400' : cropBounds ? 'text-green-400' : 'text-neutral-600'}`} />
                            <p className={`text-sm font-medium ${dragOverSide === 'json' ? 'text-orange-300' : cropBounds ? 'text-green-300' : 'text-neutral-400'}`}>Gドライブ</p>
                            <p className="text-xs text-neutral-600 mt-1">.json</p>
                            {cropBounds && <p className="text-xs text-green-400 mt-2">OK</p>}
                          </div>
                        )}

                        <div ref={dropZoneARef} className={`flex-1 border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center transition-all cursor-pointer ${dragOverSide === 'A' ? 'border-blue-500 bg-blue-900/30' : filesA.length > 0 ? 'border-green-600 bg-green-900/20' : 'border-neutral-700 hover:border-neutral-500 hover:bg-neutral-900/50'}`} onDragOver={handleDragOver} onDragEnter={handleDragEnter('A')} onDragLeave={handleDragLeave} onDrop={handleDrop('A')} onClick={handleFilesAUpload}>
                          <FolderOpen size={28} className={`mb-2 ${dragOverSide === 'A' ? 'text-blue-400' : filesA.length > 0 ? 'text-green-400' : 'text-neutral-600'}`} />
                          <p className={`text-sm font-medium ${dragOverSide === 'A' ? 'text-blue-300' : filesA.length > 0 ? 'text-green-300' : 'text-neutral-400'}`}>{modeLabels.a}</p>
                          <p className="text-xs text-neutral-600 mt-1">{getAcceptedExtensions('A').join(', ')}</p>
                          {filesA.length > 0 && <p className="text-xs text-green-400 mt-2">{filesA.length}件</p>}
                        </div>

                        <div ref={dropZoneBRef} className={`flex-1 border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center transition-all cursor-pointer ${dragOverSide === 'B' ? 'border-green-500 bg-green-900/30' : filesB.length > 0 ? 'border-green-600 bg-green-900/20' : 'border-neutral-700 hover:border-neutral-500 hover:bg-neutral-900/50'}`} onDragOver={handleDragOver} onDragEnter={handleDragEnter('B')} onDragLeave={handleDragLeave} onDrop={handleDrop('B')} onClick={handleFilesBUpload}>
                          <FolderOpen size={28} className={`mb-2 ${dragOverSide === 'B' ? 'text-green-400' : filesB.length > 0 ? 'text-green-400' : 'text-neutral-600'}`} />
                          <p className={`text-sm font-medium ${dragOverSide === 'B' ? 'text-green-300' : filesB.length > 0 ? 'text-green-300' : 'text-neutral-400'}`}>{modeLabels.b}</p>
                          <p className="text-xs text-neutral-600 mt-1">{getAcceptedExtensions('B').join(', ')}</p>
                          {filesB.length > 0 && <p className="text-xs text-green-400 mt-2">{filesB.length}件</p>}
                        </div>
                      </div>

                      {compareMode === 'psd-tiff' && (
                        <div className="mt-4 flex gap-2 text-xs">
                          <span className={cropBounds ? 'text-green-400' : 'text-neutral-500'}>1. JSON {cropBounds ? 'OK' : '...'}</span>
                          <span className="text-neutral-600">→</span>
                          <span className={filesA.length > 0 ? 'text-green-400' : 'text-neutral-500'}>2. PSD {filesA.length > 0 ? 'OK' : '...'}</span>
                          <span className="text-neutral-600">→</span>
                          <span className={filesB.length > 0 ? 'text-green-400' : 'text-neutral-500'}>3. TIFF {filesB.length > 0 ? 'OK' : '...'}</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <>
                  <div
                    ref={imageContainerRef}
                    className="relative overflow-hidden flex items-center justify-center w-full h-full"
                    onWheel={viewMode === 'diff' ? handleWheelPageTurn : undefined}
                    onMouseDown={handleImageMouseDown}
                    onMouseMove={handleImageMouseMove}
                    onMouseUp={handleImageMouseUp}
                    onMouseLeave={handleImageMouseUp}
                    onDoubleClick={handleImageDoubleClick}
                    style={{ cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
                  >
                    {/* PDF表示: Canvas直接レンダリング（MojiQと同様） */}
                    {compareMode === 'pdf-pdf' && viewMode !== 'diff' ? (
                      <canvas
                        ref={pdfCanvasRef}
                        className="max-w-full max-h-full object-contain shadow-2xl bg-white select-none"
                        style={{
                          transform: `scale(${zoom}) translate(${panPosition.x / zoom}px, ${panPosition.y / zoom}px)`,
                          transformOrigin: 'center center',
                        }}
                      />
                    ) : getDisplayImage() ? (
                      <img
                        src={getDisplayImage()!}
                        alt="View"
                        className="max-w-full max-h-full object-contain shadow-2xl bg-white select-none"
                        style={{
                          transform: `scale(${zoom}) translate(${panPosition.x / zoom}px, ${panPosition.y / zoom}px)`,
                          transformOrigin: 'center center',
                        }}
                        draggable={false}
                      />
                    ) : (
                      <div className="flex flex-col items-center text-neutral-500"><Loader2 size={32} className="animate-spin mb-2 opacity-50" /><p>読み込み中...</p></div>
                    )}
                  </div>

                  {!isFullscreen && zoom !== 1 && (
                    <div className="absolute bottom-4 left-4 bg-black/70 text-white px-2 py-1 rounded text-sm">
                      {Math.round(zoom * 100)}% (Ctrl+0でリセット)
                    </div>
                  )}

                  {!isFullscreen && (
                  <div className="absolute top-4 right-4 flex flex-col items-end gap-2 z-50">
                    <div className="flex items-center gap-2">
                      <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full shadow-lg text-sm border pointer-events-none ${viewMode === 'diff' ? 'bg-red-900/80 border-red-600 text-red-100' : viewMode === 'B' ? 'bg-green-900/80 border-green-600 text-green-100' : 'bg-blue-900/80 border-blue-600 text-blue-100'}`}>
                        {viewMode === 'diff' ? <><FileDiff size={14} /> 差分</> : viewMode === 'B' ? <>{modeLabels.b}</> : viewMode === 'A-full' ? <>PSD全体</> : <>{modeLabels.a}</>}
                      </div>
                    </div>

                    {showHelp && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setShowHelp(false)} />
                        <div className="relative z-50 bg-neutral-900/95 backdrop-blur border border-neutral-700 rounded-lg shadow-2xl p-4 text-sm min-w-64">
                          <div className="text-neutral-200 font-bold mb-3 flex items-center gap-2">
                            <HelpCircle size={16} /> 操作方法
                          </div>
                          <div className="space-y-1.5 text-neutral-300">
                            <div className="flex justify-between"><span className="text-neutral-500">Space</span><span>A/B 切り替え</span></div>
                            <div className="flex justify-between"><span className="text-neutral-500">Ctrl+Space</span><span>差分表示トグル</span></div>
                            <div className="flex justify-between"><span className="text-neutral-500">↑ / ↓</span><span>{compareMode === 'pdf-pdf' ? 'ページ移動' : 'ファイル選択'}</span></div>
                            {(compareMode === 'psd-psd' || compareMode === 'psd-tiff') && <div className="flex justify-between"><span className="text-neutral-500">P</span><span>Photoshopで開く</span></div>}
                            {compareMode === 'pdf-pdf' && <div className="flex justify-between"><span className="text-neutral-500">Q</span><span>MojiQで開く</span></div>}
                            <div className="flex justify-between"><span className="text-neutral-500">C</span><span>スクリーンショット</span></div>
                            <div className="border-t border-neutral-700 my-2" />
                            <div className="flex justify-between"><span className="text-neutral-500">Ctrl+-/+</span><span>ズーム</span></div>
                            <div className="flex justify-between"><span className="text-neutral-500">Ctrl+0</span><span>全体表示に戻す</span></div>
                            {viewMode === 'diff' && <div className="flex justify-between"><span className="text-neutral-500">ホイール</span><span>ページ切替</span></div>}
                            <div className="flex justify-between"><span className="text-neutral-500">ドラッグ</span><span>パン移動（拡大時）</span></div>
                            <div className="border-t border-neutral-700 my-2" />
                            <div className="text-neutral-400 text-xs">
                              <div className="font-medium text-neutral-300 mb-1">スクリーンショット (C)</div>
                              <div>1. Cキーで選択モード開始</div>
                              <div>2. ドラッグで範囲選択</div>
                              <div>3. 枠線/ペン/テキストで注釈</div>
                              <div>4. 保存→Script_Output/検版ツール</div>
                            </div>
                          </div>
                        </div>
                      </>
                    )}

                    {compareMode === 'psd-tiff' && currentPair.hasDiff && <div className="bg-orange-600/90 text-white px-3 py-1.5 rounded-lg shadow-lg text-sm font-bold pointer-events-none">差分可能性: {currentPair.diffProbability}%</div>}
                    {currentPair.hasDiff && currentMarkers.length > 0 && <div className="bg-cyan-600/90 text-white px-3 py-1.5 rounded-lg shadow-lg text-sm font-bold flex items-center gap-1 pointer-events-none"><Target size={14} /> {currentMarkers.length}箇所</div>}
                  </div>
                  )}

                  {!isFullscreen && compareMode === 'psd-tiff' && viewMode === 'diff' && (
                    <div className="absolute bottom-4 right-4 bg-neutral-900/90 backdrop-blur p-3 rounded-lg shadow-lg text-xs pointer-events-none">
                      <div className="text-neutral-300 mb-2 font-medium">差分密度</div>
                      <div className="flex items-center gap-2"><div className="w-24 h-3 rounded" style={{ background: 'linear-gradient(to right, rgb(0,0,200), rgb(0,200,200), rgb(255,255,0), rgb(255,0,0))' }} /></div>
                      <div className="flex justify-between text-neutral-500 mt-1"><span>低</span><span>高</span></div>
                    </div>
                  )}
                </>
              )
            ) : (
              <>
              {initialModeSelect ? (
                <div className="flex flex-col items-center w-full max-w-2xl">
                  <p className="text-white text-2xl font-bold mb-8">モードを選択</p>

                  {/* メインモード選択タブ */}
                  <div className="flex gap-4 mb-8 w-full">
                    <button
                      onClick={() => {/* 差分モードはデフォルトで選択済み */}}
                      className="flex-1 border-2 border-cyan-500 bg-cyan-950/50 rounded-xl py-4 px-6 flex items-center justify-center gap-3 transition-all"
                    >
                      <FileDiff size={24} className="text-cyan-300" />
                      <span className="text-lg font-bold text-cyan-200">差分モード</span>
                    </button>
                    <button
                      onClick={() => setAppMode('parallel-view')}
                      className="flex-1 border-2 border-neutral-600 bg-neutral-800/50 rounded-xl py-4 px-6 flex items-center justify-center gap-3 transition-all cursor-pointer hover:border-teal-500 hover:bg-teal-950/30 group"
                    >
                      <PanelLeftClose size={24} className="text-neutral-400 group-hover:text-teal-300 transition-colors" />
                      <span className="text-lg font-bold text-neutral-400 group-hover:text-teal-200 transition-colors">分割ビューワー</span>
                    </button>
                  </div>

                  {/* 差分モードのサブ選択 */}
                  <p className="text-neutral-500 text-sm mb-4">比較するファイル形式を選んでください</p>
                  <div className="grid grid-cols-2 gap-4 w-full">
                    <button
                      onClick={() => handleModeChange('tiff-tiff')}
                      className="border-2 border-blue-600/50 bg-blue-950/30 rounded-xl p-6 flex flex-col items-center justify-center transition-all cursor-pointer hover:border-blue-400 hover:bg-blue-900/50 hover:scale-105 group"
                    >
                      <FileImage size={40} className="mb-2 text-blue-400 group-hover:text-blue-300 transition-colors" />
                      <p className="text-lg font-bold text-blue-300 group-hover:text-blue-200 transition-colors">TIFF</p>
                      <p className="text-xs text-blue-400/70 mt-1">TIFF同士の比較</p>
                    </button>

                    <button
                      onClick={() => handleModeChange('psd-psd')}
                      className="border-2 border-purple-600/50 bg-purple-950/30 rounded-xl p-6 flex flex-col items-center justify-center transition-all cursor-pointer hover:border-purple-400 hover:bg-purple-900/50 hover:scale-105 group"
                    >
                      <Palette size={40} className="mb-2 text-purple-400 group-hover:text-purple-300 transition-colors" />
                      <p className="text-lg font-bold text-purple-300 group-hover:text-purple-200 transition-colors">PSD</p>
                      <p className="text-xs text-purple-400/70 mt-1">PSD同士の比較</p>
                    </button>

                    <button
                      onClick={() => handleModeChange('pdf-pdf')}
                      className="border-2 border-rose-600/50 bg-rose-950/30 rounded-xl p-6 flex flex-col items-center justify-center transition-all cursor-pointer hover:border-rose-400 hover:bg-rose-900/50 hover:scale-105 group"
                    >
                      <FileText size={40} className="mb-2 text-rose-400 group-hover:text-rose-300 transition-colors" />
                      <p className="text-lg font-bold text-rose-300 group-hover:text-rose-200 transition-colors">PDF</p>
                      <p className="text-xs text-rose-400/70 mt-1">PDF同士の比較</p>
                    </button>

                    <button
                      onClick={() => handleModeChange('psd-tiff')}
                      className="border-2 border-orange-600/50 bg-orange-950/30 rounded-xl p-6 flex flex-col items-center justify-center transition-all cursor-pointer hover:border-orange-400 hover:bg-orange-900/50 hover:scale-105 group"
                    >
                      <Shuffle size={40} className="mb-2 text-orange-400 group-hover:text-orange-300 transition-colors" />
                      <p className="text-lg font-bold text-orange-300 group-hover:text-orange-200 transition-colors">混合</p>
                      <p className="text-xs text-orange-400/70 mt-1">PSD→TIFF出力の検証</p>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center w-full max-w-3xl">
                  <Upload size={48} className="mb-4 opacity-20 text-neutral-500" />
                  <p className="text-neutral-500 mb-6">{compareMode === 'psd-tiff' ? '3つのファイルをドロップして比較を開始' : 'ファイルをアップロードして比較を開始'}</p>

                  <div className="flex gap-4 w-full">
                    {compareMode === 'psd-tiff' && (
                      <div
                        ref={dropZoneJsonRef}
                        className={`flex-1 border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center transition-all cursor-pointer ${dragOverSide === 'json' ? 'border-orange-500 bg-orange-900/30' : cropBounds ? 'border-green-600 bg-green-900/20' : 'border-neutral-700 hover:border-neutral-500 hover:bg-neutral-900/50'}`}
                        onDragOver={handleDragOver}
                        onDragEnter={handleDragEnter('json')}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop('json')}
                        onClick={() => setIsGDriveBrowserOpen(true)}
                      >
                        <HardDrive size={28} className={`mb-2 ${dragOverSide === 'json' ? 'text-orange-400' : cropBounds ? 'text-green-400' : 'text-neutral-600'}`} />
                        <p className={`text-sm font-medium ${dragOverSide === 'json' ? 'text-orange-300' : cropBounds ? 'text-green-300' : 'text-neutral-400'}`}>Gドライブ</p>
                        <p className="text-xs text-neutral-600 mt-1">.json</p>
                        {cropBounds && <p className="text-xs text-green-400 mt-2">OK</p>}
                      </div>
                    )}

                    <div ref={dropZoneARef} className={`flex-1 border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center transition-all cursor-pointer ${dragOverSide === 'A' ? 'border-blue-500 bg-blue-900/30' : filesA.length > 0 ? 'border-green-600 bg-green-900/20' : 'border-neutral-700 hover:border-neutral-500 hover:bg-neutral-900/50'}`} onDragOver={handleDragOver} onDragEnter={handleDragEnter('A')} onDragLeave={handleDragLeave} onDrop={handleDrop('A')} onClick={handleFilesAUpload}>
                      <FolderOpen size={28} className={`mb-2 ${dragOverSide === 'A' ? 'text-blue-400' : filesA.length > 0 ? 'text-green-400' : 'text-neutral-600'}`} />
                      <p className={`text-sm font-medium ${dragOverSide === 'A' ? 'text-blue-300' : filesA.length > 0 ? 'text-green-300' : 'text-neutral-400'}`}>{modeLabels.a}</p>
                      <p className="text-xs text-neutral-600 mt-1">{getAcceptedExtensions('A').join(', ')}</p>
                      {filesA.length > 0 && <p className="text-xs text-green-400 mt-2">{filesA.length}件</p>}
                    </div>

                    <div ref={dropZoneBRef} className={`flex-1 border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center transition-all cursor-pointer ${dragOverSide === 'B' ? 'border-green-500 bg-green-900/30' : filesB.length > 0 ? 'border-green-600 bg-green-900/20' : 'border-neutral-700 hover:border-neutral-500 hover:bg-neutral-900/50'}`} onDragOver={handleDragOver} onDragEnter={handleDragEnter('B')} onDragLeave={handleDragLeave} onDrop={handleDrop('B')} onClick={handleFilesBUpload}>
                      <FolderOpen size={28} className={`mb-2 ${dragOverSide === 'B' ? 'text-green-400' : filesB.length > 0 ? 'text-green-400' : 'text-neutral-600'}`} />
                      <p className={`text-sm font-medium ${dragOverSide === 'B' ? 'text-green-300' : filesB.length > 0 ? 'text-green-300' : 'text-neutral-400'}`}>{modeLabels.b}</p>
                      <p className="text-xs text-neutral-600 mt-1">{getAcceptedExtensions('B').join(', ')}</p>
                      {filesB.length > 0 && <p className="text-xs text-green-400 mt-2">{filesB.length}件</p>}
                    </div>
                  </div>

                  {compareMode === 'psd-tiff' && (
                    <div className="mt-4 flex gap-2 text-xs">
                      <span className={cropBounds ? 'text-green-400' : 'text-neutral-500'}>1. JSON {cropBounds ? 'OK' : '...'}</span>
                      <span className="text-neutral-600">→</span>
                      <span className={filesA.length > 0 ? 'text-green-400' : 'text-neutral-500'}>2. PSD {filesA.length > 0 ? 'OK' : '...'}</span>
                      <span className="text-neutral-600">→</span>
                      <span className={filesB.length > 0 ? 'text-green-400' : 'text-neutral-500'}>3. TIFF {filesB.length > 0 ? 'OK' : '...'}</span>
                    </div>
                  )}
                </div>
              )}

              {/* ファイル未読み込み時のヘルプ表示 */}
              {showHelp && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowHelp(false)} />
                  <div className="absolute top-4 right-4 z-50 bg-neutral-900/95 backdrop-blur border border-neutral-700 rounded-lg shadow-2xl p-4 text-sm min-w-64">
                    <div className="text-neutral-200 font-bold mb-3 flex items-center gap-2">
                      <HelpCircle size={16} /> 操作方法
                    </div>
                    <div className="space-y-1.5 text-neutral-300">
                      <div className="flex justify-between"><span className="text-neutral-500">Space</span><span>A/B 切り替え</span></div>
                      <div className="flex justify-between"><span className="text-neutral-500">Ctrl+Space</span><span>差分表示トグル</span></div>
                      <div className="flex justify-between"><span className="text-neutral-500">↑ / ↓</span><span>{compareMode === 'pdf-pdf' ? 'ページ移動' : 'ファイル選択'}</span></div>
                      {(compareMode === 'psd-psd' || compareMode === 'psd-tiff') && <div className="flex justify-between"><span className="text-neutral-500">P</span><span>Photoshopで開く</span></div>}
                      {compareMode === 'pdf-pdf' && <div className="flex justify-between"><span className="text-neutral-500">Q</span><span>MojiQで開く</span></div>}
                      <div className="flex justify-between"><span className="text-neutral-500">C</span><span>スクリーンショット</span></div>
                      <div className="border-t border-neutral-700 my-2" />
                      <div className="flex justify-between"><span className="text-neutral-500">Ctrl+-/+</span><span>ズーム</span></div>
                      <div className="flex justify-between"><span className="text-neutral-500">Ctrl+0</span><span>全体表示に戻す</span></div>
                      <div className="flex justify-between"><span className="text-neutral-500">ドラッグ</span><span>パン移動（拡大時）</span></div>
                      {viewMode === 'diff' && <div className="flex justify-between"><span className="text-neutral-500">ホイール</span><span>ページ切替</span></div>}
                    </div>
                  </div>
                </>
              )}
              </>
            )}
          </div>

          {!isFullscreen && (
          <div className="h-8 bg-neutral-900 border-t border-neutral-800 flex items-center px-4 text-xs text-neutral-500 justify-between shrink-0">
            <div className="flex items-center gap-3">
              <span>#{selectedIndex + 1}</span>
              {currentPair?.nameA && <span>{currentPair.nameA}</span>}
              {compareMode === 'pdf-pdf' && currentPair?.totalPages && currentPair.totalPages > 1 && <span className="text-rose-300">P.{currentPage}/{currentPair.totalPages}</span>}
              {currentPair?.hasDiff && (
                <>
                  <span className="text-red-400">差分あり</span>
                  {currentMarkers.length > 0 && <span className="text-cyan-400 flex items-center gap-1"><Target size={10} />{currentMarkers.length}箇所</span>}
                </>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className={`px-2 py-0.5 rounded ${compareMode === 'psd-tiff' ? 'bg-orange-900/50 text-orange-300' : compareMode === 'psd-psd' ? 'bg-purple-900/50 text-purple-300' : compareMode === 'pdf-pdf' ? 'bg-rose-900/50 text-rose-300' : 'bg-blue-900/50 text-blue-300'}`}>
                {compareMode === 'psd-tiff' ? 'PSD-TIFF' : compareMode === 'psd-psd' ? 'PSD-PSD' : compareMode === 'pdf-pdf' ? `PDF-PDF ${preloadProgress.total > 0 ? `(${preloadProgress.loaded}/${preloadProgress.total})` : ''}` : 'TIFF-TIFF'}
              </span>
            </div>
          </div>
          )}
        </div>
        ) : (
        /* 並列ビューモードのMain Viewer */
        <div className="flex-1 flex flex-col bg-black relative">
          {/* ヘッダー */}
          {!isFullscreen && (() => {
            const hasPsdInParallel = parallelFilesA.some(f => f.type === 'psd') || parallelFilesB.some(f => f.type === 'psd');
            return (
          <div className={`h-12 bg-neutral-800 border-b border-neutral-700 flex items-center justify-between z-10 shrink-0 ${hasPsdInParallel ? 'px-3' : 'px-4'}`}>
            <div className={`flex items-center flex-nowrap shrink-0 ${hasPsdInParallel ? 'gap-1.5' : 'gap-2'}`}>
              <span className={`text-green-400 flex items-center ${hasPsdInParallel ? 'text-xs gap-1.5' : 'text-sm gap-2'}`}>
                <Columns2 size={hasPsdInParallel ? 14 : 16} />
                並列ビュー
              </span>
            </div>
            <div className={`flex items-center flex-nowrap text-xs text-neutral-400 ${hasPsdInParallel ? 'gap-1.5' : 'gap-2'}`}>
              {/* Photoshopで開くボタン */}
              {(() => {
                const currentFileA = parallelFilesA[parallelIndexA];
                const currentFileB = parallelFilesB[parallelIndexB];
                const hasPsdA = currentFileA?.type === 'psd';
                const hasPsdB = currentFileB?.type === 'psd';
                if (!hasPsdA && !hasPsdB) return null;
                return (
                  <div className="relative">
                    <button
                      onClick={() => {
                        if (!parallelSyncMode) {
                          // 非同期モード: アクティブパネル側を直接開く
                          const file = parallelActivePanel === 'A' ? currentFileA : currentFileB;
                          if (file?.type === 'psd') {
                            invoke('open_file_with_default_app', { path: file.path });
                          }
                        } else {
                          setShowPsSelectPopup(!showPsSelectPopup);
                        }
                      }}
                      className={`flex items-center rounded border transition-colors bg-purple-900/50 border-purple-700 text-purple-300 hover:bg-purple-800/50 ${hasPsdInParallel ? 'gap-1 px-2.5 py-1.5' : 'gap-1.5 px-3 py-1.5'}`}
                      title="Photoshopで開く (P)"
                    >
                      <Layers size={hasPsdInParallel ? 12 : 14} />
                      Photoshop<span className={`opacity-60 ${hasPsdInParallel ? 'text-[11px]' : ''}`}>[P]</span>
                    </button>

                    {/* 選択ポップアップ */}
                    {showPsSelectPopup && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setShowPsSelectPopup(false)} />
                        <div className="absolute top-full right-0 mt-2 p-2 bg-neutral-800 rounded-lg shadow-xl border border-neutral-600 z-50 min-w-48">
                          <button
                            onClick={() => {
                              if (currentFileA?.path) invoke('open_file_with_default_app', { path: currentFileA.path });
                              setShowPsSelectPopup(false);
                            }}
                            disabled={!hasPsdA}
                            className="w-full text-left px-3 py-2 rounded text-sm hover:bg-neutral-700 disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2"
                          >
                            <span className="text-blue-400 shrink-0">A側</span>
                            <span className="text-neutral-400 truncate">{currentFileA?.name || '-'}</span>
                          </button>
                          <button
                            onClick={() => {
                              if (currentFileB?.path) invoke('open_file_with_default_app', { path: currentFileB.path });
                              setShowPsSelectPopup(false);
                            }}
                            disabled={!hasPsdB}
                            className="w-full text-left px-3 py-2 rounded text-sm hover:bg-neutral-700 disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2"
                          >
                            <span className="text-green-400 shrink-0">B側</span>
                            <span className="text-neutral-400 truncate">{currentFileB?.name || '-'}</span>
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}
              {/* MojiQで開くボタン */}
              {(() => {
                const currentFileA = parallelFilesA[parallelIndexA];
                const currentFileB = parallelFilesB[parallelIndexB];
                const hasPdfA = currentFileA?.type === 'pdf';
                const hasPdfB = currentFileB?.type === 'pdf';
                if (!hasPdfA && !hasPdfB) return null;
                const hasBothPdf = hasPdfA && hasPdfB;
                return (
                  <div className="relative">
                    <button
                      onClick={() => {
                        // 非同期モードまたは片方のみPDFの場合は直接開く
                        if (!parallelSyncMode || !hasBothPdf) {
                          const file = parallelActivePanel === 'A' ? currentFileA : currentFileB;
                          if (file?.type === 'pdf') {
                            releaseMemoryBeforeMojiQ();
                            setTimeout(() => invoke('open_pdf_in_mojiq', { pdfPath: file.path, page: file.pdfPage || 1 }), 100);
                          }
                        } else {
                          // 同期モードで両方PDFの場合はポップアップ
                          setShowMojiQSelectPopup(!showMojiQSelectPopup);
                        }
                      }}
                      className={`flex items-center rounded border transition-colors bg-rose-900/50 border-rose-700 text-rose-300 hover:bg-rose-800/50 ${hasPsdInParallel ? 'gap-1 px-2.5 py-1.5' : 'gap-1.5 px-3 py-1.5'}`}
                      title="MojiQで開く (Q)"
                    >
                      <FileText size={hasPsdInParallel ? 12 : 14} />
                      MojiQ<span className={`opacity-60 ${hasPsdInParallel ? 'text-[11px]' : ''}`}>[Q]</span>
                    </button>

                    {/* 選択ポップアップ */}
                    {showMojiQSelectPopup && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setShowMojiQSelectPopup(false)} />
                        <div className="absolute top-full right-0 mt-2 p-2 bg-neutral-800 rounded-lg shadow-xl border border-neutral-600 z-50 min-w-48">
                          <button
                            onClick={() => {
                              if (currentFileA?.type === 'pdf') {
                                releaseMemoryBeforeMojiQ();
                                setTimeout(() => invoke('open_pdf_in_mojiq', { pdfPath: currentFileA.path, page: currentFileA.pdfPage || 1 }), 100);
                              }
                              setShowMojiQSelectPopup(false);
                            }}
                            disabled={!hasPdfA}
                            className="w-full text-left px-3 py-2 rounded text-sm hover:bg-neutral-700 disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2"
                          >
                            <span className="text-blue-400 shrink-0">A側</span>
                            <span className="text-neutral-400 truncate">{currentFileA?.name || '-'}</span>
                          </button>
                          <button
                            onClick={() => {
                              if (currentFileB?.type === 'pdf') {
                                releaseMemoryBeforeMojiQ();
                                setTimeout(() => invoke('open_pdf_in_mojiq', { pdfPath: currentFileB.path, page: currentFileB.pdfPage || 1 }), 100);
                              }
                              setShowMojiQSelectPopup(false);
                            }}
                            disabled={!hasPdfB}
                            className="w-full text-left px-3 py-2 rounded text-sm hover:bg-neutral-700 disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2"
                          >
                            <span className="text-green-400 shrink-0">B側</span>
                            <span className="text-neutral-400 truncate">{currentFileB?.name || '-'}</span>
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}
              {/* フォルダを開くボタン */}
              {(() => {
                const folderPathA = getParallelFolderPath('A');
                const folderPathB = getParallelFolderPath('B');
                if (!folderPathA && !folderPathB) return null;
                const hasBothFolders = folderPathA && folderPathB;
                return (
                  <div className="relative">
                    <button
                      onClick={() => {
                        if (!parallelSyncMode || !hasBothFolders) {
                          // 非同期モードまたは片方のみの場合は直接開く
                          const folderPath = parallelActivePanel === 'A' ? folderPathA : folderPathB;
                          openFolderInExplorer(folderPath || (folderPathA || folderPathB));
                        } else {
                          // 同期モードで両方ある場合はポップアップ
                          setShowFolderSelectPopup(!showFolderSelectPopup);
                        }
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded border transition-colors bg-amber-900/50 border-amber-700 text-amber-300 hover:bg-amber-800/50"
                      title="フォルダを開く"
                    >
                      <FolderOpen size={14} />
                      フォルダ
                    </button>

                    {/* 選択ポップアップ */}
                    {showFolderSelectPopup && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setShowFolderSelectPopup(false)} />
                        <div className="absolute top-full right-0 mt-2 p-2 bg-neutral-800 rounded-lg shadow-xl border border-neutral-600 z-50 min-w-48">
                          <button
                            onClick={() => {
                              openFolderInExplorer(folderPathA);
                              setShowFolderSelectPopup(false);
                            }}
                            disabled={!folderPathA}
                            className="w-full text-left px-3 py-2 rounded text-sm hover:bg-neutral-700 disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2"
                          >
                            <span className="text-blue-400 shrink-0">A側</span>
                            <span className="text-neutral-400 truncate">{parallelFolderA?.split(/[/\\]/).pop() || '-'}</span>
                          </button>
                          <button
                            onClick={() => {
                              openFolderInExplorer(folderPathB);
                              setShowFolderSelectPopup(false);
                            }}
                            disabled={!folderPathB}
                            className="w-full text-left px-3 py-2 rounded text-sm hover:bg-neutral-700 disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2"
                          >
                            <span className="text-green-400 shrink-0">B側</span>
                            <span className="text-neutral-400 truncate">{parallelFolderB?.split(/[/\\]/).pop() || '-'}</span>
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}
              {/* 同期/非同期切り替え */}
              {(parallelFilesA.length > 0 || parallelFilesB.length > 0) && (
                <div className="relative flex items-center">
                  <div className="flex rounded overflow-hidden border border-neutral-600">
                    {/* 同期ボタン */}
                    <button
                      onClick={() => {
                        if (!parallelSyncMode) {
                          setShowSyncOptions(true);
                        }
                      }}
                      className={`px-3 py-1.5 text-xs flex items-center gap-1 transition ${
                        parallelSyncMode
                          ? 'bg-blue-900/50 text-blue-300'
                          : 'bg-neutral-700 text-neutral-500 hover:bg-neutral-600'
                      }`}
                      title="同期モード"
                    >
                      <Link2 size={12} />同期
                    </button>
                    {/* 非同期ボタン */}
                    <button
                      onClick={() => {
                        if (parallelSyncMode) {
                          setParallelSyncMode(false);
                          setParallelActivePanel('A');
                          setShowSyncOptions(false);
                        }
                      }}
                      className={`px-3 py-1.5 text-xs flex items-center gap-1 transition ${
                        !parallelSyncMode
                          ? 'bg-orange-900/50 text-orange-300'
                          : 'bg-neutral-700 text-neutral-500 hover:bg-neutral-600'
                      }`}
                      title="非同期モード"
                    >
                      <Unlink2 size={12} />非同期
                    </button>
                  </div>
                  {/* 再同期オプションポップアップ */}
                  {!parallelSyncMode && showSyncOptions && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setShowSyncOptions(false)} />
                      <div className="absolute top-full left-0 mt-1 z-50">
                        <div className="p-1 bg-neutral-800 rounded-lg shadow-xl border border-neutral-600 whitespace-nowrap flex flex-col gap-1">
                        <button
                          onClick={() => {
                            setParallelSyncMode(true);
                            setShowSyncOptions(false);
                          }}
                          className="px-3 py-1.5 text-xs bg-blue-900/50 hover:bg-blue-800/50 border border-blue-700 text-blue-300 rounded transition"
                        >
                          このまま再同期
                        </button>
                        <button
                          onClick={() => {
                            const targetIndex = parallelActivePanel === 'A' ? parallelIndexA : parallelIndexB;
                            setParallelIndexA(targetIndex);
                            setParallelIndexB(targetIndex);
                            setParallelSyncMode(true);
                            setShowSyncOptions(false);
                          }}
                          className="px-3 py-1.5 text-xs bg-green-900/50 hover:bg-green-800/50 border border-green-700 text-green-300 rounded transition"
                        >
                          ページを合わせて再同期
                        </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
              {/* 更新ボタン */}
              {(parallelFilesA.length > 0 || parallelFilesB.length > 0) && (
                <button
                  onClick={refreshParallelView}
                  disabled={parallelLoading}
                  className={`flex items-center rounded border transition-colors bg-teal-900/50 border-teal-700 text-teal-300 hover:bg-teal-800/50 disabled:opacity-30 ${hasPsdInParallel ? 'gap-1 px-2.5 py-1.5' : 'gap-1.5 px-3 py-1.5'}`}
                  title="ファイルを再読み込み (F5)"
                >
                  <RefreshCw size={hasPsdInParallel ? 12 : 14} />
                  更新<span className={`opacity-60 ${hasPsdInParallel ? 'text-[11px]' : ''}`}>[F5]</span>
                </button>
              )}
              {/* 全画面ボタン */}
              <button
                onClick={toggleFullscreen}
                className={`flex items-center rounded border transition-colors bg-neutral-700 border-neutral-600 text-neutral-300 hover:bg-neutral-600 ${hasPsdInParallel ? 'gap-1 px-2.5 py-1.5' : 'gap-1.5 px-3 py-1.5'}`}
                title="全画面表示 (F11)"
              >
                <Maximize2 size={hasPsdInParallel ? 12 : 14} />
                <span className={`opacity-60 ${hasPsdInParallel ? 'text-[11px]' : ''}`}>[F11]</span>
              </button>
              {/* ショートカットヒント（クリックで詳細表示） */}
              <button
                onClick={() => setShowHelp(!showHelp)}
                className="flex items-center gap-2 text-[11px] px-2 py-1 bg-neutral-900 rounded border border-neutral-700 hover:bg-neutral-700 transition-colors"
                title="クリックで詳細表示"
              >
                <span className="flex items-center gap-1">
                  <kbd className="px-1 py-0.5 bg-neutral-700 rounded text-neutral-200 font-mono text-[10px] border border-neutral-500">↑↓</kbd>
                  <span className="text-neutral-300">移動</span>
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1 py-0.5 bg-neutral-700 rounded text-neutral-200 font-mono text-[10px] border border-neutral-500">S</kbd>
                  <span className="text-neutral-300">同期</span>
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1 py-0.5 bg-neutral-700 rounded text-neutral-200 font-mono text-[10px] border border-neutral-500">C</kbd>
                  <span className="text-neutral-300">指示</span>
                </span>
                <HelpCircle size={11} className="text-neutral-400" />
              </button>
            </div>
          </div>
            );
          })()}

          {/* 左右分割ビューア */}
          <div className="flex-1 flex min-h-0">
            {/* 左パネル (フォルダ/PDFA) */}
            <div
              ref={parallelDropZoneARef}
              className={`flex-1 flex flex-col border-r border-neutral-700 ${dragOverSide === 'parallelA' ? 'ring-2 ring-blue-500 ring-inset bg-blue-900/20' : ''} ${!parallelSyncMode && parallelActivePanel === 'A' ? 'ring-2 ring-blue-400 ring-inset' : ''}`}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverSide('parallelA'); }}
              onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverSide(null); }}
              onDrop={(e) => handleParallelDrop(e, 'A')}
              onClick={() => !parallelSyncMode && setParallelActivePanel('A')}
            >
              {!isFullscreen && (
              <div className={`h-10 border-b border-neutral-700 flex items-center px-3 text-xs ${!parallelSyncMode && parallelActivePanel === 'A' ? 'bg-blue-900/30 text-blue-300' : 'bg-neutral-900 text-blue-400'}`}>
                {parallelFilesA[0]?.type === 'pdf' ? <FileText size={12} className="mr-2" /> : <FolderOpen size={12} className="mr-2" />}
                <span className="truncate max-w-32">{parallelFolderA ? parallelFolderA.split(/[/\\]/).pop() : 'A'}</span>
                {/* 単ページ化ボタン（PDF時のみ） */}
                {parallelFilesA.length > 0 && parallelFilesA[0]?.type === 'pdf' && (
                  <div className="ml-2 relative group">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const newMode = !spreadSplitModeA;
                        setSpreadSplitModeA(newMode);
                        const firstEntry = parallelFilesA[0];
                        if (firstEntry?.path && firstEntry.type === 'pdf') {
                          expandPdfToParallelEntries(firstEntry.path, 'A', firstEntry.pdfFile, newMode);
                        }
                      }}
                      className={`px-3 py-1 rounded text-sm text-white transition flex items-center gap-1.5 font-medium ${spreadSplitModeA ? 'bg-orange-600 hover:bg-orange-500' : 'bg-neutral-600 hover:bg-neutral-500'}`}
                      title="見開きPDFを単ページに分割"
                    >
                      <BookOpen size={14} />
                      単ページ化
                    </button>
                    <div className="hidden group-hover:block absolute top-full left-0 pt-1 z-50">
                      <div className="p-2 bg-neutral-800 rounded-lg shadow-xl border border-neutral-600 whitespace-nowrap">
                        <label className="flex items-center gap-2 cursor-pointer text-sm text-neutral-300 hover:text-white" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={firstPageSingleA}
                            onChange={(e) => setFirstPageSingleA(e.target.checked)}
                            className="w-4 h-4 rounded border-neutral-500 bg-neutral-700"
                          />
                          1P単独
                        </label>
                      </div>
                    </div>
                  </div>
                )}
                {!parallelSyncMode && parallelFilesA.length > 0 && (
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      onClick={(e) => { e.stopPropagation(); setParallelActivePanel('A'); setParallelIndexA(prev => Math.max(prev - 1, 0)); }}
                      disabled={parallelIndexA <= 0}
                      className="px-1 hover:bg-neutral-700 rounded disabled:opacity-30"
                    >▲</button>
                    <span className="px-1 text-neutral-400">{parallelIndexA + 1}/{parallelFilesA.length}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); setParallelActivePanel('A'); setParallelIndexA(prev => Math.min(prev + 1, parallelFilesA.length - 1)); }}
                      disabled={parallelIndexA >= parallelFilesA.length - 1}
                      className="px-1 hover:bg-neutral-700 rounded disabled:opacity-30"
                    >▼</button>
                  </div>
                )}
              </div>
              )}
              <div
                className={`flex-1 flex items-center justify-center bg-neutral-950 ${isFullscreen ? '' : 'p-4'} overflow-hidden relative`}
                style={{ cursor: parallelZoomA > 1 ? (isDraggingParallelA ? 'grabbing' : 'grab') : 'default' }}
                onWheel={(e) => {
                  e.preventDefault();
                  // 非同期モードでアクティブパネルでない場合は無視
                  if (!parallelSyncMode && parallelActivePanel !== 'A') return;
                  if (e.deltaY > 0) {
                    // 下スクロール = 次のファイル
                    setParallelIndexA(i => Math.min(i + 1, parallelFilesA.length - 1));
                    if (parallelSyncMode) setParallelIndexB(i => Math.min(i + 1, parallelFilesB.length - 1));
                  } else {
                    // 上スクロール = 前のファイル
                    setParallelIndexA(i => Math.max(i - 1, 0));
                    if (parallelSyncMode) setParallelIndexB(i => Math.max(i - 1, 0));
                  }
                }}
                onMouseDown={handleParallelMouseDownA}
                onMouseMove={handleParallelMouseMoveA}
                onMouseUp={handleParallelMouseUpA}
                onMouseLeave={handleParallelMouseUpA}
              >
                {/* ドラッグオーバー時のオーバーレイ */}
                {dragOverSide === 'parallelA' && (
                  <div className="absolute inset-0 bg-blue-600/50 flex items-center justify-center z-10 pointer-events-none">
                    <div className="bg-blue-800/90 text-white px-6 py-3 rounded-lg shadow-xl text-lg font-bold">
                      ドロップで切り替え
                    </div>
                  </div>
                )}
                {/* PDF表示: Canvas直接レンダリング（MojiQと同様） */}
                {parallelFilesA[parallelIndexA]?.type === 'pdf' ? (
                  <>
                    <canvas
                      ref={parallelPdfCanvasARef}
                      className="max-w-full max-h-full object-contain shadow-2xl bg-white"
                      style={{ transform: `scale(${parallelZoomA}) translate(${parallelPanA.x / parallelZoomA}px, ${parallelPanA.y / parallelZoomA}px)`, transformOrigin: 'center center' }}
                    />
                    {!isFullscreen && parallelPdfCanvasARef.current && (
                      instructionButtonsHidden ? (
                        <button
                          onClick={() => setInstructionButtonsHidden(false)}
                          className="absolute bottom-6 right-2 p-2 text-white/0 hover:text-white/60 hover:bg-black/20 rounded-lg transition-all"
                          title="指示エディタボタンを表示"
                        >
                          <EyeOff size={16} />
                        </button>
                      ) : (
                        <div className="absolute bottom-6 right-2 flex flex-col items-end gap-1">
                          <button
                            onClick={() => setInstructionButtonsHidden(true)}
                            className="p-1 text-white/50 hover:text-white/80 transition-colors"
                            title="指示エディタボタンを非表示"
                          >
                            <Eye size={14} />
                          </button>
                          <button
                            onClick={async () => {
                              const canvas = parallelPdfCanvasARef.current;
                              if (canvas) setParallelCapturedImageA(canvas.toDataURL('image/jpeg', 0.92));
                            }}
                            className="flex items-center gap-1.5 px-3 py-2 bg-blue-600/90 hover:bg-blue-500 text-white rounded-lg shadow-lg transition-colors text-sm"
                            title="指示エディタを開く (C)"
                          >
                            <Edit3 size={16} />
                            指示
                          </button>
                        </div>
                      )
                    )}
                  </>
                ) : parallelImageA ? (
                  <>
                    <img
                      src={parallelImageA}
                      alt="A"
                      className="max-w-full max-h-full object-contain shadow-2xl bg-white"
                      draggable={false}
                      style={{ transform: `scale(${parallelZoomA}) translate(${parallelPanA.x / parallelZoomA}px, ${parallelPanA.y / parallelZoomA}px)`, transformOrigin: 'center center' }}
                    />
                    {!isFullscreen && !parallelSyncMode && parallelZoomA !== 1 && (
                      <div className="absolute top-2 left-2 px-2 py-1 bg-black/60 text-white text-xs rounded">
                        {Math.round(parallelZoomA * 100)}% (Ctrl+0でリセット)
                      </div>
                    )}
                    {!isFullscreen && (
                      instructionButtonsHidden ? (
                        <button
                          onClick={() => setInstructionButtonsHidden(false)}
                          className="absolute bottom-6 right-2 p-2 text-white/0 hover:text-white/60 hover:bg-black/20 rounded-lg transition-all"
                          title="指示エディタボタンを表示"
                        >
                          <EyeOff size={16} />
                        </button>
                      ) : (
                        <div className="absolute bottom-6 right-2 flex flex-col items-end gap-1">
                          <button
                            onClick={() => setInstructionButtonsHidden(true)}
                            className="p-1 text-white/50 hover:text-white/80 transition-colors"
                            title="指示エディタボタンを非表示"
                          >
                            <Eye size={14} />
                          </button>
                          <button
                            onClick={() => setParallelCapturedImageA(parallelImageA)}
                            className="flex items-center gap-1.5 px-3 py-2 bg-blue-600/90 hover:bg-blue-500 text-white rounded-lg shadow-lg transition-colors text-sm"
                            title="指示エディタを開く (C)"
                          >
                            <Edit3 size={16} />
                            指示
                          </button>
                        </div>
                      )
                    )}
                  </>
                ) : parallelLoading ? (
                  <Loader2 size={32} className="animate-spin text-blue-400 opacity-50" />
                ) : parallelFilesA.length > 0 ? (
                  <div className="text-neutral-600 text-sm">読み込み中...</div>
                ) : (
                  <div className="text-neutral-600 text-sm flex flex-col items-center gap-3">
                    <div className="flex items-center gap-4 opacity-30">
                      <FolderOpen size={36} />
                      <span className="text-2xl">/</span>
                      <FileText size={36} />
                    </div>
                    <div className="text-center">
                      <div className="mb-2">フォルダまたはPDFをドロップ</div>
                      <div className="flex gap-2 justify-center">
                        <button
                          onClick={() => handleSelectParallelFolder('A')}
                          className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded text-xs transition"
                        >
                          フォルダ選択
                        </button>
                        <button
                          onClick={() => handleSelectParallelPdf('A')}
                          className="px-3 py-1.5 bg-blue-900/50 hover:bg-blue-800 rounded text-xs transition text-blue-300"
                        >
                          PDF選択
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* 右パネル (フォルダ/PDFB) */}
            <div
              ref={parallelDropZoneBRef}
              className={`flex-1 flex flex-col ${dragOverSide === 'parallelB' ? 'ring-2 ring-green-500 ring-inset bg-green-900/20' : ''} ${!parallelSyncMode && parallelActivePanel === 'B' ? 'ring-2 ring-green-400 ring-inset' : ''}`}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverSide('parallelB'); }}
              onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverSide(null); }}
              onDrop={(e) => handleParallelDrop(e, 'B')}
              onClick={() => !parallelSyncMode && setParallelActivePanel('B')}
            >
              {!isFullscreen && (
              <div className={`h-10 border-b border-neutral-700 flex items-center px-3 text-xs ${!parallelSyncMode && parallelActivePanel === 'B' ? 'bg-green-900/30 text-green-300' : 'bg-neutral-900 text-green-400'}`}>
                {parallelFilesB[0]?.type === 'pdf' ? <FileText size={12} className="mr-2" /> : <FolderOpen size={12} className="mr-2" />}
                <span className="truncate max-w-32">{parallelFolderB ? parallelFolderB.split(/[/\\]/).pop() : 'B'}</span>
                {/* 単ページ化ボタン（PDF時のみ） */}
                {parallelFilesB.length > 0 && parallelFilesB[0]?.type === 'pdf' && (
                  <div className="ml-2 relative group">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const newMode = !spreadSplitModeB;
                        setSpreadSplitModeB(newMode);
                        const firstEntry = parallelFilesB[0];
                        if (firstEntry?.path && firstEntry.type === 'pdf') {
                          expandPdfToParallelEntries(firstEntry.path, 'B', firstEntry.pdfFile, newMode);
                        }
                      }}
                      className={`px-3 py-1 rounded text-sm text-white transition flex items-center gap-1.5 font-medium ${spreadSplitModeB ? 'bg-orange-600 hover:bg-orange-500' : 'bg-neutral-600 hover:bg-neutral-500'}`}
                      title="見開きPDFを単ページに分割"
                    >
                      <BookOpen size={14} />
                      単ページ化
                    </button>
                    <div className="hidden group-hover:block absolute top-full left-0 pt-1 z-50">
                      <div className="p-2 bg-neutral-800 rounded-lg shadow-xl border border-neutral-600 whitespace-nowrap">
                        <label className="flex items-center gap-2 cursor-pointer text-sm text-neutral-300 hover:text-white" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={firstPageSingleB}
                            onChange={(e) => setFirstPageSingleB(e.target.checked)}
                            className="w-4 h-4 rounded border-neutral-500 bg-neutral-700"
                          />
                          1P単独
                        </label>
                      </div>
                    </div>
                  </div>
                )}
                {!parallelSyncMode && parallelFilesB.length > 0 && (
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      onClick={(e) => { e.stopPropagation(); setParallelActivePanel('B'); setParallelIndexB(prev => Math.max(prev - 1, 0)); }}
                      disabled={parallelIndexB <= 0}
                      className="px-1 hover:bg-neutral-700 rounded disabled:opacity-30"
                    >▲</button>
                    <span className="px-1 text-neutral-400">{parallelIndexB + 1}/{parallelFilesB.length}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); setParallelActivePanel('B'); setParallelIndexB(prev => Math.min(prev + 1, parallelFilesB.length - 1)); }}
                      disabled={parallelIndexB >= parallelFilesB.length - 1}
                      className="px-1 hover:bg-neutral-700 rounded disabled:opacity-30"
                    >▼</button>
                  </div>
                )}
              </div>
              )}
              <div
                className={`flex-1 flex items-center justify-center bg-neutral-950 ${isFullscreen ? '' : 'p-4'} overflow-hidden relative`}
                style={{ cursor: parallelZoomB > 1 ? (isDraggingParallelB ? 'grabbing' : 'grab') : 'default' }}
                onWheel={(e) => {
                  e.preventDefault();
                  // 非同期モードでアクティブパネルでない場合は無視
                  if (!parallelSyncMode && parallelActivePanel !== 'B') return;
                  if (e.deltaY > 0) {
                    // 下スクロール = 次のファイル
                    setParallelIndexB(i => Math.min(i + 1, parallelFilesB.length - 1));
                    if (parallelSyncMode) setParallelIndexA(i => Math.min(i + 1, parallelFilesA.length - 1));
                  } else {
                    // 上スクロール = 前のファイル
                    setParallelIndexB(i => Math.max(i - 1, 0));
                    if (parallelSyncMode) setParallelIndexA(i => Math.max(i - 1, 0));
                  }
                }}
                onMouseDown={handleParallelMouseDownB}
                onMouseMove={handleParallelMouseMoveB}
                onMouseUp={handleParallelMouseUpB}
                onMouseLeave={handleParallelMouseUpB}
              >
                {/* ドラッグオーバー時のオーバーレイ */}
                {dragOverSide === 'parallelB' && (
                  <div className="absolute inset-0 bg-green-600/50 flex items-center justify-center z-10 pointer-events-none">
                    <div className="bg-green-800/90 text-white px-6 py-3 rounded-lg shadow-xl text-lg font-bold">
                      ドロップで切り替え
                    </div>
                  </div>
                )}
                {/* PDF表示: Canvas直接レンダリング（MojiQと同様） */}
                {parallelFilesB[parallelIndexB]?.type === 'pdf' ? (
                  <>
                    <canvas
                      ref={parallelPdfCanvasBRef}
                      className="max-w-full max-h-full object-contain shadow-2xl bg-white"
                      style={{ transform: `scale(${parallelZoomB}) translate(${parallelPanB.x / parallelZoomB}px, ${parallelPanB.y / parallelZoomB}px)`, transformOrigin: 'center center' }}
                    />
                    {!isFullscreen && parallelPdfCanvasBRef.current && (
                      instructionButtonsHidden ? (
                        <button
                          onClick={() => setInstructionButtonsHidden(false)}
                          className="absolute bottom-6 right-2 p-2 text-white/0 hover:text-white/60 hover:bg-black/20 rounded-lg transition-all"
                          title="指示エディタボタンを表示"
                        >
                          <EyeOff size={16} />
                        </button>
                      ) : (
                        <div className="absolute bottom-6 right-2 flex flex-col items-end gap-1">
                          <button
                            onClick={() => setInstructionButtonsHidden(true)}
                            className="p-1 text-white/50 hover:text-white/80 transition-colors"
                            title="指示エディタボタンを非表示"
                          >
                            <Eye size={14} />
                          </button>
                          <button
                            onClick={async () => {
                              const canvas = parallelPdfCanvasBRef.current;
                              if (canvas) setParallelCapturedImageB(canvas.toDataURL('image/jpeg', 0.92));
                            }}
                            className="flex items-center gap-1.5 px-3 py-2 bg-green-600/90 hover:bg-green-500 text-white rounded-lg shadow-lg transition-colors text-sm"
                            title="指示エディタを開く (C)"
                          >
                            <Edit3 size={16} />
                            指示
                          </button>
                        </div>
                      )
                    )}
                  </>
                ) : parallelImageB ? (
                  <>
                    <img
                      src={parallelImageB}
                      alt="B"
                      className="max-w-full max-h-full object-contain shadow-2xl bg-white"
                      draggable={false}
                      style={{ transform: `scale(${parallelZoomB}) translate(${parallelPanB.x / parallelZoomB}px, ${parallelPanB.y / parallelZoomB}px)`, transformOrigin: 'center center' }}
                    />
                    {!isFullscreen && !parallelSyncMode && parallelZoomB !== 1 && (
                      <div className="absolute top-2 left-2 px-2 py-1 bg-black/60 text-white text-xs rounded">
                        {Math.round(parallelZoomB * 100)}% (Ctrl+0でリセット)
                      </div>
                    )}
                    {!isFullscreen && (
                      instructionButtonsHidden ? (
                        <button
                          onClick={() => setInstructionButtonsHidden(false)}
                          className="absolute bottom-6 right-2 p-2 text-white/0 hover:text-white/60 hover:bg-black/20 rounded-lg transition-all"
                          title="指示エディタボタンを表示"
                        >
                          <EyeOff size={16} />
                        </button>
                      ) : (
                        <div className="absolute bottom-6 right-2 flex flex-col items-end gap-1">
                          <button
                            onClick={() => setInstructionButtonsHidden(true)}
                            className="p-1 text-white/50 hover:text-white/80 transition-colors"
                            title="指示エディタボタンを非表示"
                          >
                            <Eye size={14} />
                          </button>
                          <button
                            onClick={() => setParallelCapturedImageB(parallelImageB)}
                            className="flex items-center gap-1.5 px-3 py-2 bg-green-600/90 hover:bg-green-500 text-white rounded-lg shadow-lg transition-colors text-sm"
                            title="指示エディタを開く (C)"
                          >
                            <Edit3 size={16} />
                            指示
                          </button>
                        </div>
                      )
                    )}
                  </>
                ) : parallelLoading ? (
                  <Loader2 size={32} className="animate-spin text-green-400 opacity-50" />
                ) : parallelFilesB.length > 0 ? (
                  <div className="text-neutral-600 text-sm">読み込み中...</div>
                ) : (
                  <div className="text-neutral-600 text-sm flex flex-col items-center gap-3">
                    <div className="flex items-center gap-4 opacity-30">
                      <FolderOpen size={36} />
                      <span className="text-2xl">/</span>
                      <FileText size={36} />
                    </div>
                    <div className="text-center">
                      <div className="mb-2">フォルダまたはPDFをドロップ</div>
                      <div className="flex gap-2 justify-center">
                        <button
                          onClick={() => handleSelectParallelFolder('B')}
                          className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded text-xs transition"
                        >
                          フォルダ選択
                        </button>
                        <button
                          onClick={() => handleSelectParallelPdf('B')}
                          className="px-3 py-1.5 bg-green-900/50 hover:bg-green-800 rounded text-xs transition text-green-300"
                        >
                          PDF選択
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ヘルプオーバーレイ */}
          {!isFullscreen && showHelp && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowHelp(false)} />
              <div className="absolute top-16 right-4 z-50 bg-neutral-900/95 backdrop-blur border border-neutral-700 rounded-lg shadow-2xl p-4 text-sm min-w-64">
                <div className="text-neutral-200 font-bold mb-3 flex items-center gap-2">
                  <HelpCircle size={16} /> 並列ビュー操作方法
                </div>
                <div className="space-y-1.5 text-neutral-300">
                  <div className="flex justify-between"><span className="text-neutral-500">↑ / ↓</span><span>ページ移動</span></div>
                  <div className="flex justify-between"><span className="text-neutral-500">Home</span><span>最初のページ</span></div>
                  <div className="flex justify-between"><span className="text-neutral-500">End</span><span>最後のページ</span></div>
                  <div className="flex justify-between"><span className="text-neutral-500">S</span><span>非同期⇔同期（維持）</span></div>
                  <div className="flex justify-between"><span className="text-neutral-500">Shift+S</span><span>元に戻して再同期</span></div>
                  <div className="flex justify-between"><span className="text-neutral-500">← / →</span><span>パネル切替（非同期時）</span></div>
                  <div className="flex justify-between"><span className="text-neutral-500">C</span><span>指示エディタを開く</span></div>
                  <div className="flex justify-between"><span className="text-neutral-500">P</span><span>Photoshopで開く</span></div>
                  <div className="flex justify-between"><span className="text-neutral-500">Q</span><span>MojiQで開く（PDF）</span></div>
                  <div className="flex justify-between"><span className="text-neutral-500">V</span><span>モード切り替え</span></div>
                </div>
              </div>
            </>
          )}

          {/* フッター */}
          {!isFullscreen && (
          <div className="h-8 bg-neutral-900 border-t border-neutral-800 flex items-center px-4 text-xs text-neutral-500 justify-between shrink-0">
            <div className="flex items-center gap-3">
              {parallelIndexA === parallelIndexB ? (
                <span>#{parallelIndexA + 1}</span>
              ) : (
                <span className="text-orange-400">A:#{parallelIndexA + 1} B:#{parallelIndexB + 1}</span>
              )}
              {parallelFilesA[parallelIndexA] && (
                <span className="text-blue-400">{parallelFilesA[parallelIndexA].name}</span>
              )}
              {parallelFilesB[parallelIndexB] && (
                <span className="text-green-400">{parallelFilesB[parallelIndexB].name}</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="px-2 py-0.5 rounded bg-green-900/50 text-green-300">
                並列ビュー
              </span>
            </div>
          </div>
          )}
        </div>
        )}
      </div>

      <GDriveFolderBrowser
        isOpen={isGDriveBrowserOpen}
        onClose={() => setIsGDriveBrowserOpen(false)}
        onJsonSelect={(bounds, fileName) => {
          setCropBounds(bounds);
          setIsGDriveBrowserOpen(false);
          console.log('JSON読み込み完了:', fileName);
        }}
      />

      {capturedImage && (
        <ScreenshotEditor
          imageData={capturedImage}
          onClose={() => setCapturedImage(null)}
        />
      )}

      {/* 並列ビューモード用の指示エディタ (A) */}
      {parallelCapturedImageA && (
        <ScreenshotEditor
          imageData={parallelCapturedImageA}
          onClose={() => setParallelCapturedImageA(null)}
        />
      )}

      {/* 並列ビューモード用の指示エディタ (B) */}
      {parallelCapturedImageB && (
        <ScreenshotEditor
          imageData={parallelCapturedImageB}
          onClose={() => setParallelCapturedImageB(null)}
        />
      )}

      {/* 全画面ヒントポップアップ（Portal経由でbody直下にレンダリング） */}
      {createPortal(
        <div
          style={{
            position: 'fixed',
            top: '60px',
            left: '50%',
            transform: `translateX(-50%) translateY(${showFullscreenHint ? '0' : '-20px'})`,
            zIndex: 99999,
            pointerEvents: 'none',
            opacity: showFullscreenHint ? 1 : 0,
            transition: 'opacity 0.4s ease, transform 0.4s ease',
          }}
        >
          <div
            style={{
              backgroundColor: 'rgba(0, 0, 0, 0.85)',
              color: '#fff',
              padding: '12px 24px',
              borderRadius: '8px',
              fontSize: '16px',
              fontWeight: 500,
              whiteSpace: 'nowrap',
              boxShadow: '0 4px 20px rgba(0, 0, 0, 0.5)',
            }}
          >
            ESCで解除
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
