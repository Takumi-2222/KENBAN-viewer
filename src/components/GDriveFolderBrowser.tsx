import React, { useState, useEffect, useCallback } from 'react';
import { readDir, readFile } from '@tauri-apps/plugin-fs';
import { FolderOpen, FileJson, ChevronRight, ChevronDown, X, Loader2, Search } from 'lucide-react';

// ベースパス
const BASE_PATH = 'G:\\共有ドライブ\\CLLENN\\編集部フォルダ\\編集企画部\\編集企画_C班(AT業務推進)\\DTP制作部\\JSONフォルダ';

interface CropBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface FolderItem {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
}

interface SearchResult {
  name: string;
  path: string;
  folderPath: string;
}

interface SelectionRange {
  label: string;
  bounds: CropBounds;
  blurRadius?: number;
  savedAt?: string;
  units?: string;
  size?: { width: number; height: number };
  documentSize?: { width: number; height: number };
}

interface PendingSelection {
  ranges: SelectionRange[];
  fileName: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onJsonSelect: (bounds: CropBounds, fileName: string) => void;
}

interface FolderNodeProps {
  item: FolderItem;
  onJsonSelect: (bounds: CropBounds, fileName: string) => void;
  onClose: () => void;
  onShowRangePicker: (pending: PendingSelection) => void;
}

