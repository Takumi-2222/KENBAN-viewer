import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle, AlertTriangle, Loader2, RefreshCw, Download } from 'lucide-react';
import { pdfCache, checkPdfFileSize, globalOptimizeProgress, setOptimizeProgressCallback } from './utils/pdf';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { readFile as tauriReadFile, readDir } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import GDriveFolderBrowser from './components/GDriveFolderBrowser';
import ScreenshotEditor from './components/ScreenshotEditor';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import DiffViewer from './components/DiffViewer';
import ParallelViewer from './components/ParallelViewer';
import type { CompareMode, AppMode, FileWithPath, CropBounds, DiffMarker, FilePair, PageCache, ParallelFileEntry, ParallelImageCache } from './types';



// ============== 差分検出アプリ ==============
export default function MangaDiffDetector() {
  const [compareMode, setCompareMode] = useState<CompareMode>('tiff-tiff');
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

  // ============== 自動更新 ==============
  const [updateDialogState, setUpdateDialogState] = useState<
    | { type: 'confirm'; version: string; notes?: string }
    | { type: 'downloading' }
    | { type: 'complete' }
    | { type: 'error'; message: string }
    | null
  >(null);
  const pendingUpdateRef = useRef<Awaited<ReturnType<typeof check>> | null>(null);

  const processingRef = useRef(false);
  const compareModeRef = useRef(compareMode); // モード変更を追跡
  const parallelDragStartRefA = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const parallelDragStartRefB = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  // モード切り替え関数（即座にペアをクリアして誤った処理を防ぐ）
  const handleModeChange = useCallback((newMode: 'tiff-tiff' | 'psd-psd' | 'pdf-pdf' | 'psd-tiff') => {
    // 現在のモードと同じ場合
    if (newMode === compareMode) {
      // 初期モード選択画面からの場合は画面を閉じる
      if (initialModeSelect) {
        setInitialModeSelect(false);
        setSidebarCollapsed(false);
      }
      return;
    }
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
  }, [compareMode, initialModeSelect]);

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

  // 起動時に更新チェック（2秒遅延でアプリ初期化を待つ）
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const update = await check();
        if (update) {
          pendingUpdateRef.current = update;
          setUpdateDialogState({
            type: 'confirm',
            version: update.version,
            notes: update.body || undefined
          });
        }
      } catch (e) {
        console.log('Update check failed:', e);
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  // 更新を実行
  const handleUpdate = async () => {
    if (!pendingUpdateRef.current) return;
    setUpdateDialogState({ type: 'downloading' });
    try {
      await pendingUpdateRef.current.downloadAndInstall();
      setUpdateDialogState({ type: 'complete' });
      setTimeout(async () => {
        await relaunch();
      }, 1500);
    } catch (e) {
      console.error('Update failed:', e);
      setUpdateDialogState({ type: 'error', message: String(e) });
    }
  };

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

  // 差分計算（シンプル版 + マーカー機能）— PDF差分用に残す
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

  // 差分画像にマーカーを描画（Rust側はマーカーなし画像+座標を返すので、JS側で描画）
  const drawMarkersOnImage = async (
    diffSrc: string, markers: DiffMarker[], mode: 'simple' | 'heatmap'
  ): Promise<string> => {
    if (!markers || markers.length === 0) return diffSrc;
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);

        const isHeatmap = mode === 'heatmap';
        const outerLineWidth = isHeatmap ? 8 : 6;
        const innerLineWidth = isHeatmap ? 3 : 2;
        const innerOffset = isHeatmap ? 5 : 4;
        const badgeRadius = isHeatmap ? 24 : 18;
        const badgeOffset = isHeatmap ? 30 : 20;
        const fontSize = isHeatmap ? 28 : 20;

        ctx.lineWidth = outerLineWidth;
        markers.forEach((marker, idx) => {
          // 外側シアン円
          ctx.strokeStyle = 'cyan';
          ctx.beginPath();
          ctx.arc(marker.x, marker.y, marker.radius, 0, Math.PI * 2);
          ctx.stroke();

          // 内側白円
          ctx.strokeStyle = 'white';
          ctx.lineWidth = innerLineWidth;
          ctx.beginPath();
          ctx.arc(marker.x, marker.y, marker.radius - innerOffset, 0, Math.PI * 2);
          ctx.stroke();
          ctx.lineWidth = outerLineWidth;

          // 番号バッジ
          const badgeY = marker.y - marker.radius - badgeOffset;
          ctx.fillStyle = 'cyan';
          ctx.beginPath();
          ctx.arc(marker.x, badgeY, badgeRadius, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'black';
          ctx.font = `bold ${fontSize}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(idx + 1), marker.x, badgeY);
        });

        resolve(canvas.toDataURL());
      };
      img.src = diffSrc;
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
          // ドロップ元のフォルダパスを保存（フォルダを開く機能で使用）
          const droppedPath = paths[0];
          if (side === 'A') {
            setDiffFolderA(droppedPath);
            setFilesA(sortedFiles);
          } else if (side === 'B') {
            setDiffFolderB(droppedPath);
            setFilesB(sortedFiles);
          }
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
        // Rust側でPSD読み込み+クロップ+TIFF読み込み+ヒートマップ差分を一括処理
        const result = await invoke<{
          src_a: string; src_b: string; processed_a: string; diff_src: string;
          has_diff: boolean; diff_probability: number; high_density_count: number;
          markers: DiffMarker[]; image_width: number; image_height: number;
        }>('compute_diff_heatmap', {
          psdPath: (pair.fileA as FileWithPath).filePath,
          tiffPath: (pair.fileB as FileWithPath).filePath,
          cropBounds, threshold: 70
        });
        if (compareModeRef.current !== startMode) return;

        const diffSrcWithMarkers = await drawMarkersOnImage(result.diff_src, result.markers, 'heatmap');
        if (compareModeRef.current !== startMode) return;

        setPairs(prev => {
          const next = [...prev];
          next[index] = { ...next[index],
            srcA: result.src_a, srcB: result.src_b,
            processedA: result.processed_a, processedB: result.src_b,
            diffSrc: result.diff_src, diffSrcWithMarkers,
            hasDiff: result.has_diff, diffProbability: result.diff_probability,
            markers: result.markers, imageWidth: result.image_width, imageHeight: result.image_height,
            status: 'done'
          };
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
        // Rust側でファイル読み込み+差分計算を一括処理（tiff-tiff / psd-psd）
        const result = await invoke<{
          src_a: string; src_b: string; diff_src: string;
          has_diff: boolean; diff_count: number;
          markers: DiffMarker[]; image_width: number; image_height: number;
        }>('compute_diff_simple', {
          pathA: (pair.fileA as FileWithPath).filePath,
          pathB: (pair.fileB as FileWithPath).filePath,
          threshold: 5
        });
        if (compareModeRef.current !== startMode) return;

        const diffSrcWithMarkers = await drawMarkersOnImage(result.diff_src, result.markers, 'simple');
        if (compareModeRef.current !== startMode) return;

        setPairs(prev => {
          const next = [...prev];
          next[index] = { ...next[index],
            srcA: result.src_a, srcB: result.src_b,
            processedA: result.src_a, processedB: result.src_b,
            diffSrc: result.diff_src, diffSrcWithMarkers,
            hasDiff: result.has_diff, markers: result.markers,
            status: 'done'
          };
          return next;
        });
      }
    } catch (err: any) {
      // モードが変わっていたらエラー処理もスキップ
      if (compareModeRef.current !== startMode) return;
      const errorMessage = typeof err === 'string' ? err : err?.message || String(err);
      console.error("Processing error:", errorMessage);
      setPairs(prev => {
        const next = [...prev];
        next[index] = { ...next[index], status: 'error', errorMessage };
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
        // PSDはRust側で処理
        const result = await invoke<{ data_url: string; width: number; height: number }>('parse_psd', { path: entry.path });
        setParallelImageCache(prev => ({
          ...prev,
          [cacheKey]: { dataUrl: result.data_url, width: result.width, height: result.height },
        }));
        return result.data_url;
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
            const result = await invoke<{ data_url: string; width: number; height: number }>('parse_psd', { path });
            setParallelImageCache(prev => ({
              ...prev,
              [cacheKey]: { dataUrl: result.data_url, width: result.width, height: result.height },
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
  // フォルダを開く
  const openFolderInExplorer = useCallback(async (folderPath: string | null) => {
    if (!folderPath) return;
    try {
      await invoke('open_folder', { path: folderPath });
    } catch (err) {
      console.error('Failed to open folder:', err);
    }
  }, []);

  // 全画面トランジション中フラグ（UI要素をCSSで収縮させる）
  const [fullscreenTransitioning, setFullscreenTransitioning] = useState(false);

  // 全画面トグル（バー収縮とウィンドウ拡大を同時に行い一つの動きに）
  const toggleFullscreen = useCallback(async () => {
    const window = getCurrentWebviewWindow();
    const current = await window.isFullscreen();
    const goingFullscreen = !current;

    if (goingFullscreen) {
      // バー収縮 + 全画面化を同時に開始 → 一つの滑らかな動き
      setFullscreenTransitioning(true);
      window.setFullscreen(true); // awaitしない＝同時進行
      // CSS transition(300ms)とWindows側の遷移が並行で走る
      await new Promise(r => setTimeout(r, 350));
      setIsFullscreen(true);
      setFullscreenTransitioning(false);
      setShowFullscreenHint(true);
      setTimeout(() => setShowFullscreenHint(false), 3000);
    } else {
      // 全画面解除 + バー展開を同時に開始
      window.setFullscreen(false); // awaitしない
      setIsFullscreen(false);
      // CSS transitionでバーが展開される
    }

  }, []);

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

  const handleReset = useCallback(() => {
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
  }, []);

  const handleClear = useCallback(() => {
    setFilesA([]);
    setFilesB([]);
    setPairs([]);
    setCropBounds(null);
    setPreloadProgress({ loaded: 0, total: 0 });
    pdfCache.clear();
  }, []);

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

      {/* 更新ダイアログ */}
      {updateDialogState && (
        <div
          className="fixed inset-0 flex items-center justify-center z-[10000]"
          style={{ background: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(4px)' }}
        >
          <div
            className="rounded-2xl p-8 text-center shadow-2xl max-w-sm w-full mx-4"
            style={{
              background: 'linear-gradient(145deg, #2a2a2a 0%, #1a1a1a 100%)',
              border: '1px solid rgba(255,255,255,0.1)',
            }}
          >
            {/* 確認ダイアログ */}
            {updateDialogState.type === 'confirm' && (
              <>
                <Download size={48} className="mx-auto mb-4 text-blue-400" />
                <h3 className="text-lg font-semibold text-white mb-3">新しいバージョンがあります</h3>
                <p className="text-sm text-gray-300 mb-1">
                  v{updateDialogState.version} が利用可能です。
                </p>
                <p className="text-sm text-gray-400 mb-6">今すぐアップデートしますか？</p>
                <div className="flex gap-3 justify-center">
                  <button
                    onClick={() => setUpdateDialogState(null)}
                    className="px-6 py-2.5 rounded-lg text-sm text-gray-400 hover:text-gray-200 transition-all"
                    style={{ border: '1px solid rgba(255,255,255,0.15)' }}
                  >
                    後で
                  </button>
                  <button
                    onClick={handleUpdate}
                    className="px-6 py-2.5 rounded-lg text-sm font-semibold text-white transition-all hover:shadow-lg"
                    style={{
                      background: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
                      boxShadow: '0 4px 12px rgba(59, 130, 246, 0.3)',
                    }}
                  >
                    アップデート
                  </button>
                </div>
              </>
            )}

            {/* ダウンロード中 */}
            {updateDialogState.type === 'downloading' && (
              <>
                <RefreshCw size={48} className="mx-auto mb-4 text-blue-400 animate-spin" />
                <h3 className="text-lg font-semibold text-white mb-3">アップデート中...</h3>
                <p className="text-sm text-gray-300">
                  ダウンロードしています。<br />しばらくお待ちください。
                </p>
              </>
            )}

            {/* 完了 */}
            {updateDialogState.type === 'complete' && (
              <>
                <CheckCircle size={48} className="mx-auto mb-4 text-green-400" />
                <h3 className="text-lg font-semibold text-white mb-3">インストール完了</h3>
                <p className="text-sm text-gray-300">アプリを再起動します...</p>
              </>
            )}

            {/* エラー */}
            {updateDialogState.type === 'error' && (
              <>
                <AlertTriangle size={48} className="mx-auto mb-4 text-red-400" />
                <h3 className="text-lg font-semibold text-white mb-3">アップデート失敗</h3>
                <p className="text-sm text-gray-400 mb-6">{updateDialogState.message}</p>
                <button
                  onClick={() => setUpdateDialogState(null)}
                  className="px-6 py-2.5 rounded-lg text-sm font-semibold text-white transition-all"
                  style={{
                    background: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
                  }}
                >
                  閉じる
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <Header isFullscreen={isFullscreen} fullscreenTransitioning={fullscreenTransitioning} onReset={handleReset} />

      <div className="flex-1 flex min-h-0">
        <Sidebar
          isFullscreen={isFullscreen}
          fullscreenTransitioning={fullscreenTransitioning}
          sidebarCollapsed={sidebarCollapsed}
          setSidebarCollapsed={setSidebarCollapsed}
          appMode={appMode}
          setAppMode={setAppMode}
          setInitialModeSelect={setInitialModeSelect}
          transferDiffToParallelView={transferDiffToParallelView}
          compareMode={compareMode}
          modeLabels={modeLabels}
          filesA={filesA}
          filesB={filesB}
          pairs={pairs}
          selectedIndex={selectedIndex}
          setSelectedIndex={setSelectedIndex}
          cropBounds={cropBounds}
          pairingMode={pairingMode}
          setPairingMode={setPairingMode}
          filterDiffOnly={filterDiffOnly}
          setFilterDiffOnly={setFilterDiffOnly}
          showMarkers={showMarkers}
          setShowMarkers={setShowMarkers}
          settingsOpen={settingsOpen}
          setSettingsOpen={setSettingsOpen}
          currentPage={currentPage}
          setCurrentPage={setCurrentPage}
          handleModeChange={handleModeChange}
          handleFilesAUpload={handleFilesAUpload}
          handleFilesBUpload={handleFilesBUpload}
          handleDragOver={handleDragOver}
          handleDragEnter={handleDragEnter}
          handleDrop={handleDrop}
          handleDragLeave={handleDragLeave}
          dragOverSide={dragOverSide}
          setIsGDriveBrowserOpen={setIsGDriveBrowserOpen}
          diffCache={diffCache}
          onClear={handleClear}
          parallelFolderA={parallelFolderA}
          parallelFolderB={parallelFolderB}
          parallelFilesA={parallelFilesA}
          parallelFilesB={parallelFilesB}
          parallelCurrentIndex={parallelCurrentIndex}
          parallelIndexA={parallelIndexA}
          parallelIndexB={parallelIndexB}
          parallelSyncMode={parallelSyncMode}
          parallelActivePanel={parallelActivePanel}
          setParallelIndexA={setParallelIndexA}
          setParallelIndexB={setParallelIndexB}
          setParallelCurrentIndex={setParallelCurrentIndex}
          handleSelectParallelFolder={handleSelectParallelFolder}
          handleSelectParallelPdf={handleSelectParallelPdf}
          clearParallelView={clearParallelView}
          fileListRef={fileListRef}
          pageListRef={pageListRef}
          parallelFileListRef={parallelFileListRef}
        />

        {appMode === 'diff-check' ? (
          <DiffViewer
            isFullscreen={isFullscreen}
            fullscreenTransitioning={fullscreenTransitioning}
            pairs={pairs}
            selectedIndex={selectedIndex}
            compareMode={compareMode}
            viewMode={viewMode}
            setViewMode={setViewMode}
            showMarkers={showMarkers}
            currentPage={currentPage}
            setCurrentPage={setCurrentPage}
            showHelp={showHelp}
            setShowHelp={setShowHelp}
            zoom={zoom}
            setZoom={setZoom}
            panPosition={panPosition}
            setPanPosition={setPanPosition}
            isDragging={isDragging}
            handleImageMouseDown={handleImageMouseDown}
            handleImageMouseMove={handleImageMouseMove}
            handleImageMouseUp={handleImageMouseUp}
            handleImageDoubleClick={handleImageDoubleClick}
            handleWheelPageTurn={handleWheelPageTurn}
            getCurrentMarkers={getCurrentMarkers}
            getDisplayImage={getDisplayImage}
            getDiffImage={getDiffImage}
            pdfCanvasRef={pdfCanvasRef}
            preloadProgress={preloadProgress}
            isLoadingPage={isLoadingPage}
            openFolderInExplorer={openFolderInExplorer}
            setCapturedImage={setCapturedImage}
            refreshDiffMode={refreshDiffMode}
            toggleFullscreen={toggleFullscreen}
            transferDiffToParallelView={transferDiffToParallelView}
            imageContainerRef={imageContainerRef}
            filesA={filesA}
            filesB={filesB}
            diffFolderA={diffFolderA}
            diffFolderB={diffFolderB}
            cropBounds={cropBounds}
            dragOverSide={dragOverSide}
            handleDragOver={handleDragOver}
            handleDrop={handleDrop}
            handleDragLeave={handleDragLeave}
            handleFilesAUpload={handleFilesAUpload}
            handleFilesBUpload={handleFilesBUpload}
            isGDriveBrowserOpen={isGDriveBrowserOpen}
            setIsGDriveBrowserOpen={setIsGDriveBrowserOpen}
            initialModeSelect={initialModeSelect}
            setInitialModeSelect={setInitialModeSelect}
            handleModeChange={handleModeChange}
            setAppMode={setAppMode}
            handleDragEnter={handleDragEnter}
            releaseMemoryBeforeMojiQ={releaseMemoryBeforeMojiQ}
            setDragOverSide={setDragOverSide}
            dropZoneARef={dropZoneARef}
            dropZoneBRef={dropZoneBRef}
            dropZoneJsonRef={dropZoneJsonRef}
          />
        ) : (
          <ParallelViewer
            isFullscreen={isFullscreen}
            fullscreenTransitioning={fullscreenTransitioning}
            parallelFilesA={parallelFilesA}
            parallelFilesB={parallelFilesB}
            parallelFolderA={parallelFolderA}
            parallelFolderB={parallelFolderB}
            parallelSyncMode={parallelSyncMode}
            parallelActivePanel={parallelActivePanel}
            parallelCurrentIndex={parallelCurrentIndex}
            parallelIndexA={parallelIndexA}
            parallelIndexB={parallelIndexB}
            setParallelCurrentIndex={setParallelCurrentIndex}
            setParallelIndexA={setParallelIndexA}
            setParallelIndexB={setParallelIndexB}
            setParallelSyncMode={setParallelSyncMode}
            setParallelActivePanel={setParallelActivePanel}
            parallelImageA={parallelImageA}
            parallelImageB={parallelImageB}
            parallelLoading={parallelLoading}
            parallelZoomA={parallelZoomA}
            parallelZoomB={parallelZoomB}
            parallelPanA={parallelPanA}
            parallelPanB={parallelPanB}
            setParallelZoomA={setParallelZoomA}
            setParallelZoomB={setParallelZoomB}
            setParallelPanA={setParallelPanA}
            setParallelPanB={setParallelPanB}
            handleParallelMouseDownA={handleParallelMouseDownA}
            handleParallelMouseDownB={handleParallelMouseDownB}
            handleParallelMouseMoveA={handleParallelMouseMoveA}
            handleParallelMouseMoveB={handleParallelMouseMoveB}
            handleParallelMouseUpA={handleParallelMouseUpA}
            handleParallelMouseUpB={handleParallelMouseUpB}
            isDraggingParallelA={isDraggingParallelA}
            isDraggingParallelB={isDraggingParallelB}
            spreadSplitModeA={spreadSplitModeA}
            spreadSplitModeB={spreadSplitModeB}
            firstPageSingleA={firstPageSingleA}
            firstPageSingleB={firstPageSingleB}
            setSpreadSplitModeA={setSpreadSplitModeA}
            setSpreadSplitModeB={setSpreadSplitModeB}
            setFirstPageSingleA={setFirstPageSingleA}
            setFirstPageSingleB={setFirstPageSingleB}
            showSyncOptions={showSyncOptions}
            showPsSelectPopup={showPsSelectPopup}
            showMojiQSelectPopup={showMojiQSelectPopup}
            showFolderSelectPopup={showFolderSelectPopup}
            setShowSyncOptions={setShowSyncOptions}
            setShowPsSelectPopup={setShowPsSelectPopup}
            setShowMojiQSelectPopup={setShowMojiQSelectPopup}
            setShowFolderSelectPopup={setShowFolderSelectPopup}
            instructionButtonsHidden={instructionButtonsHidden}
            setInstructionButtonsHidden={setInstructionButtonsHidden}
            openFolderInExplorer={openFolderInExplorer}
            toggleFullscreen={toggleFullscreen}
            setParallelCapturedImageA={setParallelCapturedImageA}
            setParallelCapturedImageB={setParallelCapturedImageB}
            handleParallelDrop={handleParallelDrop}
            handleSelectParallelFolder={handleSelectParallelFolder}
            handleSelectParallelPdf={handleSelectParallelPdf}
            parallelPdfCanvasARef={parallelPdfCanvasARef}
            parallelPdfCanvasBRef={parallelPdfCanvasBRef}
            parallelMaxIndex={parallelMaxIndex}
            releaseMemoryBeforeMojiQ={releaseMemoryBeforeMojiQ}
            expandPdfToParallelEntries={expandPdfToParallelEntries}
            refreshParallelView={refreshParallelView}
            showHelp={showHelp}
            setShowHelp={setShowHelp}
            parallelDropZoneARef={parallelDropZoneARef}
            parallelDropZoneBRef={parallelDropZoneBRef}
          />
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
