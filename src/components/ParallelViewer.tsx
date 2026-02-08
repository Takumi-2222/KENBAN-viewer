import React, { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Columns2,
  Layers,
  FileText,
  FolderOpen,
  Link2,
  Unlink2,
  RefreshCw,
  Maximize2,
  HelpCircle,
  BookOpen,
  Loader2,
  Edit3,
  Eye,
  EyeOff,
} from 'lucide-react';
import type { ParallelFileEntry } from '../types';

interface ParallelViewerProps {
  isFullscreen: boolean;
  fullscreenTransitioning: boolean;
  parallelFilesA: ParallelFileEntry[];
  parallelFilesB: ParallelFileEntry[];
  parallelFolderA: string | null;
  parallelFolderB: string | null;
  parallelSyncMode: boolean;
  parallelActivePanel: 'A' | 'B';
  parallelCurrentIndex: number;
  parallelIndexA: number;
  parallelIndexB: number;
  setParallelCurrentIndex: (v: number | ((prev: number) => number)) => void;
  setParallelIndexA: (v: number | ((prev: number) => number)) => void;
  setParallelIndexB: (v: number | ((prev: number) => number)) => void;
  setParallelSyncMode: (v: boolean) => void;
  setParallelActivePanel: (v: 'A' | 'B') => void;
  parallelImageA: string | null;
  parallelImageB: string | null;
  parallelLoading: boolean;
  parallelZoomA: number;
  parallelZoomB: number;
  parallelPanA: { x: number; y: number };
  parallelPanB: { x: number; y: number };
  setParallelZoomA: (v: number | ((prev: number) => number)) => void;
  setParallelZoomB: (v: number | ((prev: number) => number)) => void;
  setParallelPanA: (v: { x: number; y: number } | ((prev: { x: number; y: number }) => { x: number; y: number })) => void;
  setParallelPanB: (v: { x: number; y: number } | ((prev: { x: number; y: number }) => { x: number; y: number })) => void;
  handleParallelMouseDownA: (e: React.MouseEvent) => void;
  handleParallelMouseDownB: (e: React.MouseEvent) => void;
  handleParallelMouseMoveA: (e: React.MouseEvent) => void;
  handleParallelMouseMoveB: (e: React.MouseEvent) => void;
  handleParallelMouseUpA: () => void;
  handleParallelMouseUpB: () => void;
  isDraggingParallelA: boolean;
  isDraggingParallelB: boolean;
  spreadSplitModeA: boolean;
  spreadSplitModeB: boolean;
  firstPageSingleA: boolean;
  firstPageSingleB: boolean;
  setSpreadSplitModeA: (v: boolean) => void;
  setSpreadSplitModeB: (v: boolean) => void;
  setFirstPageSingleA: (v: boolean) => void;
  setFirstPageSingleB: (v: boolean) => void;
  showSyncOptions: boolean;
  showPsSelectPopup: boolean;
  showMojiQSelectPopup: boolean;
  showFolderSelectPopup: boolean;
  setShowSyncOptions: (v: boolean) => void;
  setShowPsSelectPopup: (v: boolean) => void;
  setShowMojiQSelectPopup: (v: boolean) => void;
  setShowFolderSelectPopup: (v: boolean) => void;
  instructionButtonsHidden: boolean;
  setInstructionButtonsHidden: (v: boolean) => void;
  openFolderInExplorer: (path: string) => void;
  toggleFullscreen: () => void;
  setParallelCapturedImageA: (v: string | null) => void;
  setParallelCapturedImageB: (v: string | null) => void;
  handleParallelDrop: (e: React.DragEvent, side: 'A' | 'B') => void;
  handleSelectParallelFolder: (side: 'A' | 'B') => void;
  handleSelectParallelPdf: (side: 'A' | 'B') => void;
  parallelPdfCanvasARef: React.RefObject<HTMLCanvasElement | null>;
  parallelPdfCanvasBRef: React.RefObject<HTMLCanvasElement | null>;
  parallelMaxIndex: number;
  releaseMemoryBeforeMojiQ: () => void;
  expandPdfToParallelEntries: (pdfPath: string, side: 'A' | 'B', droppedFile?: File, forceSplitMode?: boolean) => void;
  refreshParallelView: () => void;
  showHelp: boolean;
  setShowHelp: (v: boolean) => void;
  parallelDropZoneARef: React.RefObject<HTMLDivElement | null>;
  parallelDropZoneBRef: React.RefObject<HTMLDivElement | null>;
}