const FolderNode: React.FC<FolderNodeProps> = ({ item, onJsonSelect, onClose, onShowRangePicker }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [children, setChildren] = useState<FolderItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  const loadChildren = async () => {
    if (isLoaded) return;
    setIsLoading(true);
    try {
      const entries = await readDir(item.path);
      const items: FolderItem[] = entries.map(entry => ({
        name: entry.name,
        path: `${item.path}\\${entry.name}`,
        isDirectory: entry.isDirectory,
        isFile: entry.isFile
      }));

      // フォルダを先に、ファイルを後に（自然順ソート）
      const folders = items.filter(i => i.isDirectory).sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
      const files = items.filter(i => i.isFile).sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));

      setChildren([...folders, ...files]);
      setIsLoaded(true);
    } catch (error) {
      console.error('フォルダの読み込みに失敗:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClick = async () => {
    if (item.isDirectory) {
      if (!isExpanded && !isLoaded) {
        await loadChildren();
      }
      setIsExpanded(!isExpanded);
    } else if (item.isFile && item.name.toLowerCase().endsWith('.json')) {
      // JSONファイルを読み込み
      try {
        const contents = await readFile(item.path);
        const decoder = new TextDecoder('utf-8');
        const text = decoder.decode(contents);
        const json = JSON.parse(text);

        // selectionRangesを探す（新形式: presetData.selectionRanges / 従来形式: selectionRanges）
        const selectionRanges = json.presetData?.selectionRanges || json.selectionRanges;
        if (selectionRanges && selectionRanges.length >= 1) {
          const ranges: SelectionRange[] = selectionRanges
            .filter((r: { bounds?: CropBounds }) => r.bounds)
            .map((r: { label?: string; bounds: CropBounds; blurRadius?: number; savedAt?: string }) => ({
              label: r.label || '名称未設定',
              bounds: r.bounds,
              blurRadius: r.blurRadius,
              savedAt: r.savedAt
            }))
            .sort((a: SelectionRange, b: SelectionRange) => {
              // 日付が新しい順にソート（日付がない場合は後ろに）
              if (!a.savedAt && !b.savedAt) return 0;
              if (!a.savedAt) return 1;
              if (!b.savedAt) return -1;
              return new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime();
            });
          if (ranges.length >= 1) {
            onShowRangePicker({ ranges, fileName: item.name });
            return;
          }
        }

        // レガシー形式（boundsが直接ある場合）
        if (json.bounds) {
          onJsonSelect(json.bounds, item.name);
          onClose();
        } else {
          alert('boundsが見つかりません');
        }
      } catch (error) {
        console.error('JSONの読み込みに失敗:', error);
        alert('JSONファイルの読み込みに失敗しました');
      }
    }
  };

  const isJsonFile = item.isFile && item.name.toLowerCase().endsWith('.json');

  return (
    <div>
      <div
        onClick={handleClick}
        className={`flex items-center gap-1 px-2 py-1 rounded cursor-pointer transition-colors ${
          item.isDirectory
            ? 'hover:bg-neutral-700'
            : isJsonFile
              ? 'hover:bg-orange-900/50 text-orange-300'
              : 'opacity-50 cursor-default'
        }`}
      >
        {item.isDirectory ? (
          <>
            {isLoading ? (
              <Loader2 size={14} className="animate-spin text-neutral-500" />
            ) : isExpanded ? (
              <ChevronDown size={14} className="text-neutral-500" />
            ) : (
              <ChevronRight size={14} className="text-neutral-500" />
            )}
            <FolderOpen size={14} className="text-yellow-500" />
          </>
        ) : (
          <>
            <span className="w-3.5" />
            <FileJson size={14} className={isJsonFile ? 'text-orange-400' : 'text-neutral-500'} />
          </>
        )}
        <span className="text-sm truncate">{item.name}</span>
      </div>

      {item.isDirectory && isExpanded && (
        <div className="ml-4 border-l border-neutral-700 pl-1">
          {isLoading ? (
            <div className="px-2 py-1 text-xs text-neutral-500">読み込み中...</div>
          ) : children.length === 0 ? (
            <div className="px-2 py-1 text-xs text-neutral-500">空のフォルダ</div>
          ) : (
            children.map((child, index) => (
              <FolderNode
                key={`${child.path}-${index}`}
                item={child}
                onJsonSelect={onJsonSelect}
                onClose={onClose}
                onShowRangePicker={onShowRangePicker}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
};

const GDriveFolderBrowser: React.FC<Props> = ({ isOpen, onClose, onJsonSelect }) => {
  const [rootItems, setRootItems] = useState<FolderItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);

  const loadRoot = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const entries = await readDir(BASE_PATH);
      const items: FolderItem[] = entries.map(entry => ({
        name: entry.name,
        path: `${BASE_PATH}\\${entry.name}`,
        isDirectory: entry.isDirectory,
        isFile: entry.isFile
      }));

      const folders = items.filter(i => i.isDirectory).sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
      const files = items.filter(i => i.isFile).sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));

      setRootItems([...folders, ...files]);
    } catch (err) {
      console.error('Gドライブの読み込みに失敗:', err);
      setError('Gドライブにアクセスできません。共有ドライブがマウントされているか確認してください。');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // 再帰的にJSONファイルを検索
  const searchJsonFiles = useCallback(async (dirPath: string, query: string, results: SearchResult[], depth: number = 0) => {
    if (depth > 5) return; // 深さ制限
    try {
      const entries = await readDir(dirPath);
      for (const entry of entries) {
        const fullPath = `${dirPath}\\${entry.name}`;
        if (entry.isFile && entry.name.toLowerCase().endsWith('.json')) {
          if (entry.name.toLowerCase().includes(query.toLowerCase())) {
            results.push({
              name: entry.name,
              path: fullPath,
              folderPath: dirPath.replace(BASE_PATH, '').replace(/^\\/, '')
            });
          }
        } else if (entry.isDirectory) {
          await searchJsonFiles(fullPath, query, results, depth + 1);
        }
      }
    } catch (err) {
      // フォルダアクセスエラーは無視
    }
  }, []);

  // 検索実行
  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    setIsSearching(true);
    const results: SearchResult[] = [];
    await searchJsonFiles(BASE_PATH, searchQuery.trim(), results);
    setSearchResults(results.sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true })));
    setIsSearching(false);
  }, [searchQuery, searchJsonFiles]);

  // 検索クエリ変更時に検索実行（デバウンス）
  useEffect(() => {
    const timer = setTimeout(() => {
      handleSearch();
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, handleSearch]);

  // 検索結果のJSONファイルをクリック
  const handleSearchResultClick = async (result: SearchResult) => {
    try {
      const contents = await readFile(result.path);
      const decoder = new TextDecoder('utf-8');
      const text = decoder.decode(contents);
      const json = JSON.parse(text);

      // selectionRangesを探す（新形式: presetData.selectionRanges / 従来形式: selectionRanges）
      const selectionRanges = json.presetData?.selectionRanges || json.selectionRanges;
      if (selectionRanges && selectionRanges.length >= 1) {
        const ranges: SelectionRange[] = selectionRanges
          .filter((r: { bounds?: CropBounds }) => r.bounds)
          .map((r: { label?: string; bounds: CropBounds; blurRadius?: number; savedAt?: string }) => ({
            label: r.label || '名称未設定',
            bounds: r.bounds,
            blurRadius: r.blurRadius,
            savedAt: r.savedAt
          }))
          .sort((a: SelectionRange, b: SelectionRange) => {
            // 日付が新しい順にソート（日付がない場合は後ろに）
            if (!a.savedAt && !b.savedAt) return 0;
            if (!a.savedAt) return 1;
            if (!b.savedAt) return -1;
            return new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime();
          });
        if (ranges.length >= 1) {
          setPendingSelection({ ranges, fileName: result.name });
          return;
        }
      }

      // レガシー形式（boundsが直接ある場合）
      if (json.bounds) {
        onJsonSelect(json.bounds, result.name);
        onClose();
      } else {
        alert('boundsが見つかりません');
      }
    } catch (error) {
      console.error('JSONの読み込みに失敗:', error);
      alert('JSONファイルの読み込みに失敗しました');
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadRoot();
      setSearchQuery('');
      setSearchResults([]);
    }
  }, [isOpen, loadRoot]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-neutral-800 rounded-lg shadow-xl w-[500px] max-h-[70vh] flex flex-col">
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700">
          <div className="flex items-center gap-2">
            <FolderOpen size={18} className="text-yellow-500" />
            <span className="font-medium">Gドライブから読込</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-neutral-700 rounded transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* 検索窓 */}
        <div className="px-4 py-2 border-b border-neutral-700">
          <div className="relative">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-neutral-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="JSONファイル名で検索..."
              className="w-full pl-8 pr-3 py-1.5 bg-neutral-900 border border-neutral-600 rounded text-sm text-neutral-300 placeholder-neutral-500 focus:outline-none focus:border-orange-500"
              autoFocus
            />
            {isSearching && (
              <Loader2 size={14} className="absolute right-2 top-1/2 -translate-y-1/2 animate-spin text-neutral-500" />
            )}
          </div>
        </div>

        {/* パス表示 */}
        <div className="px-4 py-2 bg-neutral-900 text-xs text-neutral-400 truncate">
          {BASE_PATH}
        </div>

        {/* フォルダツリー or 検索結果 */}
        <div className="flex-1 overflow-y-auto p-2 min-h-[300px]">
          {searchQuery.trim() ? (
            // 検索結果表示
            isSearching ? (
              <div className="flex items-center justify-center h-full gap-2 text-neutral-500">
                <Loader2 size={20} className="animate-spin" />
                <span>検索中...</span>
              </div>
            ) : searchResults.length === 0 ? (
              <div className="flex items-center justify-center h-full text-neutral-500">
                該当するJSONファイルがありません
              </div>
            ) : (
              <div className="space-y-1">
                <div className="text-xs text-neutral-500 px-2 mb-2">{searchResults.length}件の結果</div>
                {searchResults.map((result, index) => (
                  <div
                    key={`${result.path}-${index}`}
                    onClick={() => handleSearchResultClick(result)}
                    className="flex flex-col px-2 py-1.5 rounded cursor-pointer hover:bg-orange-900/50 transition-colors"
                  >
                    <div className="flex items-center gap-1 text-orange-300">
                      <FileJson size={14} className="text-orange-400 flex-shrink-0" />
                      <span className="text-sm truncate">{result.name}</span>
                    </div>
                    {result.folderPath && (
                      <span className="text-xs text-neutral-500 ml-5 truncate">{result.folderPath}</span>
                    )}
                  </div>
                ))}
              </div>
            )
          ) : (
            // フォルダツリー表示
            isLoading ? (
              <div className="flex items-center justify-center h-full gap-2 text-neutral-500">
                <Loader2 size={20} className="animate-spin" />
                <span>読み込み中...</span>
              </div>
            ) : error ? (
              <div className="flex items-center justify-center h-full text-red-400 text-sm text-center px-4">
                {error}
              </div>
            ) : rootItems.length === 0 ? (
              <div className="flex items-center justify-center h-full text-neutral-500">
                フォルダが空です
              </div>
            ) : (
              rootItems.map((item, index) => (
                <FolderNode
                  key={`${item.path}-${index}`}
                  item={item}
                  onJsonSelect={onJsonSelect}
                  onClose={onClose}
                  onShowRangePicker={setPendingSelection}
                />
              ))
            )
          )}
        </div>

        {/* フッター */}
        <div className="px-4 py-3 border-t border-neutral-700 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-sm transition-colors"
          >
            キャンセル
          </button>
        </div>
      </div>

      {/* 選択範囲ピッカー */}
      {pendingSelection && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-[60]"
          onClick={(e) => e.target === e.currentTarget && setPendingSelection(null)}
        >
          <div className="bg-neutral-800 rounded-lg shadow-xl w-[350px] max-h-[50vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700">
              <span className="font-medium text-sm">選択範囲を選んでください</span>
              <button
                onClick={() => setPendingSelection(null)}
                className="p-1 hover:bg-neutral-700 rounded transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              <div className="text-xs text-neutral-500 px-2 mb-2">
                {pendingSelection.fileName}
              </div>
              {pendingSelection.ranges.map((range, index) => {
                // 日付をフォーマット
                const formatDate = (dateStr?: string) => {
                  if (!dateStr) return null;
                  try {
                    const date = new Date(dateStr);
                    return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
                  } catch {
                    return null;
                  }
                };
                const formattedDate = formatDate(range.savedAt);

                return (
                  <button
                    key={index}
                    onClick={() => {
                      onJsonSelect(range.bounds, pendingSelection.fileName);
                      setPendingSelection(null);
                      onClose();
                    }}
                    className="w-full text-left px-3 py-2 rounded hover:bg-orange-900/50 transition-colors flex flex-col gap-0.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-orange-300 text-sm font-medium">{range.label}</span>
                      {formattedDate && (
                        <span className="text-xs text-neutral-400">{formattedDate}</span>
                      )}
                    </div>
                    <span className="text-xs text-neutral-500">
                      {range.bounds.right - range.bounds.left} x {range.bounds.bottom - range.bounds.top} px
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="px-4 py-3 border-t border-neutral-700 flex justify-end">
              <button
                onClick={() => setPendingSelection(null)}
                className="px-4 py-1.5 bg-neutral-700 hover:bg-neutral-600 rounded text-sm transition-colors"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default GDriveFolderBrowser;
