import React from 'react';
import {
  PanelLeft, PanelLeftClose, Eye, Columns2, HardDrive,
  Settings, ChevronUp, ChevronDown, Target,
  AlertTriangle, CheckCircle, Loader2,
  FolderOpen, FileText,
} from 'lucide-react';
import type { CompareMode, AppMode, FileWithPath, CropBounds, FilePair, ParallelFileEntry, PageCache } from '../types';

interface ModeLabels {
  a: string;
  b: string;
  accept: string | { a: string; b: string };
}

interface SidebarProps {
  isFullscreen: boolean;
  fullscreenTransitioning: boolean;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  appMode: AppMode;
  setAppMode: (v: AppMode) => void;
  setInitialModeSelect: (v: boolean) => void;
  transferDiffToParallelView: () => void;
  compareMode: CompareMode;
  modeLabels: ModeLabels;
  filesA: File[];
  filesB: File[];
  pairs: FilePair[];
  selectedIndex: number;
  setSelectedIndex: (v: number) => void;
  cropBounds: CropBounds | null;
  pairingMode: 'order' | 'name';
  setPairingMode: (v: 'order' | 'name') => void;
  filterDiffOnly: boolean;
  setFilterDiffOnly: (v: boolean) => void;
  showMarkers: boolean;
  setShowMarkers: (v: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;
  currentPage: number;
  setCurrentPage: (v: number) => void;
  handleModeChange: (mode: CompareMode) => void;
  handleFilesAUpload: () => void;
  handleFilesBUpload: () => void;
  handleDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  handleDragEnter: (side: string) => (e: React.DragEvent<HTMLDivElement>) => void;
  handleDrop: (side: string) => (e: React.DragEvent<HTMLDivElement>) => void;
  handleDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  dragOverSide: string | null;
  setIsGDriveBrowserOpen: (v: boolean) => void;
  diffCache: Record<string, PageCache>;
  onClear: () => void;
  parallelFolderA: string | null;
  parallelFolderB: string | null;
  parallelFilesA: ParallelFileEntry[];
  parallelFilesB: ParallelFileEntry[];
  parallelCurrentIndex: number;
  parallelIndexA: number;
  parallelIndexB: number;
  parallelSyncMode: boolean;
  parallelActivePanel: 'A' | 'B';
  setParallelIndexA: (v: number) => void;
  setParallelIndexB: (v: number) => void;
  setParallelCurrentIndex: (v: number) => void;
  handleSelectParallelFolder: (side: 'A' | 'B') => void;
  handleSelectParallelPdf: (side: 'A' | 'B') => void;
  clearParallelView: () => void;
  fileListRef: React.RefObject<HTMLDivElement | null>;
  pageListRef: React.RefObject<HTMLDivElement | null>;
  parallelFileListRef: React.RefObject<HTMLDivElement | null>;
}

export default function Sidebar({
  isFullscreen,
  fullscreenTransitioning,
  sidebarCollapsed,
  setSidebarCollapsed,
  appMode,
  setAppMode,
  setInitialModeSelect,
  transferDiffToParallelView,
  compareMode,
  modeLabels,
  filesA,
  filesB,
  pairs,
  selectedIndex,
  setSelectedIndex,
  cropBounds,
  pairingMode,
  setPairingMode,
  filterDiffOnly,
  setFilterDiffOnly,
  showMarkers,
  setShowMarkers,
  settingsOpen,
  setSettingsOpen,
  currentPage,
  setCurrentPage,
  handleModeChange,
  handleFilesAUpload,
  handleFilesBUpload,
  handleDragOver,
  handleDragEnter,
  handleDrop,
  handleDragLeave,
  dragOverSide,
  setIsGDriveBrowserOpen,
  diffCache,
  onClear,
  parallelFolderA,
  parallelFolderB,
  parallelFilesA,
  parallelFilesB,
  parallelCurrentIndex: _parallelCurrentIndex,
  parallelIndexA,
  parallelIndexB,
  parallelSyncMode,
  parallelActivePanel,
  setParallelIndexA,
  setParallelIndexB,
  setParallelCurrentIndex,
  handleSelectParallelFolder,
  handleSelectParallelPdf,
  clearParallelView,
  fileListRef,
  pageListRef,
  parallelFileListRef,
}: SidebarProps) {
  // Derived values
  const filteredPairs = filterDiffOnly ? pairs.filter(p => p.status === 'done' && p.hasDiff) : pairs;

  const stats = {
    total: pairs.length,
    done: pairs.filter(p => p.status === 'done').length,
    diff: pairs.filter(p => p.status === 'done' && p.hasDiff).length,
    pending: pairs.filter(p => p.status === 'pending' && p.fileA && p.fileB).length
  };

  const currentPair = pairs[selectedIndex];

  return (
        <div className={`bg-neutral-800 border-r border-neutral-700 flex flex-col shrink-0 overflow-hidden transition-all duration-300 ease-in-out ${isFullscreen || fullscreenTransitioning ? 'w-0 opacity-0 border-r-0' : sidebarCollapsed ? 'w-10 opacity-100' : 'w-72 opacity-100'}`}>
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
                <button onClick={onClear} className="w-full py-1 bg-red-900/50 hover:bg-red-900 text-red-300 rounded text-xs transition">クリア</button>
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
  );
}