const ParallelViewer: React.FC<ParallelViewerProps> = (props) => {
  const {
    isFullscreen,
    fullscreenTransitioning,
    parallelFilesA,
    parallelFilesB,
    parallelFolderA,
    parallelFolderB,
    parallelSyncMode,
    parallelActivePanel,
    parallelCurrentIndex: _parallelCurrentIndex,
    parallelIndexA,
    parallelIndexB,
    setParallelCurrentIndex: _setParallelCurrentIndex,
    setParallelIndexA,
    setParallelIndexB,
    setParallelSyncMode,
    setParallelActivePanel,
    parallelImageA,
    parallelImageB,
    parallelLoading,
    parallelZoomA,
    parallelZoomB,
    parallelPanA,
    parallelPanB,
    setParallelZoomA: _setParallelZoomA,
    setParallelZoomB: _setParallelZoomB,
    setParallelPanA: _setParallelPanA,
    setParallelPanB: _setParallelPanB,
    handleParallelMouseDownA,
    handleParallelMouseDownB,
    handleParallelMouseMoveA,
    handleParallelMouseMoveB,
    handleParallelMouseUpA,
    handleParallelMouseUpB,
    isDraggingParallelA,
    isDraggingParallelB,
    spreadSplitModeA,
    spreadSplitModeB,
    firstPageSingleA,
    firstPageSingleB,
    setSpreadSplitModeA,
    setSpreadSplitModeB,
    setFirstPageSingleA,
    setFirstPageSingleB,
    showSyncOptions,
    showPsSelectPopup,
    showMojiQSelectPopup,
    showFolderSelectPopup,
    setShowSyncOptions,
    setShowPsSelectPopup,
    setShowMojiQSelectPopup,
    setShowFolderSelectPopup,
    instructionButtonsHidden,
    setInstructionButtonsHidden,
    openFolderInExplorer,
    toggleFullscreen,
    setParallelCapturedImageA,
    setParallelCapturedImageB,
    handleParallelDrop,
    handleSelectParallelFolder,
    handleSelectParallelPdf,
    parallelPdfCanvasARef,
    parallelPdfCanvasBRef,
    parallelMaxIndex: _parallelMaxIndex,
    releaseMemoryBeforeMojiQ,
    expandPdfToParallelEntries,
    refreshParallelView,
    showHelp,
    setShowHelp,
    parallelDropZoneARef,
    parallelDropZoneBRef,
  } = props;

  // ローカルstate: ドラッグオーバー側
  const [dragOverSide, setDragOverSide] = useState<string | null>(null);

  // ファイルパスから親フォルダパスを取得
  const getDirectoryFromPath = useCallback((filePath: string): string | null => {
    const parts = filePath.split(/[/\\]/);
    parts.pop();
    return parts.length > 0 ? parts.join('/') : null;
  }, []);

  // 並列ビューのフォルダパスを取得
  const getParallelFolderPath = useCallback((side: 'A' | 'B'): string | null => {
    const folderPath = side === 'A' ? parallelFolderA : parallelFolderB;
    const files = side === 'A' ? parallelFilesA : parallelFilesB;
    if (!folderPath) return null;
    // PDFの場合はファイルパスなので親フォルダを取得
    if (files.length > 0 && files[0].type === 'pdf') {
      return getDirectoryFromPath(folderPath);
    }
    return folderPath;
  }, [parallelFolderA, parallelFolderB, parallelFilesA, parallelFilesB, getDirectoryFromPath]);

  return (
        /* 並列ビューモードのMain Viewer */
        <div className="flex-1 flex flex-col bg-black relative">
          {/* ヘッダー */}
          {(() => {
            const hasPsdInParallel = parallelFilesA.some(f => f.type === 'psd') || parallelFilesB.some(f => f.type === 'psd');
            return (
          <div className={`bg-neutral-800 border-b border-neutral-700 flex items-center justify-between z-10 shrink-0 transition-all duration-300 ease-in-out ${isFullscreen || fullscreenTransitioning ? 'h-0 opacity-0 border-b-0 overflow-hidden' : 'h-12 opacity-100 overflow-visible'} ${hasPsdInParallel ? 'px-3' : 'px-4'}`}>
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
                          openFolderInExplorer(folderPath || (folderPathA || folderPathB)!);
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
                              openFolderInExplorer(folderPathA!);
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
                              openFolderInExplorer(folderPathB!);
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
              onDrop={(e) => { handleParallelDrop(e, 'A'); setDragOverSide(null); }}
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
              onDrop={(e) => { handleParallelDrop(e, 'B'); setDragOverSide(null); }}
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
          <div className={`bg-neutral-900 border-t border-neutral-800 flex items-center px-4 text-xs text-neutral-500 justify-between shrink-0 overflow-hidden transition-all duration-300 ease-in-out ${isFullscreen || fullscreenTransitioning ? 'h-0 opacity-0 border-t-0' : 'h-8 opacity-100'}`}>
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
        </div>
  );
};

export default ParallelViewer;
