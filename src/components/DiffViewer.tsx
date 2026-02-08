import React, { useState, useCallback } from 'react';
import {
  FolderOpen, HelpCircle, Layers, FileDiff, Upload, Loader2,
  Target, HardDrive, FileText, RefreshCw, FileImage, Palette, Shuffle, Maximize2,
  PanelLeftClose
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { CompareMode, AppMode, ViewMode, FileWithPath, FilePair, CropBounds, DiffMarker } from '../types';

interface DiffViewerProps {
  isFullscreen: boolean;
  fullscreenTransitioning: boolean;
  pairs: FilePair[];
  selectedIndex: number;
  compareMode: CompareMode;
  viewMode: ViewMode;
  setViewMode: (v: ViewMode) => void;
  showMarkers: boolean;
  currentPage: number;
  showHelp: boolean;
  setShowHelp: (v: boolean) => void;
  zoom: number;
  setZoom: (v: number | ((prev: number) => number)) => void;
  panPosition: { x: number; y: number };
  setPanPosition: (v: { x: number; y: number } | ((prev: { x: number; y: number }) => { x: number; y: number })) => void;
  isDragging: boolean;
  handleImageMouseDown: (e: React.MouseEvent) => void;
  handleImageMouseMove: (e: React.MouseEvent) => void;
  handleImageMouseUp: () => void;
  handleImageDoubleClick: () => void;
  handleWheelPageTurn: (e: React.WheelEvent) => void;
  getCurrentMarkers: () => DiffMarker[];
  getDisplayImage: () => string | null;
  getDiffImage: () => string | null;
  pdfCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  preloadProgress: { loaded: number; total: number };
  isLoadingPage: boolean;
  openFolderInExplorer: (path: string) => void;
  setCapturedImage: (v: string | null) => void;
  refreshDiffMode: () => void;
  toggleFullscreen: () => void;
  transferDiffToParallelView: () => void;
  imageContainerRef: React.RefObject<HTMLDivElement | null>;
  filesA: File[];
  filesB: File[];
  diffFolderA: string | null;
  diffFolderB: string | null;
  cropBounds: CropBounds | null;
  dragOverSide: string | null;
  handleDragOver: (e: React.DragEvent) => void;
  handleDrop: (side: string) => (e: React.DragEvent) => void;
  handleDragLeave: (e: React.DragEvent) => void;
  handleFilesAUpload: () => void;
  handleFilesBUpload: () => void;
  isGDriveBrowserOpen: boolean;
  setIsGDriveBrowserOpen: (v: boolean) => void;
  // Additional props needed by the JSX
  setCurrentPage: (v: number | ((prev: number) => number)) => void;
  initialModeSelect: boolean;
  setInitialModeSelect: (v: boolean) => void;
  handleModeChange: (mode: CompareMode) => void;
  setAppMode: (mode: AppMode) => void;
  handleDragEnter: (side: string) => (e: React.DragEvent) => void;
  releaseMemoryBeforeMojiQ: () => void;
  setDragOverSide: (v: string | null) => void;
  dropZoneARef: React.RefObject<HTMLDivElement | null>;
  dropZoneBRef: React.RefObject<HTMLDivElement | null>;
  dropZoneJsonRef: React.RefObject<HTMLDivElement | null>;
}

// モードラベル
const getModeLabels = (compareMode: CompareMode) => {
  switch (compareMode) {
    case 'tiff-tiff': return { a: 'TIFF (元)', b: 'TIFF (修正)', accept: '.tif,.tiff' };
    case 'psd-psd': return { a: 'PSD (元)', b: 'PSD (修正)', accept: '.psd' };
    case 'pdf-pdf': return { a: 'PDF (元)', b: 'PDF (修正)', accept: '.pdf' };
    case 'psd-tiff': return { a: 'PSD (元)', b: 'TIFF (出力)', accept: { a: '.psd', b: '.tif,.tiff' } };
    default: return { a: 'A', b: 'B', accept: '*' };
  }
};

const getAcceptedExtensions = (side: 'A' | 'B', compareMode: CompareMode): string[] => {
  switch (compareMode) {
    case 'tiff-tiff': return ['.tif', '.tiff'];
    case 'psd-psd': return ['.psd'];
    case 'pdf-pdf': return ['.pdf'];
    case 'psd-tiff': return side === 'A' ? ['.psd'] : ['.tif', '.tiff'];
    default: return [];
  }
};

const DiffViewer: React.FC<DiffViewerProps> = (props) => {
  const {
    isFullscreen,
    fullscreenTransitioning,
    pairs,
    selectedIndex,
    compareMode,
    viewMode,
    setViewMode,
    currentPage,
    showHelp,
    setShowHelp,
    zoom,
    panPosition,
    isDragging,
    handleImageMouseDown,
    handleImageMouseMove,
    handleImageMouseUp,
    handleImageDoubleClick,
    handleWheelPageTurn,
    getCurrentMarkers,
    getDisplayImage,
    pdfCanvasRef,
    preloadProgress,
    isLoadingPage,
    openFolderInExplorer,
    setCapturedImage,
    refreshDiffMode,
    toggleFullscreen,
    imageContainerRef,
    filesA,
    filesB,
    diffFolderA,
    diffFolderB,
    cropBounds,
    dragOverSide,
    handleDragOver,
    handleDrop,
    handleDragLeave,
    handleFilesAUpload,
    handleFilesBUpload,
    setIsGDriveBrowserOpen,
    setCurrentPage,
    initialModeSelect,
    setInitialModeSelect: _setInitialModeSelect,
    handleModeChange,
    setAppMode,
    handleDragEnter,
    releaseMemoryBeforeMojiQ,
    setDragOverSide: _setDragOverSide,
    dropZoneARef,
    dropZoneBRef,
    dropZoneJsonRef,
  } = props;

  const [showFolderSelectPopup, setShowFolderSelectPopup] = useState(false);

  const currentPair = pairs[selectedIndex];
  const currentMarkers = getCurrentMarkers();
  const modeLabels = getModeLabels(compareMode);

  // フォルダパスを取得
  const getDiffFolderPath = useCallback((side: 'A' | 'B'): string | null => {
    // まずdiffFolderA/Bを確認（Tauriダイアログ選択時に設定される）
    const folder = side === 'A' ? diffFolderA : diffFolderB;
    if (folder) return folder;
    // フォールバック: ファイルのfilePathから親フォルダを取得
    const files = side === 'A' ? filesA : filesB;
    if (files.length === 0) return null;
    const firstFile = files[0] as FileWithPath;
    if (!firstFile.filePath) return null;
    const parts = firstFile.filePath.split(/[/\\]/);
    if (parts.length < 2) return null;
    parts.pop();
    return parts.join('\\');
  }, [filesA, filesB, diffFolderA, diffFolderB]);


  return (
        <div className="flex-1 flex flex-col bg-black relative">
          <div className={`bg-neutral-800 border-b border-neutral-700 flex items-center justify-between z-10 shrink-0 px-3 overflow-hidden transition-all duration-300 ease-in-out ${isFullscreen || fullscreenTransitioning ? 'h-0 opacity-0 border-b-0' : 'h-12 opacity-100'}`}>
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
                          openFolderInExplorer(folderPathA || folderPathB!);
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
                              openFolderInExplorer(folderPathA!);
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
                              openFolderInExplorer(folderPathB!);
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
                            className={`flex-1 border-2 border-dashed rounded-2xl py-40 px-16 min-h-[600px] flex flex-col items-center justify-center transition-all cursor-pointer ${dragOverSide === 'json' ? 'border-orange-500 bg-orange-900/30' : cropBounds ? 'border-green-600 bg-green-900/20' : 'border-neutral-700 hover:border-neutral-500 hover:bg-neutral-900/50'}`}
                            onDragOver={handleDragOver}
                            onDragEnter={handleDragEnter('json')}
                            onDragLeave={handleDragLeave}
                            onDrop={handleDrop('json')}
                            onClick={() => setIsGDriveBrowserOpen(true)}
                          >
                            <HardDrive size={36} className={`mb-3 ${dragOverSide === 'json' ? 'text-orange-400' : cropBounds ? 'text-green-400' : 'text-neutral-600'}`} />
                            <p className={`text-sm font-medium ${dragOverSide === 'json' ? 'text-orange-300' : cropBounds ? 'text-green-300' : 'text-neutral-400'}`}>Gドライブ</p>
                            <p className="text-xs text-neutral-600 mt-1">.json</p>
                            {cropBounds && <p className="text-xs text-green-400 mt-2">OK</p>}
                          </div>
                        )}

                        <div ref={dropZoneARef} className={`flex-1 border-2 border-dashed rounded-2xl py-40 px-16 min-h-[600px] flex flex-col items-center justify-center transition-all cursor-pointer ${dragOverSide === 'A' ? 'border-blue-500 bg-blue-900/30' : filesA.length > 0 ? 'border-green-600 bg-green-900/20' : 'border-neutral-700 hover:border-neutral-500 hover:bg-neutral-900/50'}`} onDragOver={handleDragOver} onDragEnter={handleDragEnter('A')} onDragLeave={handleDragLeave} onDrop={handleDrop('A')} onClick={handleFilesAUpload}>
                          <FolderOpen size={36} className={`mb-3 ${dragOverSide === 'A' ? 'text-blue-400' : filesA.length > 0 ? 'text-green-400' : 'text-neutral-600'}`} />
                          <p className={`text-sm font-medium ${dragOverSide === 'A' ? 'text-blue-300' : filesA.length > 0 ? 'text-green-300' : 'text-neutral-400'}`}>{modeLabels.a}</p>
                          <p className="text-xs text-neutral-600 mt-1">{getAcceptedExtensions('A', compareMode).join(', ')}</p>
                          {filesA.length > 0 && <p className="text-xs text-green-400 mt-2">{filesA.length}件</p>}
                        </div>

                        <div ref={dropZoneBRef} className={`flex-1 border-2 border-dashed rounded-2xl py-40 px-16 min-h-[600px] flex flex-col items-center justify-center transition-all cursor-pointer ${dragOverSide === 'B' ? 'border-green-500 bg-green-900/30' : filesB.length > 0 ? 'border-green-600 bg-green-900/20' : 'border-neutral-700 hover:border-neutral-500 hover:bg-neutral-900/50'}`} onDragOver={handleDragOver} onDragEnter={handleDragEnter('B')} onDragLeave={handleDragLeave} onDrop={handleDrop('B')} onClick={handleFilesBUpload}>
                          <FolderOpen size={36} className={`mb-3 ${dragOverSide === 'B' ? 'text-green-400' : filesB.length > 0 ? 'text-green-400' : 'text-neutral-600'}`} />
                          <p className={`text-sm font-medium ${dragOverSide === 'B' ? 'text-green-300' : filesB.length > 0 ? 'text-green-300' : 'text-neutral-400'}`}>{modeLabels.b}</p>
                          <p className="text-xs text-neutral-600 mt-1">{getAcceptedExtensions('B', compareMode).join(', ')}</p>
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
                        className={`flex-1 border-2 border-dashed rounded-2xl py-40 px-16 min-h-[600px] flex flex-col items-center justify-center transition-all cursor-pointer ${dragOverSide === 'json' ? 'border-orange-500 bg-orange-900/30' : cropBounds ? 'border-green-600 bg-green-900/20' : 'border-neutral-700 hover:border-neutral-500 hover:bg-neutral-900/50'}`}
                        onDragOver={handleDragOver}
                        onDragEnter={handleDragEnter('json')}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop('json')}
                        onClick={() => setIsGDriveBrowserOpen(true)}
                      >
                        <HardDrive size={36} className={`mb-3 ${dragOverSide === 'json' ? 'text-orange-400' : cropBounds ? 'text-green-400' : 'text-neutral-600'}`} />
                        <p className={`text-sm font-medium ${dragOverSide === 'json' ? 'text-orange-300' : cropBounds ? 'text-green-300' : 'text-neutral-400'}`}>Gドライブ</p>
                        <p className="text-xs text-neutral-600 mt-1">.json</p>
                        {cropBounds && <p className="text-xs text-green-400 mt-2">OK</p>}
                      </div>
                    )}

                    <div ref={dropZoneARef} className={`flex-1 border-2 border-dashed rounded-2xl py-40 px-16 min-h-[600px] flex flex-col items-center justify-center transition-all cursor-pointer ${dragOverSide === 'A' ? 'border-blue-500 bg-blue-900/30' : filesA.length > 0 ? 'border-green-600 bg-green-900/20' : 'border-neutral-700 hover:border-neutral-500 hover:bg-neutral-900/50'}`} onDragOver={handleDragOver} onDragEnter={handleDragEnter('A')} onDragLeave={handleDragLeave} onDrop={handleDrop('A')} onClick={handleFilesAUpload}>
                      <FolderOpen size={36} className={`mb-3 ${dragOverSide === 'A' ? 'text-blue-400' : filesA.length > 0 ? 'text-green-400' : 'text-neutral-600'}`} />
                      <p className={`text-sm font-medium ${dragOverSide === 'A' ? 'text-blue-300' : filesA.length > 0 ? 'text-green-300' : 'text-neutral-400'}`}>{modeLabels.a}</p>
                      <p className="text-xs text-neutral-600 mt-1">{getAcceptedExtensions('A', compareMode).join(', ')}</p>
                      {filesA.length > 0 && <p className="text-xs text-green-400 mt-2">{filesA.length}件</p>}
                    </div>

                    <div ref={dropZoneBRef} className={`flex-1 border-2 border-dashed rounded-2xl py-40 px-16 min-h-[600px] flex flex-col items-center justify-center transition-all cursor-pointer ${dragOverSide === 'B' ? 'border-green-500 bg-green-900/30' : filesB.length > 0 ? 'border-green-600 bg-green-900/20' : 'border-neutral-700 hover:border-neutral-500 hover:bg-neutral-900/50'}`} onDragOver={handleDragOver} onDragEnter={handleDragEnter('B')} onDragLeave={handleDragLeave} onDrop={handleDrop('B')} onClick={handleFilesBUpload}>
                      <FolderOpen size={36} className={`mb-3 ${dragOverSide === 'B' ? 'text-green-400' : filesB.length > 0 ? 'text-green-400' : 'text-neutral-600'}`} />
                      <p className={`text-sm font-medium ${dragOverSide === 'B' ? 'text-green-300' : filesB.length > 0 ? 'text-green-300' : 'text-neutral-400'}`}>{modeLabels.b}</p>
                      <p className="text-xs text-neutral-600 mt-1">{getAcceptedExtensions('B', compareMode).join(', ')}</p>
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

          <div className={`bg-neutral-900 border-t border-neutral-800 flex items-center px-4 text-xs text-neutral-500 justify-between shrink-0 overflow-hidden transition-all duration-300 ease-in-out ${isFullscreen || fullscreenTransitioning ? 'h-0 opacity-0 border-t-0' : 'h-8 opacity-100'}`}>
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
        </div>
  );
};

export default DiffViewer;
