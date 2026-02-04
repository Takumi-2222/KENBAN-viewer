import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X, Square, Pen, Copy, Check, ZoomIn, ZoomOut, Maximize, Minus, Plus, Crop, Undo2, Hand, Type, MousePointer2, Download } from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';

interface Annotation {
  id: string;
  type: 'rect' | 'pen' | 'text';
  color: string;
  lineWidth: number;
  points?: { x: number; y: number }[];
  rect?: { x: number; y: number; width: number; height: number };
  text?: { x: number; y: number; content: string; fontSize: number; vertical?: boolean };
  // 引き出し線付き枠線用
  leaderLine?: { startX: number; startY: number; endX: number; endY: number };
  label?: { x: number; y: number; content: string; fontSize: number; vertical?: boolean };
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

type ResizeHandle = 'tl' | 'tr' | 'bl' | 'br' | 't' | 'b' | 'l' | 'r' | null;

// UUID生成
const generateId = () => Math.random().toString(36).substring(2, 11);

interface CropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

type HistoryItem =
  | { type: 'annotation'; annotation: Annotation }
  | { type: 'crop'; region: CropRegion };

interface ScreenshotEditorProps {
  imageData: string;
  onClose: () => void;
}

const COLORS = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ffffff', '#000000'];
const LINE_WIDTHS = [4, 6, 8];
const MAX_DISPLAY_WIDTH = 1200;
const MAX_DISPLAY_HEIGHT = 700;

export default function ScreenshotEditor({ imageData, onClose }: ScreenshotEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<'select' | 'rect' | 'pen' | 'text' | 'crop' | 'hand'>('select');
  const [isSpacePanning, setIsSpacePanning] = useState(false);
  const [color, setColor] = useState('#ff0000');
  const [lineWidth, setLineWidth] = useState(4);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentAnnotation, setCurrentAnnotation] = useState<Annotation | null>(null);
  const [currentCropSelection, setCurrentCropSelection] = useState<CropRegion | null>(null);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [copied, setCopied] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [baseScale, setBaseScale] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });
  const [loadedImage, setLoadedImage] = useState<HTMLImageElement | null>(null);
  const [textInput, setTextInput] = useState<{ x: number; y: number; screenX: number; screenY: number } | null>(null);
  const [textValue, setTextValue] = useState('');
  const [textVertical, setTextVertical] = useState(false);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement>(null);

  // 選択関連のState
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [resizeHandle, setResizeHandle] = useState<ResizeHandle>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [originalAnnotation, setOriginalAnnotation] = useState<Annotation | null>(null);
  // 引き出し線付きアノテーションのどの部分を移動しているか
  const [movingPart, setMovingPart] = useState<'rect' | 'label' | 'whole'>('whole');
  // 引き出し線付きアノテーションのどの部分をリサイズしているか
  const [resizingPart, setResizingPart] = useState<'rect' | 'label' | null>(null);

  // 色パレット表示State
  const [showColorPalette, setShowColorPalette] = useState(false);
  const colorPaletteRef = useRef<HTMLDivElement>(null);

  // コンテナサイズ（パディング計算用）
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  // 引き出し線付き枠線モード
  const [rectWithLeaderMode, setRectWithLeaderMode] = useState(false);
  const [showRectOptions, setShowRectOptions] = useState(false);
  const rectOptionsRef = useRef<HTMLDivElement>(null);
  // 引き出し線描画フェーズ: 'rect' = 枠描画中, 'leader' = 引き出し線描画中
  const [leaderDrawPhase, setLeaderDrawPhase] = useState<'rect' | 'leader' | null>(null);
  const [pendingRectAnnotation, setPendingRectAnnotation] = useState<Annotation | null>(null);
  const [currentLeaderLine, setCurrentLeaderLine] = useState<{ startX: number; startY: number; endX: number; endY: number } | null>(null);
  // 引き出し線テキスト入力
  const [leaderTextInput, setLeaderTextInput] = useState<{ annotation: Annotation; screenX: number; screenY: number } | null>(null);
  const [leaderTextValue, setLeaderTextValue] = useState('');
  const leaderTextInputRef = useRef<HTMLTextAreaElement>(null);

  // 履歴からannotationsとcropRegionを計算
  const annotations = history.filter((h): h is { type: 'annotation'; annotation: Annotation } => h.type === 'annotation').map(h => h.annotation);
  const cropRegion = history.filter((h): h is { type: 'crop'; region: CropRegion } => h.type === 'crop').pop()?.region || null;

  // 画像を読み込み
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      setImageSize({ width: img.width, height: img.height });
      setLoadedImage(img);

      const scaleX = MAX_DISPLAY_WIDTH / img.width;
      const scaleY = MAX_DISPLAY_HEIGHT / img.height;
      const fitScale = Math.min(scaleX, scaleY, 1);
      setBaseScale(fitScale);
    };
    img.onerror = () => {
      alert('画像の読み込みに失敗しました');
      onClose();
    };
    img.src = imageData;
  }, [imageData, onClose]);

  // 現在表示する領域（クロップされている場合はクロップ領域）
  const displayRegion = cropRegion || { x: 0, y: 0, width: imageSize.width, height: imageSize.height };

  // 選択中のアノテーションを取得
  const selectedAnnotation = annotations.find(a => a.id === selectedId) || null;

  // テキストの幅を測定するためのヘルパー関数
  const measureTextWidth = useCallback((text: string, fontSize: number): number => {
    const canvas = canvasRef.current;
    if (!canvas) return text.length * fontSize * 0.6; // フォールバック
    const ctx = canvas.getContext('2d');
    if (!ctx) return text.length * fontSize * 0.6;
    ctx.font = `bold ${fontSize}px sans-serif`;
    return ctx.measureText(text).width;
  }, []);

  // アノテーションのバウンディングボックスを計算
  const getAnnotationBounds = useCallback((ann: Annotation): Bounds | null => {
    if (ann.type === 'rect' && ann.rect) {
      // 負のwidth/heightを正規化
      const rectX = ann.rect.width >= 0 ? ann.rect.x : ann.rect.x + ann.rect.width;
      const rectY = ann.rect.height >= 0 ? ann.rect.y : ann.rect.y + ann.rect.height;
      const rectW = Math.abs(ann.rect.width);
      const rectH = Math.abs(ann.rect.height);

      // 引き出し線とラベルがある場合はそれも含める
      if (ann.leaderLine || ann.label) {
        let minX = rectX;
        let minY = rectY;
        let maxX = rectX + rectW;
        let maxY = rectY + rectH;

        if (ann.leaderLine) {
          minX = Math.min(minX, ann.leaderLine.startX, ann.leaderLine.endX);
          minY = Math.min(minY, ann.leaderLine.startY, ann.leaderLine.endY);
          maxX = Math.max(maxX, ann.leaderLine.startX, ann.leaderLine.endX);
          maxY = Math.max(maxY, ann.leaderLine.startY, ann.leaderLine.endY);
        }

        if (ann.label) {
          if (ann.label.vertical) {
            const columns = ann.label.content.split('\n');
            const charHeight = ann.label.fontSize * 1.1;
            const colWidth = ann.label.fontSize * 1.2;
            const maxChars = Math.max(...columns.map(col => [...col].length));
            const totalWidth = columns.length * colWidth;
            const totalHeight = maxChars * charHeight;
            minX = Math.min(minX, ann.label.x - totalWidth + colWidth / 2);
            minY = Math.min(minY, ann.label.y - ann.label.fontSize);
            maxX = Math.max(maxX, ann.label.x + colWidth / 2);
            maxY = Math.max(maxY, ann.label.y - ann.label.fontSize + totalHeight);
          } else {
            const lines = ann.label.content.split('\n');
            const lineHeight = ann.label.fontSize * 1.2;
            const labelWidth = Math.max(...lines.map(line => measureTextWidth(line, ann.label!.fontSize)));
            const labelHeight = lines.length * lineHeight;
            minX = Math.min(minX, ann.label.x);
            minY = Math.min(minY, ann.label.y - ann.label.fontSize);
            maxX = Math.max(maxX, ann.label.x + labelWidth);
            maxY = Math.max(maxY, ann.label.y + labelHeight - ann.label.fontSize);
          }
        }

        return {
          x: minX,
          y: minY,
          width: maxX - minX,
          height: maxY - minY,
        };
      }

      return {
        x: rectX,
        y: rectY,
        width: rectW,
        height: rectH,
      };
    } else if (ann.type === 'pen' && ann.points && ann.points.length > 0) {
      const xs = ann.points.map(p => p.x);
      const ys = ann.points.map(p => p.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      return {
        x: minX,
        y: minY,
        width: Math.max(...xs) - minX,
        height: Math.max(...ys) - minY,
      };
    } else if (ann.type === 'text' && ann.text) {
      if (ann.text.vertical) {
        // 縦書きバウンディングボックス
        const columns = ann.text.content.split('\n');
        const charHeight = ann.text.fontSize * 1.1;
        const colWidth = ann.text.fontSize * 1.2;
        const maxChars = Math.max(...columns.map(col => [...col].length));
        const totalWidth = columns.length * colWidth;
        const totalHeight = maxChars * charHeight;
        return {
          x: ann.text.x - totalWidth + colWidth / 2,
          y: ann.text.y - ann.text.fontSize,
          width: totalWidth || ann.text.fontSize,
          height: totalHeight || ann.text.fontSize,
        };
      } else {
        // 横書きバウンディングボックス
        const lines = ann.text.content.split('\n');
        const lineHeight = ann.text.fontSize * 1.2;
        const maxWidth = Math.max(...lines.map(line => measureTextWidth(line, ann.text!.fontSize)));
        const totalHeight = lines.length * lineHeight;
        return {
          x: ann.text.x,
          y: ann.text.y - ann.text.fontSize,
          width: maxWidth || 10,
          height: totalHeight || ann.text.fontSize,
        };
      }
    }
    return null;
  }, [measureTextWidth]);

  // マウス位置がバウンディングボックス内にあるか判定
  const isPointInBounds = (x: number, y: number, bounds: Bounds, tolerance: number = 5): boolean => {
    return x >= bounds.x - tolerance &&
           x <= bounds.x + bounds.width + tolerance &&
           y >= bounds.y - tolerance &&
           y <= bounds.y + bounds.height + tolerance;
  };

  // 矩形の4辺中央から最も近い点を返す
  const getClosestPointOnRectEdge = (
    rectX: number, rectY: number, rectW: number, rectH: number,
    pointX: number, pointY: number
  ): { x: number; y: number } => {
    const centerX = rectX + rectW / 2;
    const centerY = rectY + rectH / 2;
    const candidates = [
      { x: centerX, y: rectY },           // 上辺中央
      { x: centerX, y: rectY + rectH },   // 下辺中央
      { x: rectX, y: centerY },           // 左辺中央
      { x: rectX + rectW, y: centerY },   // 右辺中央
    ];

    let closest = candidates[0];
    let minDist = Infinity;

    candidates.forEach(pt => {
      const dist = Math.pow(pt.x - pointX, 2) + Math.pow(pt.y - pointY, 2);
      if (dist < minDist) {
        minDist = dist;
        closest = pt;
      }
    });

    return closest;
  };

  // 引き出し線付きアノテーションのどの部分がクリックされたか判定
  const getClickedPart = useCallback((x: number, y: number, ann: Annotation): 'rect' | 'label' | null => {
    if (ann.type !== 'rect' || !ann.rect) return null;

    // ラベル部分の判定（ラベルがある場合は優先）
    if (ann.label) {
      let labelBounds: Bounds;
      if (ann.label.vertical) {
        const columns = ann.label.content.split('\n');
        const charHeight = ann.label.fontSize * 1.1;
        const colWidth = ann.label.fontSize * 1.2;
        const maxChars = Math.max(...columns.map(col => [...col].length));
        const totalWidth = columns.length * colWidth;
        const totalHeight = maxChars * charHeight;
        labelBounds = {
          x: ann.label.x - totalWidth + colWidth / 2,
          y: ann.label.y - ann.label.fontSize,
          width: totalWidth || ann.label.fontSize,
          height: totalHeight || ann.label.fontSize,
        };
      } else {
        const lines = ann.label.content.split('\n');
        const lineHeight = ann.label.fontSize * 1.2;
        const labelWidth = Math.max(...lines.map(line => measureTextWidth(line, ann.label!.fontSize)));
        const labelHeight = lines.length * lineHeight;
        labelBounds = {
          x: ann.label.x,
          y: ann.label.y - ann.label.fontSize,
          width: labelWidth || 10,
          height: labelHeight || ann.label.fontSize,
        };
      }
      if (isPointInBounds(x, y, labelBounds, 10)) {
        return 'label';
      }
    }

    // 枠部分の判定
    const rectX = ann.rect.width >= 0 ? ann.rect.x : ann.rect.x + ann.rect.width;
    const rectY = ann.rect.height >= 0 ? ann.rect.y : ann.rect.y + ann.rect.height;
    const rectBounds: Bounds = {
      x: rectX,
      y: rectY,
      width: Math.abs(ann.rect.width),
      height: Math.abs(ann.rect.height),
    };
    if (isPointInBounds(x, y, rectBounds, 10)) {
      return 'rect';
    }

    return null;
  }, [measureTextWidth]);

  // マウス位置でアノテーションをヒットテスト（逆順で上から判定）
  const hitTestAnnotations = useCallback((x: number, y: number): Annotation | null => {
    for (let i = annotations.length - 1; i >= 0; i--) {
      const ann = annotations[i];
      const bounds = getAnnotationBounds(ann);
      if (bounds && isPointInBounds(x, y, bounds)) {
        return ann;
      }
    }
    return null;
  }, [annotations, getAnnotationBounds]);

  // リサイズハンドルの判定（四隅 + 四辺中点）
  // 判定範囲を表示サイズより小さくして、誤操作を防ぐ
  const getResizeHandleAtPoint = useCallback((x: number, y: number, bounds: Bounds): ResizeHandle => {
    const scale = baseScale * zoom;
    const handleHitSize = 8 / scale; // 判定範囲を小さくして誤操作防止
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;

    // 四隅（優先度高）
    // 左上
    if (Math.abs(x - bounds.x) < handleHitSize && Math.abs(y - bounds.y) < handleHitSize) return 'tl';
    // 右上
    if (Math.abs(x - (bounds.x + bounds.width)) < handleHitSize && Math.abs(y - bounds.y) < handleHitSize) return 'tr';
    // 左下
    if (Math.abs(x - bounds.x) < handleHitSize && Math.abs(y - (bounds.y + bounds.height)) < handleHitSize) return 'bl';
    // 右下
    if (Math.abs(x - (bounds.x + bounds.width)) < handleHitSize && Math.abs(y - (bounds.y + bounds.height)) < handleHitSize) return 'br';

    // 四辺中点（判定範囲をさらに狭く）
    const edgeHitSize = 6 / scale;
    // 上辺中央
    if (Math.abs(x - centerX) < edgeHitSize && Math.abs(y - bounds.y) < edgeHitSize) return 't';
    // 下辺中央
    if (Math.abs(x - centerX) < edgeHitSize && Math.abs(y - (bounds.y + bounds.height)) < edgeHitSize) return 'b';
    // 左辺中央
    if (Math.abs(x - bounds.x) < edgeHitSize && Math.abs(y - centerY) < edgeHitSize) return 'l';
    // 右辺中央
    if (Math.abs(x - (bounds.x + bounds.width)) < edgeHitSize && Math.abs(y - centerY) < edgeHitSize) return 'r';

    return null;
  }, [baseScale, zoom]);

  // アノテーションをリサイズする
  const resizeAnnotation = useCallback((
    ann: Annotation,
    handle: ResizeHandle,
    currentPos: { x: number; y: number },
    startPos: { x: number; y: number },
    origBounds: Bounds,
    part: 'rect' | 'label' | null = null
  ): Annotation => {
    if (!handle) return ann;

    const dx = currentPos.x - startPos.x;
    const dy = currentPos.y - startPos.y;

    let newBounds: Bounds;
    switch (handle) {
      // 四隅ハンドル（幅と高さ両方変更）
      case 'tl':
        newBounds = {
          x: origBounds.x + dx,
          y: origBounds.y + dy,
          width: origBounds.width - dx,
          height: origBounds.height - dy,
        };
        break;
      case 'tr':
        newBounds = {
          x: origBounds.x,
          y: origBounds.y + dy,
          width: origBounds.width + dx,
          height: origBounds.height - dy,
        };
        break;
      case 'bl':
        newBounds = {
          x: origBounds.x + dx,
          y: origBounds.y,
          width: origBounds.width - dx,
          height: origBounds.height + dy,
        };
        break;
      case 'br':
        newBounds = {
          x: origBounds.x,
          y: origBounds.y,
          width: origBounds.width + dx,
          height: origBounds.height + dy,
        };
        break;
      // 辺ハンドル（幅または高さのみ変更）
      case 't':
        newBounds = {
          x: origBounds.x,
          y: origBounds.y + dy,
          width: origBounds.width,
          height: origBounds.height - dy,
        };
        break;
      case 'b':
        newBounds = {
          x: origBounds.x,
          y: origBounds.y,
          width: origBounds.width,
          height: origBounds.height + dy,
        };
        break;
      case 'l':
        newBounds = {
          x: origBounds.x + dx,
          y: origBounds.y,
          width: origBounds.width - dx,
          height: origBounds.height,
        };
        break;
      case 'r':
        newBounds = {
          x: origBounds.x,
          y: origBounds.y,
          width: origBounds.width + dx,
          height: origBounds.height,
        };
        break;
      default:
        return ann;
    }

    // 最小サイズを確保
    if (newBounds.width < 10) newBounds.width = 10;
    if (newBounds.height < 10) newBounds.height = 10;

    // タイプに応じて変換
    if (ann.type === 'rect' && ann.rect) {
      // 引き出し線付きアノテーションの場合
      if (ann.leaderLine && part) {
        // ラベルのバウンディングボックスを計算するヘルパー
        const getLabelBounds = (label: { x: number; y: number; content: string; fontSize: number; vertical?: boolean }) => {
          if (label.vertical) {
            const columns = label.content.split('\n');
            const charHeight = label.fontSize * 1.1;
            const colWidth = label.fontSize * 1.2;
            const maxChars = Math.max(...columns.map(col => [...col].length));
            const labelWidth = columns.length * colWidth || label.fontSize;
            const labelHeight = maxChars * charHeight || label.fontSize;
            return {
              x: label.x - labelWidth + colWidth / 2,
              y: label.y - label.fontSize,
              width: labelWidth,
              height: labelHeight,
            };
          } else {
            const lines = label.content.split('\n');
            const lineHeight = label.fontSize * 1.2;
            const labelWidth = Math.max(...lines.map(line => measureTextWidth(line, label.fontSize))) || 20;
            const labelHeight = lines.length * lineHeight || label.fontSize;
            return {
              x: label.x,
              y: label.y - label.fontSize,
              width: labelWidth,
              height: labelHeight,
            };
          }
        };

        if (part === 'rect') {
          // 枠線部分をリサイズ
          const newRectCenterX = newBounds.x + newBounds.width / 2;
          const newRectCenterY = newBounds.y + newBounds.height / 2;

          if (ann.label) {
            const labelBounds = getLabelBounds(ann.label);
            const labelCenterX = labelBounds.x + labelBounds.width / 2;
            const labelCenterY = labelBounds.y + labelBounds.height / 2;

            // 引き出し線の両端を再計算
            const startPoint = getClosestPointOnRectEdge(
              newBounds.x, newBounds.y, newBounds.width, newBounds.height,
              labelCenterX, labelCenterY
            );
            const endPoint = getClosestPointOnRectEdge(
              labelBounds.x, labelBounds.y, labelBounds.width, labelBounds.height,
              newRectCenterX, newRectCenterY
            );

            return {
              ...ann,
              rect: newBounds,
              leaderLine: { startX: startPoint.x, startY: startPoint.y, endX: endPoint.x, endY: endPoint.y },
            };
          } else {
            // ラベルなしの場合
            const startPoint = getClosestPointOnRectEdge(
              newBounds.x, newBounds.y, newBounds.width, newBounds.height,
              ann.leaderLine.endX, ann.leaderLine.endY
            );
            return {
              ...ann,
              rect: newBounds,
              leaderLine: { ...ann.leaderLine, startX: startPoint.x, startY: startPoint.y },
            };
          }
        } else if (part === 'label' && ann.label) {
          // ラベル部分をリサイズ（フォントサイズを調整）
          const scaleY = newBounds.height / origBounds.height;
          const newFontSize = ann.label.fontSize * scaleY;
          const newLabel = {
            ...ann.label,
            x: newBounds.x,
            y: newBounds.y + newFontSize,
            fontSize: newFontSize,
          };

          const newLabelBounds = getLabelBounds(newLabel);
          const labelCenterX = newLabelBounds.x + newLabelBounds.width / 2;
          const labelCenterY = newLabelBounds.y + newLabelBounds.height / 2;

          const rectX = ann.rect.width >= 0 ? ann.rect.x : ann.rect.x + ann.rect.width;
          const rectY = ann.rect.height >= 0 ? ann.rect.y : ann.rect.y + ann.rect.height;
          const rectW = Math.abs(ann.rect.width);
          const rectH = Math.abs(ann.rect.height);
          const rectCenterX = rectX + rectW / 2;
          const rectCenterY = rectY + rectH / 2;

          // 引き出し線の両端を再計算
          const startPoint = getClosestPointOnRectEdge(
            rectX, rectY, rectW, rectH,
            labelCenterX, labelCenterY
          );
          const endPoint = getClosestPointOnRectEdge(
            newLabelBounds.x, newLabelBounds.y, newLabelBounds.width, newLabelBounds.height,
            rectCenterX, rectCenterY
          );

          return {
            ...ann,
            leaderLine: { startX: startPoint.x, startY: startPoint.y, endX: endPoint.x, endY: endPoint.y },
            label: newLabel,
          };
        }
      }

      // 通常の枠線（引き出し線なし）
      return {
        ...ann,
        rect: newBounds,
      };
    } else if (ann.type === 'pen' && ann.points && ann.points.length > 0) {
      // スケール係数を計算
      const scaleX = newBounds.width / origBounds.width;
      const scaleY = newBounds.height / origBounds.height;
      const newPoints = ann.points.map(p => ({
        x: newBounds.x + (p.x - origBounds.x) * scaleX,
        y: newBounds.y + (p.y - origBounds.y) * scaleY,
      }));
      return {
        ...ann,
        points: newPoints,
        lineWidth: ann.lineWidth * Math.min(scaleX, scaleY),
      };
    } else if (ann.type === 'text' && ann.text) {
      if (ann.text.vertical) {
        // 縦書きリサイズ: 高さ基準でフォントサイズ調整
        const columns = ann.text.content.split('\n');
        const maxChars = Math.max(...columns.map(col => [...col].length));
        const newFontSize = maxChars > 0 ? newBounds.height / (maxChars * 1.1) : ann.text.fontSize;
        const newColWidth = newFontSize * 1.2;
        return {
          ...ann,
          text: {
            ...ann.text,
            x: newBounds.x + newBounds.width - newColWidth / 2,
            y: newBounds.y + newFontSize,
            fontSize: newFontSize,
          },
        };
      } else {
        const scaleY = newBounds.height / origBounds.height;
        const newFontSize = ann.text.fontSize * scaleY;
        return {
          ...ann,
          text: {
            ...ann.text,
            x: newBounds.x,
            y: newBounds.y + newFontSize,
            fontSize: newFontSize,
          },
        };
      }
    }
    return ann;
  }, [measureTextWidth]);

  // アノテーションを移動する
  const moveAnnotation = useCallback((
    ann: Annotation,
    currentPos: { x: number; y: number },
    startPos: { x: number; y: number },
    part: 'rect' | 'label' | 'whole' = 'whole'
  ): Annotation => {
    const dx = currentPos.x - startPos.x;
    const dy = currentPos.y - startPos.y;

    if (ann.type === 'rect' && ann.rect) {
      // 枠の正規化座標を取得
      const rectX = ann.rect.width >= 0 ? ann.rect.x : ann.rect.x + ann.rect.width;
      const rectY = ann.rect.height >= 0 ? ann.rect.y : ann.rect.y + ann.rect.height;
      const rectW = Math.abs(ann.rect.width);
      const rectH = Math.abs(ann.rect.height);

      // 引き出し線付きの場合、部分移動に対応
      if (ann.leaderLine && part !== 'whole') {
        // ラベルのバウンディングボックスを計算するヘルパー
        const getLabelBounds = (label: { x: number; y: number; content: string; fontSize: number; vertical?: boolean }) => {
          if (label.vertical) {
            const columns = label.content.split('\n');
            const charHeight = label.fontSize * 1.1;
            const colWidth = label.fontSize * 1.2;
            const maxChars = Math.max(...columns.map(col => [...col].length));
            const labelWidth = columns.length * colWidth || label.fontSize;
            const labelHeight = maxChars * charHeight || label.fontSize;
            return {
              x: label.x - labelWidth + colWidth / 2,
              y: label.y - label.fontSize,
              width: labelWidth,
              height: labelHeight,
            };
          } else {
            const lines = label.content.split('\n');
            const lineHeight = label.fontSize * 1.2;
            const labelWidth = Math.max(...lines.map(line => measureTextWidth(line, label.fontSize))) || 20;
            const labelHeight = lines.length * lineHeight || label.fontSize;
            return {
              x: label.x,
              y: label.y - label.fontSize,
              width: labelWidth,
              height: labelHeight,
            };
          }
        };

        if (part === 'rect') {
          // 枠だけ移動、引き出し線の両端を再計算
          const newRectX = rectX + dx;
          const newRectY = rectY + dy;
          const rectCenterX = newRectX + rectW / 2;
          const rectCenterY = newRectY + rectH / 2;

          if (ann.label) {
            const labelBounds = getLabelBounds(ann.label);
            const labelCenterX = labelBounds.x + labelBounds.width / 2;
            const labelCenterY = labelBounds.y + labelBounds.height / 2;

            // 枠線の外周上でラベル中心への最短点
            const startPoint = getClosestPointOnRectEdge(
              newRectX, newRectY, rectW, rectH,
              labelCenterX, labelCenterY
            );
            // ラベルの外周上で枠線中心への最短点
            const endPoint = getClosestPointOnRectEdge(
              labelBounds.x, labelBounds.y, labelBounds.width, labelBounds.height,
              rectCenterX, rectCenterY
            );

            return {
              ...ann,
              rect: { ...ann.rect, x: ann.rect.x + dx, y: ann.rect.y + dy },
              leaderLine: { ...ann.leaderLine, startX: startPoint.x, startY: startPoint.y, endX: endPoint.x, endY: endPoint.y },
            };
          } else {
            // ラベルなしの場合は終点への最短点のみ
            const startPoint = getClosestPointOnRectEdge(
              newRectX, newRectY, rectW, rectH,
              ann.leaderLine.endX, ann.leaderLine.endY
            );
            return {
              ...ann,
              rect: { ...ann.rect, x: ann.rect.x + dx, y: ann.rect.y + dy },
              leaderLine: { ...ann.leaderLine, startX: startPoint.x, startY: startPoint.y },
            };
          }
        } else if (part === 'label' && ann.label) {
          // ラベルだけ移動、引き出し線の両端を再計算
          const newLabel = { ...ann.label, x: ann.label.x + dx, y: ann.label.y + dy };
          const labelBounds = getLabelBounds(newLabel);
          const labelCenterX = labelBounds.x + labelBounds.width / 2;
          const labelCenterY = labelBounds.y + labelBounds.height / 2;
          const rectCenterX = rectX + rectW / 2;
          const rectCenterY = rectY + rectH / 2;

          // 枠線の外周上でラベル中心への最短点
          const startPoint = getClosestPointOnRectEdge(
            rectX, rectY, rectW, rectH,
            labelCenterX, labelCenterY
          );
          // ラベルの外周上で枠線中心への最短点
          const endPoint = getClosestPointOnRectEdge(
            labelBounds.x, labelBounds.y, labelBounds.width, labelBounds.height,
            rectCenterX, rectCenterY
          );

          return {
            ...ann,
            leaderLine: { ...ann.leaderLine, startX: startPoint.x, startY: startPoint.y, endX: endPoint.x, endY: endPoint.y },
            label: newLabel,
          };
        }
      }
      // 全体移動（引き出し線なし、または whole）
      return {
        ...ann,
        rect: {
          ...ann.rect,
          x: ann.rect.x + dx,
          y: ann.rect.y + dy,
        },
        ...(ann.leaderLine && {
          leaderLine: {
            startX: ann.leaderLine.startX + dx,
            startY: ann.leaderLine.startY + dy,
            endX: ann.leaderLine.endX + dx,
            endY: ann.leaderLine.endY + dy,
          },
        }),
        ...(ann.label && {
          label: {
            ...ann.label,
            x: ann.label.x + dx,
            y: ann.label.y + dy,
          },
        }),
      };
    } else if (ann.type === 'pen' && ann.points) {
      return {
        ...ann,
        points: ann.points.map(p => ({ x: p.x + dx, y: p.y + dy })),
      };
    } else if (ann.type === 'text' && ann.text) {
      return {
        ...ann,
        text: {
          ...ann.text,
          x: ann.text.x + dx,
          y: ann.text.y + dy,
        },
      };
    }
    return ann;
  }, [measureTextWidth]);

  // クロップ時のbaseScaleを再計算
  useEffect(() => {
    if (displayRegion.width > 0 && displayRegion.height > 0) {
      const scaleX = MAX_DISPLAY_WIDTH / displayRegion.width;
      const scaleY = MAX_DISPLAY_HEIGHT / displayRegion.height;
      const fitScale = Math.min(scaleX, scaleY, 1);
      setBaseScale(fitScale);
      setZoom(1);
    }
  }, [cropRegion, displayRegion.width, displayRegion.height]);

  // 現在の表示サイズ
  const displayWidth = displayRegion.width * baseScale * zoom;
  const displayHeight = displayRegion.height * baseScale * zoom;

  // Canvasに注釈を描画（画像は<img>タグで表示）
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !loadedImage || displayRegion.width === 0) return;

    // 高DPIディスプレイ対応: devicePixelRatioを考慮した解像度
    const dpr = window.devicePixelRatio || 1;
    canvas.width = displayRegion.width * dpr;
    canvas.height = displayRegion.height * dpr;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 高品質スケーリング設定
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // DPRに合わせてスケール
    ctx.scale(dpr, dpr);

    // 透明にクリア（画像は<img>タグで表示するため）
    ctx.clearRect(0, 0, displayRegion.width, displayRegion.height);

    // 注釈を描画（クロップ領域内の座標に変換）
    annotations.forEach(ann => drawAnnotation(ctx, ann, displayRegion));

    // 現在描画中の注釈
    if (currentAnnotation) {
      drawAnnotation(ctx, currentAnnotation, displayRegion);
    }

    // 引き出し線描画中の表示
    if (leaderDrawPhase === 'leader' && pendingRectAnnotation) {
      drawAnnotation(ctx, pendingRectAnnotation, displayRegion);
      if (currentLeaderLine) {
        ctx.strokeStyle = pendingRectAnnotation.color;
        ctx.lineWidth = pendingRectAnnotation.lineWidth;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(currentLeaderLine.startX - displayRegion.x, currentLeaderLine.startY - displayRegion.y);
        ctx.lineTo(currentLeaderLine.endX - displayRegion.x, currentLeaderLine.endY - displayRegion.y);
        ctx.stroke();
      }
    }

    // テキスト入力ポップアップ表示中に枠線と引き出し線を描画
    if (leaderTextInput) {
      drawAnnotation(ctx, leaderTextInput.annotation, displayRegion);
    }

    // 切り取り選択中の表示
    if (currentCropSelection && tool === 'crop') {
      const sx = currentCropSelection.x - displayRegion.x;
      const sy = currentCropSelection.y - displayRegion.y;
      const sw = currentCropSelection.width;
      const sh = currentCropSelection.height;

      // 選択範囲外を暗く（ctx.scaleでdpr適用済みなのでdisplayRegionサイズを使用）
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(0, 0, displayRegion.width, sy);
      ctx.fillRect(0, sy, sx, sh);
      ctx.fillRect(sx + sw, sy, displayRegion.width - sx - sw, sh);
      ctx.fillRect(0, sy + sh, displayRegion.width, displayRegion.height - sy - sh);

      // 選択枠
      ctx.strokeStyle = '#00ff00';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.strokeRect(sx, sy, sw, sh);
      ctx.setLineDash([]);
    }

    // 選択中のアノテーションにバウンディングボックスを表示
    if (selectedAnnotation && tool === 'select') {
      // 画面上で常に同じサイズに見えるよう、表示スケールで補正
      const scale = baseScale * zoom;
      const handleSize = 12 / scale;
      const lineWidth = 2 / scale;
      const borderSize = 2 / scale;
      const dashSize = 6 / scale;
      const gapSize = 4 / scale;

      // 引き出し線付きアノテーションの場合、枠線とラベルを別々に表示
      if (selectedAnnotation.type === 'rect' && selectedAnnotation.rect && selectedAnnotation.leaderLine) {
        // 枠線部分のバウンディングボックス（青）
        const rectX = selectedAnnotation.rect.width >= 0 ? selectedAnnotation.rect.x : selectedAnnotation.rect.x + selectedAnnotation.rect.width;
        const rectY = selectedAnnotation.rect.height >= 0 ? selectedAnnotation.rect.y : selectedAnnotation.rect.y + selectedAnnotation.rect.height;
        const rectW = Math.abs(selectedAnnotation.rect.width);
        const rectH = Math.abs(selectedAnnotation.rect.height);

        const rbx = rectX - displayRegion.x;
        const rby = rectY - displayRegion.y;

        ctx.strokeStyle = '#00bfff';
        ctx.lineWidth = lineWidth;
        ctx.setLineDash([dashSize, gapSize]);
        ctx.strokeRect(rbx, rby, rectW, rectH);
        ctx.setLineDash([]);

        // 枠線のリサイズハンドル（白縁取り付き）
        const rectHandles = [
          { x: rbx, y: rby },
          { x: rbx + rectW, y: rby },
          { x: rbx, y: rby + rectH },
          { x: rbx + rectW, y: rby + rectH },
        ];
        rectHandles.forEach(h => {
          // 白い縁取り
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(h.x - handleSize / 2 - borderSize, h.y - handleSize / 2 - borderSize, handleSize + borderSize * 2, handleSize + borderSize * 2);
          // 塗りつぶし
          ctx.fillStyle = '#00bfff';
          ctx.fillRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
        });

        // ラベル部分のバウンディングボックス（緑）
        if (selectedAnnotation.label) {
          let labelWidth: number;
          let labelHeight: number;
          let lbx: number;
          let lby: number;

          if (selectedAnnotation.label.vertical) {
            // 縦書き
            const columns = selectedAnnotation.label.content.split('\n');
            const charHeight = selectedAnnotation.label.fontSize * 1.1;
            const colWidth = selectedAnnotation.label.fontSize * 1.2;
            const maxChars = Math.max(...columns.map(col => [...col].length));
            labelWidth = columns.length * colWidth || selectedAnnotation.label.fontSize;
            labelHeight = maxChars * charHeight || selectedAnnotation.label.fontSize;
            lbx = selectedAnnotation.label.x - labelWidth + colWidth / 2 - displayRegion.x;
            lby = selectedAnnotation.label.y - selectedAnnotation.label.fontSize - displayRegion.y;
          } else {
            // 横書き
            const lines = selectedAnnotation.label.content.split('\n');
            const lineHeight = selectedAnnotation.label.fontSize * 1.2;
            labelWidth = Math.max(...lines.map(line => measureTextWidth(line, selectedAnnotation.label!.fontSize))) || 20;
            labelHeight = lines.length * lineHeight || selectedAnnotation.label.fontSize;
            lbx = selectedAnnotation.label.x - displayRegion.x;
            lby = selectedAnnotation.label.y - selectedAnnotation.label.fontSize - displayRegion.y;
          }

          ctx.strokeStyle = '#00ff88';
          ctx.lineWidth = lineWidth;
          ctx.setLineDash([dashSize, gapSize]);
          ctx.strokeRect(lbx, lby, labelWidth, labelHeight);
          ctx.setLineDash([]);

          // ラベルのリサイズハンドル（白縁取り付き）
          const labelHandles = [
            { x: lbx, y: lby },
            { x: lbx + labelWidth, y: lby },
            { x: lbx, y: lby + labelHeight },
            { x: lbx + labelWidth, y: lby + labelHeight },
          ];
          labelHandles.forEach(h => {
            // 白い縁取り
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(h.x - handleSize / 2 - borderSize, h.y - handleSize / 2 - borderSize, handleSize + borderSize * 2, handleSize + borderSize * 2);
            // 塗りつぶし
            ctx.fillStyle = '#00ff88';
            ctx.fillRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
          });
        }
      } else {
        // 通常のアノテーション（引き出し線なし）
        const bounds = getAnnotationBounds(selectedAnnotation);
        if (bounds) {
          const bx = bounds.x - displayRegion.x;
          const by = bounds.y - displayRegion.y;
          const bw = bounds.width;
          const bh = bounds.height;

          // バウンディングボックス
          ctx.strokeStyle = '#00bfff';
          ctx.lineWidth = lineWidth;
          ctx.setLineDash([dashSize, gapSize]);
          ctx.strokeRect(bx, by, bw, bh);
          ctx.setLineDash([]);

          // 8点のリサイズハンドル（四隅 + 四辺中点、白縁取り付き）
          const handles = [
            { x: bx, y: by },
            { x: bx + bw, y: by },
            { x: bx, y: by + bh },
            { x: bx + bw, y: by + bh },
            { x: bx + bw / 2, y: by },
            { x: bx + bw / 2, y: by + bh },
            { x: bx, y: by + bh / 2 },
            { x: bx + bw, y: by + bh / 2 },
          ];
          handles.forEach(h => {
            // 白い縁取り
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(h.x - handleSize / 2 - borderSize, h.y - handleSize / 2 - borderSize, handleSize + borderSize * 2, handleSize + borderSize * 2);
            // 塗りつぶし
            ctx.fillStyle = '#00bfff';
            ctx.fillRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
          });
        }
      }
    }
  }, [loadedImage, displayRegion, annotations, currentAnnotation, currentCropSelection, tool, selectedAnnotation, getAnnotationBounds, leaderDrawPhase, pendingRectAnnotation, currentLeaderLine, leaderTextInput, measureTextWidth, baseScale, zoom]);

  useEffect(() => {
    redrawCanvas();
  }, [redrawCanvas]);

  // 色パレット外クリックで閉じる
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (colorPaletteRef.current && !colorPaletteRef.current.contains(e.target as Node)) {
        setShowColorPalette(false);
      }
      if (rectOptionsRef.current && !rectOptionsRef.current.contains(e.target as Node)) {
        setShowRectOptions(false);
      }
    };
    if (showColorPalette || showRectOptions) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showColorPalette, showRectOptions]);

  // コンテナサイズを監視
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateSize = () => {
      setContainerSize({
        width: container.clientWidth,
        height: container.clientHeight,
      });
    };

    updateSize();

    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, []);

  // 初期スクロール位置を中央に設定
  useEffect(() => {
    const container = containerRef.current;
    if (!container || containerSize.width === 0 || displayWidth === 0) return;

    // パディングの半分だけスクロールして中央に配置
    const scrollX = (containerSize.width / 2) - (container.clientWidth / 2) + (displayWidth / 2);
    const scrollY = (containerSize.height / 2) - (container.clientHeight / 2) + (displayHeight / 2);
    container.scrollLeft = Math.max(0, scrollX);
    container.scrollTop = Math.max(0, scrollY);
  }, [containerSize.width, containerSize.height, displayWidth, displayHeight]);

  const drawAnnotation = (ctx: CanvasRenderingContext2D, ann: Annotation, region: { x: number; y: number }) => {
    ctx.strokeStyle = ann.color;
    ctx.lineWidth = ann.lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (ann.type === 'rect' && ann.rect) {
      const x = ann.rect.x - region.x;
      const y = ann.rect.y - region.y;
      ctx.strokeRect(x, y, ann.rect.width, ann.rect.height);

      // 引き出し線の描画
      if (ann.leaderLine) {
        ctx.beginPath();
        ctx.moveTo(ann.leaderLine.startX - region.x, ann.leaderLine.startY - region.y);
        ctx.lineTo(ann.leaderLine.endX - region.x, ann.leaderLine.endY - region.y);
        ctx.stroke();

        // ラベルの描画
        if (ann.label) {
          const lx = ann.label.x - region.x;
          const ly = ann.label.y - region.y;
          ctx.font = `bold ${ann.label.fontSize}px sans-serif`;
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = Math.max(2, ann.label.fontSize * 0.1);
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';

          if (ann.label.vertical) {
            // 縦書き
            const columns = ann.label.content.split('\n');
            const charHeight = ann.label.fontSize * 1.1;
            const colWidth = ann.label.fontSize * 1.2;
            ctx.textAlign = 'center';
            columns.forEach((col, ci) => {
              const chars = [...col];
              chars.forEach((char, charIdx) => {
                const cx = lx - ci * colWidth;
                const cy = ly + charIdx * charHeight;
                ctx.strokeText(char, cx, cy);
              });
            });
            ctx.fillStyle = ann.color;
            columns.forEach((col, ci) => {
              const chars = [...col];
              chars.forEach((char, charIdx) => {
                const cx = lx - ci * colWidth;
                const cy = ly + charIdx * charHeight;
                ctx.fillText(char, cx, cy);
              });
            });
            ctx.textAlign = 'start';
          } else {
            // 横書き
            const lines = ann.label.content.split('\n');
            const lineHeight = ann.label.fontSize * 1.2;
            lines.forEach((line, i) => {
              ctx.strokeText(line, lx, ly + i * lineHeight);
            });
            ctx.fillStyle = ann.color;
            lines.forEach((line, i) => {
              ctx.fillText(line, lx, ly + i * lineHeight);
            });
          }
          // lineWidthを元に戻す
          ctx.lineWidth = ann.lineWidth;
          ctx.strokeStyle = ann.color;
        }
      }
    } else if (ann.type === 'pen' && ann.points && ann.points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(ann.points[0].x - region.x, ann.points[0].y - region.y);
      ann.points.forEach(p => ctx.lineTo(p.x - region.x, p.y - region.y));
      ctx.stroke();
    } else if (ann.type === 'text' && ann.text) {
      const x = ann.text.x - region.x;
      const y = ann.text.y - region.y;
      ctx.font = `bold ${ann.text.fontSize}px sans-serif`;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(2, ann.text.fontSize * 0.1);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      if (ann.text.vertical) {
        // 縦書き: 1文字ずつ上から下へ、改行で右から左へ列を移動
        const columns = ann.text.content.split('\n');
        const charHeight = ann.text.fontSize * 1.1;
        const colWidth = ann.text.fontSize * 1.2;
        ctx.textAlign = 'center';
        columns.forEach((col, ci) => {
          const chars = [...col];
          chars.forEach((char, charIdx) => {
            const cx = x - ci * colWidth;
            const cy = y + charIdx * charHeight;
            ctx.strokeText(char, cx, cy);
          });
        });
        ctx.fillStyle = ann.color;
        columns.forEach((col, ci) => {
          const chars = [...col];
          chars.forEach((char, charIdx) => {
            const cx = x - ci * colWidth;
            const cy = y + charIdx * charHeight;
            ctx.fillText(char, cx, cy);
          });
        });
        ctx.textAlign = 'start';
      } else {
        // 横書き
        const lines = ann.text.content.split('\n');
        const lineHeight = ann.text.fontSize * 1.2;
        lines.forEach((line, i) => {
          ctx.strokeText(line, x, y + i * lineHeight);
        });
        ctx.fillStyle = ann.color;
        lines.forEach((line, i) => {
          ctx.fillText(line, x, y + i * lineHeight);
        });
      }
    }
  };

  // マウス座標を元画像の座標に変換
  const getCanvasCoords = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    // displayRegionのサイズを使用（canvas.widthはdprで拡大されているため）
    const scaleX = displayRegion.width / rect.width;
    const scaleY = displayRegion.height / rect.height;
    // Canvas上の座標を元画像の絶対座標に変換
    return {
      x: (e.clientX - rect.left) * scaleX + displayRegion.x,
      y: (e.clientY - rect.top) * scaleY + displayRegion.y,
    };
  };

  // ダブルクリックでテキスト再編集
  const handleDoubleClick = (e: React.MouseEvent) => {
    if (tool !== 'select') return;

    const coords = getCanvasCoords(e);
    const hitAnn = hitTestAnnotations(coords.x, coords.y);

    if (hitAnn && hitAnn.type === 'text' && hitAnn.text) {
      // テキストアノテーションをダブルクリック → 再編集モード
      setEditingAnnotationId(hitAnn.id);
      setTextInput({ x: hitAnn.text.x, y: hitAnn.text.y, screenX: e.clientX, screenY: e.clientY });
      setTextValue(hitAnn.text.content);
      setTextVertical(hitAnn.text.vertical || false);
      setTimeout(() => textInputRef.current?.focus(), 0);
    } else if (hitAnn && hitAnn.leaderLine && hitAnn.label) {
      // 引き出し線付き枠線のテキストをダブルクリック → 再編集モード
      setEditingAnnotationId(hitAnn.id);
      setLeaderTextInput({ annotation: hitAnn, screenX: e.clientX, screenY: e.clientY });
      setLeaderTextValue(hitAnn.label.content);
      setTextVertical(hitAnn.label.vertical || false);
      setTimeout(() => leaderTextInputRef.current?.focus(), 0);
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    // 手ツールまたはSpaceキー押下中はパン操作
    if (tool === 'hand' || isSpacePanning) {
      setIsPanning(true);
      setPanStart({
        x: e.clientX,
        y: e.clientY,
        scrollLeft: containerRef.current?.scrollLeft || 0,
        scrollTop: containerRef.current?.scrollTop || 0,
      });
      return;
    }

    // 選択ツールの場合
    if (tool === 'select') {
      const coords = getCanvasCoords(e);

      // ラベルのバウンディングボックスを計算するヘルパー
      const getLabelBoundsForResize = (label: { x: number; y: number; content: string; fontSize: number; vertical?: boolean }): Bounds => {
        if (label.vertical) {
          // 縦書き
          const columns = label.content.split('\n');
          const charHeight = label.fontSize * 1.1;
          const colWidth = label.fontSize * 1.2;
          const maxChars = Math.max(...columns.map(col => [...col].length));
          const labelWidth = columns.length * colWidth || label.fontSize;
          const labelHeight = maxChars * charHeight || label.fontSize;
          return {
            x: label.x - labelWidth + colWidth / 2,
            y: label.y - label.fontSize,
            width: labelWidth,
            height: labelHeight,
          };
        } else {
          // 横書き
          const lines = label.content.split('\n');
          const lineHeight = label.fontSize * 1.2;
          const labelWidth = Math.max(...lines.map(line => measureTextWidth(line, label.fontSize))) || 20;
          const labelHeight = lines.length * lineHeight || label.fontSize;
          return {
            x: label.x,
            y: label.y - label.fontSize,
            width: labelWidth,
            height: labelHeight,
          };
        }
      };

      // 既に選択中のアノテーションがある場合、リサイズハンドルの判定
      if (selectedAnnotation) {
        // 引き出し線付きアノテーションの場合、枠線とラベルを別々に判定
        if (selectedAnnotation.type === 'rect' && selectedAnnotation.rect && selectedAnnotation.leaderLine) {
          // 枠線のバウンディングボックス
          const rectX = selectedAnnotation.rect.width >= 0 ? selectedAnnotation.rect.x : selectedAnnotation.rect.x + selectedAnnotation.rect.width;
          const rectY = selectedAnnotation.rect.height >= 0 ? selectedAnnotation.rect.y : selectedAnnotation.rect.y + selectedAnnotation.rect.height;
          const rectBounds: Bounds = {
            x: rectX,
            y: rectY,
            width: Math.abs(selectedAnnotation.rect.width),
            height: Math.abs(selectedAnnotation.rect.height),
          };

          // 枠線のリサイズハンドル判定
          const rectHandle = getResizeHandleAtPoint(coords.x, coords.y, rectBounds);
          if (rectHandle) {
            setIsResizing(true);
            setResizeHandle(rectHandle);
            setResizingPart('rect');
            setDragStart(coords);
            setOriginalAnnotation(selectedAnnotation);
            return;
          }

          // ラベルのリサイズハンドル判定
          if (selectedAnnotation.label) {
            const labelBounds = getLabelBoundsForResize(selectedAnnotation.label);
            const labelHandle = getResizeHandleAtPoint(coords.x, coords.y, labelBounds);
            if (labelHandle) {
              setIsResizing(true);
              setResizeHandle(labelHandle);
              setResizingPart('label');
              setDragStart(coords);
              setOriginalAnnotation(selectedAnnotation);
              return;
            }
          }

          // バウンディングボックス内なら移動開始
          const wholeBounds = getAnnotationBounds(selectedAnnotation);
          if (wholeBounds && isPointInBounds(coords.x, coords.y, wholeBounds)) {
            const clickedPart = getClickedPart(coords.x, coords.y, selectedAnnotation);
            setMovingPart(clickedPart || 'whole');
            setIsMoving(true);
            setDragStart(coords);
            setOriginalAnnotation(selectedAnnotation);
            return;
          }
        } else {
          // 通常のアノテーション
          const bounds = getAnnotationBounds(selectedAnnotation);
          if (bounds) {
            const handle = getResizeHandleAtPoint(coords.x, coords.y, bounds);
            if (handle) {
              // リサイズ開始
              setIsResizing(true);
              setResizeHandle(handle);
              setResizingPart(null);
              setDragStart(coords);
              setOriginalAnnotation(selectedAnnotation);
              return;
            }
            // バウンディングボックス内なら移動開始
            if (isPointInBounds(coords.x, coords.y, bounds)) {
              setMovingPart('whole');
              setIsMoving(true);
              setDragStart(coords);
              setOriginalAnnotation(selectedAnnotation);
              return;
            }
          }
        }
      }

      // 新しいアノテーションを選択
      const hitAnn = hitTestAnnotations(coords.x, coords.y);
      if (hitAnn) {
        setSelectedId(hitAnn.id);
        // クリックした位置がハンドル上なら即リサイズ開始
        // 引き出し線付きアノテーションの場合
        if (hitAnn.type === 'rect' && hitAnn.rect && hitAnn.leaderLine) {
          const rectX = hitAnn.rect.width >= 0 ? hitAnn.rect.x : hitAnn.rect.x + hitAnn.rect.width;
          const rectY = hitAnn.rect.height >= 0 ? hitAnn.rect.y : hitAnn.rect.y + hitAnn.rect.height;
          const rectBounds: Bounds = {
            x: rectX,
            y: rectY,
            width: Math.abs(hitAnn.rect.width),
            height: Math.abs(hitAnn.rect.height),
          };

          const rectHandle = getResizeHandleAtPoint(coords.x, coords.y, rectBounds);
          if (rectHandle) {
            setIsResizing(true);
            setResizeHandle(rectHandle);
            setResizingPart('rect');
            setDragStart(coords);
            setOriginalAnnotation(hitAnn);
            return;
          }

          if (hitAnn.label) {
            const labelBounds = getLabelBoundsForResize(hitAnn.label);
            const labelHandle = getResizeHandleAtPoint(coords.x, coords.y, labelBounds);
            if (labelHandle) {
              setIsResizing(true);
              setResizeHandle(labelHandle);
              setResizingPart('label');
              setDragStart(coords);
              setOriginalAnnotation(hitAnn);
              return;
            }
          }

          // バウンディングボックス内なら移動開始
          const wholeBounds = getAnnotationBounds(hitAnn);
          if (wholeBounds && isPointInBounds(coords.x, coords.y, wholeBounds)) {
            const clickedPart = getClickedPart(coords.x, coords.y, hitAnn);
            setMovingPart(clickedPart || 'whole');
            setIsMoving(true);
            setDragStart(coords);
            setOriginalAnnotation(hitAnn);
            return;
          }
        } else {
          // 通常のアノテーション
          const bounds = getAnnotationBounds(hitAnn);
          if (bounds) {
            const handle = getResizeHandleAtPoint(coords.x, coords.y, bounds);
            if (handle) {
              setIsResizing(true);
              setResizeHandle(handle);
              setResizingPart(null);
              setDragStart(coords);
              setOriginalAnnotation(hitAnn);
              return;
            }
            // バウンディングボックス内なら移動開始
            if (isPointInBounds(coords.x, coords.y, bounds)) {
              setMovingPart('whole');
              setIsMoving(true);
              setDragStart(coords);
              setOriginalAnnotation(hitAnn);
              return;
            }
          }
        }
      } else {
        // 何もない場所をクリックしたら選択解除
        setSelectedId(null);
      }
      return;
    }

    // テキストツールの場合
    if (tool === 'text') {
      const coords = getCanvasCoords(e);
      setTextInput({ x: coords.x, y: coords.y, screenX: e.clientX, screenY: e.clientY });
      setTextValue('');
      setTimeout(() => textInputRef.current?.focus(), 0);
      return;
    }

    setIsDrawing(true);
    const coords = getCanvasCoords(e);

    // 線の太さを表示スケールで調整（どの画像サイズでも見た目の太さが均一になる）
    const adjustedLineWidth = lineWidth / baseScale;

    if (tool === 'rect') {
      setCurrentAnnotation({
        id: generateId(),
        type: 'rect',
        color,
        lineWidth: adjustedLineWidth,
        rect: { x: coords.x, y: coords.y, width: 0, height: 0 },
      });
    } else if (tool === 'pen') {
      setCurrentAnnotation({
        id: generateId(),
        type: 'pen',
        color,
        lineWidth: adjustedLineWidth,
        points: [coords],
      });
    } else if (tool === 'crop') {
      setCurrentCropSelection({ x: coords.x, y: coords.y, width: 0, height: 0 });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    // パン操作中
    if (isPanning && containerRef.current) {
      const dx = e.clientX - panStart.x;
      const dy = e.clientY - panStart.y;
      containerRef.current.scrollLeft = panStart.scrollLeft - dx;
      containerRef.current.scrollTop = panStart.scrollTop - dy;
      return;
    }

    // リサイズ中
    if (isResizing && originalAnnotation && dragStart && resizeHandle) {
      const coords = getCanvasCoords(e);

      // 引き出し線付きアノテーションの場合、resizingPartに応じたboundsを取得
      let bounds: Bounds | null = null;
      if (originalAnnotation.type === 'rect' && originalAnnotation.rect && originalAnnotation.leaderLine && resizingPart) {
        if (resizingPart === 'rect') {
          const rectX = originalAnnotation.rect.width >= 0 ? originalAnnotation.rect.x : originalAnnotation.rect.x + originalAnnotation.rect.width;
          const rectY = originalAnnotation.rect.height >= 0 ? originalAnnotation.rect.y : originalAnnotation.rect.y + originalAnnotation.rect.height;
          bounds = {
            x: rectX,
            y: rectY,
            width: Math.abs(originalAnnotation.rect.width),
            height: Math.abs(originalAnnotation.rect.height),
          };
        } else if (resizingPart === 'label' && originalAnnotation.label) {
          const lines = originalAnnotation.label.content.split('\n');
          const lineHeight = originalAnnotation.label.fontSize * 1.2;
          const labelWidth = Math.max(...lines.map(line => measureTextWidth(line, originalAnnotation.label!.fontSize))) || 20;
          const labelHeight = lines.length * lineHeight || originalAnnotation.label.fontSize;
          bounds = {
            x: originalAnnotation.label.x,
            y: originalAnnotation.label.y - originalAnnotation.label.fontSize,
            width: labelWidth,
            height: labelHeight,
          };
        }
      } else {
        bounds = getAnnotationBounds(originalAnnotation);
      }

      if (bounds) {
        const newAnn = resizeAnnotation(originalAnnotation, resizeHandle, coords, dragStart, bounds, resizingPart);
        // 履歴を一時的に更新（描画用）
        const newHistory = history.map(h =>
          h.type === 'annotation' && h.annotation.id === originalAnnotation.id
            ? { ...h, annotation: newAnn }
            : h
        );
        setHistory(newHistory);
      }
      return;
    }

    // 移動中
    if (isMoving && originalAnnotation && dragStart) {
      const coords = getCanvasCoords(e);
      const newAnn = moveAnnotation(originalAnnotation, coords, dragStart, movingPart);
      // 履歴を一時的に更新（描画用）
      const newHistory = history.map(h =>
        h.type === 'annotation' && h.annotation.id === originalAnnotation.id
          ? { ...h, annotation: newAnn }
          : h
      );
      setHistory(newHistory);
      return;
    }

    // 引き出し線描画中
    if (leaderDrawPhase === 'leader' && currentLeaderLine && pendingRectAnnotation?.rect) {
      const coords = getCanvasCoords(e);
      const rect = pendingRectAnnotation.rect;
      // 枠線の外周上でマウス位置に最も近い点を開始点とする
      const startPoint = getClosestPointOnRectEdge(
        rect.x, rect.y, rect.width, rect.height,
        coords.x, coords.y
      );
      setCurrentLeaderLine({
        startX: startPoint.x,
        startY: startPoint.y,
        endX: coords.x,
        endY: coords.y,
      });
      return;
    }

    if (!isDrawing) return;
    const coords = getCanvasCoords(e);

    if (tool === 'rect' && currentAnnotation?.rect) {
      setCurrentAnnotation({
        ...currentAnnotation,
        rect: {
          ...currentAnnotation.rect,
          width: coords.x - currentAnnotation.rect.x,
          height: coords.y - currentAnnotation.rect.y,
        },
      });
    } else if (tool === 'pen' && currentAnnotation?.points) {
      setCurrentAnnotation({
        ...currentAnnotation,
        points: [...currentAnnotation.points, coords],
      });
    } else if (tool === 'crop' && currentCropSelection) {
      setCurrentCropSelection({
        ...currentCropSelection,
        width: coords.x - currentCropSelection.x,
        height: coords.y - currentCropSelection.y,
      });
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    // パン操作終了
    if (isPanning) {
      setIsPanning(false);
      return;
    }

    // リサイズ・移動終了
    if (isResizing || isMoving) {
      setIsResizing(false);
      setIsMoving(false);
      setResizeHandle(null);
      setResizingPart(null);
      setDragStart(null);
      setOriginalAnnotation(null);
      return;
    }

    // 引き出し線フェーズの終了
    if (leaderDrawPhase === 'leader' && pendingRectAnnotation && currentLeaderLine) {
      const lineLength = Math.sqrt(
        Math.pow(currentLeaderLine.endX - currentLeaderLine.startX, 2) +
        Math.pow(currentLeaderLine.endY - currentLeaderLine.startY, 2)
      );
      if (lineLength > 10) {
        // テキスト入力を表示
        const annotationWithLine: Annotation = {
          ...pendingRectAnnotation,
          leaderLine: currentLeaderLine,
        };
        setLeaderTextInput({
          annotation: annotationWithLine,
          screenX: e.clientX,
          screenY: e.clientY,
        });
        setLeaderTextValue('');
        setTimeout(() => leaderTextInputRef.current?.focus(), 0);
      }
      setLeaderDrawPhase(null);
      setPendingRectAnnotation(null);
      setCurrentLeaderLine(null);
      setIsDrawing(false);
      return;
    }

    if (currentAnnotation) {
      // 最小サイズチェック
      let added = false;
      if (currentAnnotation.type === 'rect' && currentAnnotation.rect) {
        if (Math.abs(currentAnnotation.rect.width) > 5 && Math.abs(currentAnnotation.rect.height) > 5) {
          // 引き出し線モードの場合
          if (rectWithLeaderMode) {
            // 枠線を正規化
            const rect = currentAnnotation.rect;
            const normalizedRect = {
              x: rect.width >= 0 ? rect.x : rect.x + rect.width,
              y: rect.height >= 0 ? rect.y : rect.y + rect.height,
              width: Math.abs(rect.width),
              height: Math.abs(rect.height),
            };
            const normalizedAnnotation = { ...currentAnnotation, rect: normalizedRect };

            // 引き出し線フェーズに移行
            setPendingRectAnnotation(normalizedAnnotation);
            setLeaderDrawPhase('leader');
            // 引き出し線の開始点は枠の右下角
            const startX = normalizedRect.x + normalizedRect.width;
            const startY = normalizedRect.y + normalizedRect.height;
            setCurrentLeaderLine({ startX, startY, endX: startX, endY: startY });
            setCurrentAnnotation(null);
            // isDrawingはtrueのまま継続
            return;
          } else {
            setHistory([...history, { type: 'annotation', annotation: currentAnnotation }]);
            added = true;
          }
        }
      } else if (currentAnnotation.type === 'pen' && currentAnnotation.points && currentAnnotation.points.length > 2) {
        setHistory([...history, { type: 'annotation', annotation: currentAnnotation }]);
        added = true;
      }
      // 描画後、新しいアノテーションを選択状態に（ツールは維持）
      if (added) {
        setSelectedId(currentAnnotation.id);
      }
      setCurrentAnnotation(null);
    }

    if (currentCropSelection && tool === 'crop') {
      // 正規化（負のwidth/heightを修正）
      const x1 = Math.min(currentCropSelection.x, currentCropSelection.x + currentCropSelection.width);
      const y1 = Math.min(currentCropSelection.y, currentCropSelection.y + currentCropSelection.height);
      const x2 = Math.max(currentCropSelection.x, currentCropSelection.x + currentCropSelection.width);
      const y2 = Math.max(currentCropSelection.y, currentCropSelection.y + currentCropSelection.height);
      const width = x2 - x1;
      const height = y2 - y1;

      if (width > 20 && height > 20) {
        setHistory([...history, { type: 'crop', region: { x: x1, y: y1, width, height } }]);
        // ツールは維持（連続クロップ可能）
      }
      setCurrentCropSelection(null);
    }

    setIsDrawing(false);
  };

  const handleCopy = async () => {
    if (!loadedImage || displayRegion.width === 0) return;

    try {
      // バウンディングボックスを含まないオフスクリーンキャンバスを作成
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = displayRegion.width;
      exportCanvas.height = displayRegion.height;
      const ctx = exportCanvas.getContext('2d');
      if (!ctx) return;

      // 画像を描画
      ctx.drawImage(
        loadedImage,
        displayRegion.x, displayRegion.y, displayRegion.width, displayRegion.height,
        0, 0, displayRegion.width, displayRegion.height
      );

      // アノテーションのみを描画（バウンディングボックスは含まない）
      annotations.forEach(ann => drawAnnotation(ctx, ann, displayRegion));

      const blob = await new Promise<Blob>((resolve, reject) => {
        exportCanvas.toBlob(b => {
          if (b) resolve(b);
          else reject(new Error('Failed to create blob'));
        }, 'image/png');
      });

      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob })
      ]);

      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      alert('クリップボードへのコピーに失敗しました: ' + err);
    }
  };

  const handleSaveAs = async () => {
    if (!loadedImage || displayRegion.width === 0) return;

    try {
      // バウンディングボックスを含まないオフスクリーンキャンバスを作成
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = displayRegion.width;
      exportCanvas.height = displayRegion.height;
      const ctx = exportCanvas.getContext('2d');
      if (!ctx) return;

      // 画像を描画
      ctx.drawImage(
        loadedImage,
        displayRegion.x, displayRegion.y, displayRegion.width, displayRegion.height,
        0, 0, displayRegion.width, displayRegion.height
      );

      // アノテーションのみを描画（バウンディングボックスは含まない）
      annotations.forEach(ann => drawAnnotation(ctx, ann, displayRegion));

      const blob = await new Promise<Blob>((resolve, reject) => {
        exportCanvas.toBlob(b => {
          if (b) resolve(b);
          else reject(new Error('Failed to create blob'));
        }, 'image/png');
      });

      const filePath = await save({
        filters: [{ name: 'PNG画像', extensions: ['png'] }],
        defaultPath: 'screenshot.png',
      });

      if (filePath) {
        const arrayBuffer = await blob.arrayBuffer();
        await writeFile(filePath, new Uint8Array(arrayBuffer));
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch (err) {
      alert('ファイルの保存に失敗しました: ' + err);
    }
  };

  const handleUndo = useCallback(() => {
    if (history.length > 0) {
      setHistory(history.slice(0, -1));
    }
  }, [history]);

  // ズームはCtrl+-/+キーボードショートカットで操作

  const zoomIn = useCallback(() => setZoom(prev => Math.min(3, prev + 0.25)), []);
  const zoomOut = useCallback(() => setZoom(prev => Math.max(0.5, prev - 0.25)), []);
  const resetZoom = useCallback(() => setZoom(1), []);

  // Ctrl+Z / Ctrl+/-/0 / Space キーボードショートカット
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey) {
        if (e.code === 'KeyZ') {
          e.preventDefault();
          handleUndo();
        } else if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.code === 'Semicolon') {
          e.preventDefault();
          zoomIn();
        } else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
          e.preventDefault();
          zoomOut();
        } else if (e.code === 'Digit0' || e.code === 'Numpad0') {
          e.preventDefault();
          resetZoom();
        }
      }
      if (e.code === 'Space') {
        e.preventDefault(); // リピートイベントでもブラウザのスクロールを防止
        if (!e.repeat) {
          setIsSpacePanning(true);
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
      // Delete/Backspaceで選択中のアノテーションを削除
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !textInput && !leaderTextInput) {
        e.preventDefault();
        setHistory(prev => prev.filter(h => !(h.type === 'annotation' && h.annotation.id === selectedId)));
        setSelectedId(null);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setIsSpacePanning(false);
        setIsPanning(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [handleUndo, zoomIn, zoomOut, resetZoom, onClose, selectedId, textInput, leaderTextInput]);

  // コンテナのドラッグパン
  const handleContainerMouseDown = (e: React.MouseEvent) => {
    if (e.target === containerRef.current && zoom > 1) {
      setIsPanning(true);
      setPanStart({
        x: e.clientX,
        y: e.clientY,
        scrollLeft: containerRef.current?.scrollLeft || 0,
        scrollTop: containerRef.current?.scrollTop || 0,
      });
    }
  };

  const handleContainerMouseMove = (e: React.MouseEvent) => {
    if (!isPanning || !containerRef.current) return;
    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;
    containerRef.current.scrollLeft = panStart.scrollLeft - dx;
    containerRef.current.scrollTop = panStart.scrollTop - dy;
  };

  const handleContainerMouseUp = () => {
    setIsPanning(false);
  };

  const decreaseLineWidth = () => {
    const idx = LINE_WIDTHS.indexOf(lineWidth);
    if (idx > 0) setLineWidth(LINE_WIDTHS[idx - 1]);
  };

  const increaseLineWidth = () => {
    const idx = LINE_WIDTHS.indexOf(lineWidth);
    if (idx < LINE_WIDTHS.length - 1) setLineWidth(LINE_WIDTHS[idx + 1]);
  };

  const handleTextSubmit = () => {
    if (textInput && textValue.trim()) {
      if (editingAnnotationId) {
        // 既存のテキストを編集
        const updatedHistory = history.map(h => {
          if (h.type === 'annotation' && h.annotation.id === editingAnnotationId && h.annotation.text) {
            return {
              ...h,
              annotation: {
                ...h.annotation,
                text: {
                  ...h.annotation.text,
                  content: textValue.trim(),
                  vertical: textVertical,
                },
              },
            };
          }
          return h;
        });
        setHistory(updatedHistory);
        setSelectedId(editingAnnotationId);
      } else {
        // 新規テキスト作成
        const adjustedFontSize = 24 / baseScale;
        const annotation: Annotation = {
          id: generateId(),
          type: 'text',
          color,
          lineWidth: 0,
          text: { x: textInput.x, y: textInput.y, content: textValue.trim(), fontSize: adjustedFontSize, vertical: textVertical },
        };
        setHistory([...history, { type: 'annotation', annotation }]);
        setSelectedId(annotation.id);
      }
    }
    setTextInput(null);
    setTextValue('');
    setEditingAnnotationId(null);
  };

  const handleTextCancel = () => {
    setTextInput(null);
    setTextValue('');
    setEditingAnnotationId(null);
  };

  // 引き出し線テキスト確定
  const handleLeaderTextSubmit = () => {
    if (leaderTextInput && leaderTextValue.trim()) {
      if (editingAnnotationId) {
        // 既存の引き出し線テキストを編集
        const updatedHistory = history.map(h => {
          if (h.type === 'annotation' && h.annotation.id === editingAnnotationId && h.annotation.label) {
            return {
              ...h,
              annotation: {
                ...h.annotation,
                label: {
                  ...h.annotation.label,
                  content: leaderTextValue.trim(),
                  vertical: textVertical,
                },
              },
            };
          }
          return h;
        });
        setHistory(updatedHistory);
        setSelectedId(editingAnnotationId);
        setEditingAnnotationId(null);
      } else {
        // 新規作成
        const adjustedFontSize = 24 / baseScale;
        // テキストは線の終点より少し下に配置
        const finalAnnotation: Annotation = {
          ...leaderTextInput.annotation,
          label: {
            x: leaderTextInput.annotation.leaderLine!.endX,
            y: leaderTextInput.annotation.leaderLine!.endY + adjustedFontSize * 1.2,
            content: leaderTextValue.trim(),
            fontSize: adjustedFontSize,
            vertical: textVertical,
          },
        };
        setHistory([...history, { type: 'annotation', annotation: finalAnnotation }]);
        setSelectedId(finalAnnotation.id);
      }
    }
    setLeaderTextInput(null);
    setLeaderTextValue('');
  };

  const handleLeaderTextCancel = () => {
    if (editingAnnotationId) {
      // 編集モードのキャンセル：変更を破棄するだけ
      setEditingAnnotationId(null);
    } else if (leaderTextInput) {
      // 新規作成時のキャンセル：テキストなしでも枠線+引き出し線は保存
      setHistory([...history, { type: 'annotation', annotation: leaderTextInput.annotation }]);
      setSelectedId(leaderTextInput.annotation.id);
    }
    setLeaderTextInput(null);
    setLeaderTextValue('');
  };

  return (
    <>
      {/* コピー/保存完了オーバーレイ */}
      {copied && (
        <div className="fixed inset-0 flex items-center justify-center z-[200] pointer-events-none">
          <div className="bg-neutral-800 rounded-xl p-6 max-w-md shadow-2xl border border-neutral-700">
            <div className="text-green-400 text-lg font-bold flex items-center gap-2">
              <Check size={20} /> 完了しました
            </div>
          </div>
        </div>
      )}
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[100] p-4">
      <div className="bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 flex flex-col w-[95vw] h-[95vh]">
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-neutral-700">
          <div className="flex items-center gap-2">
            {/* ツール選択 */}
            <div className="flex items-center gap-0.5 bg-neutral-900 rounded p-0.5">
              <button
                onClick={() => { setTool('select'); setSelectedId(null); }}
                className={`p-1.5 rounded ${tool === 'select' ? 'bg-purple-600 text-white' : 'text-neutral-400 hover:text-white'}`}
                title="選択"
              >
                <MousePointer2 size={16} />
              </button>
              <div
                ref={rectOptionsRef}
                className="relative"
                onMouseEnter={() => setShowRectOptions(true)}
                onMouseLeave={() => setShowRectOptions(false)}
              >
                <button
                  onClick={() => setTool('rect')}
                  className={`p-1.5 rounded ${tool === 'rect' ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:text-white'}`}
                  title="枠線"
                >
                  <Square size={16} />
                </button>
                {/* 枠線オプションポップアップ */}
                {showRectOptions && (
                  <div className="absolute top-full left-0 pt-1 z-20">
                    <div className="p-2 bg-neutral-800 rounded-lg shadow-xl border border-neutral-600 whitespace-nowrap">
                    <label className="flex items-center gap-2 cursor-pointer text-sm text-neutral-300 hover:text-white">
                      <input
                        type="checkbox"
                        checked={rectWithLeaderMode}
                        onChange={(e) => setRectWithLeaderMode(e.target.checked)}
                        className="w-4 h-4 rounded border-neutral-500 bg-neutral-700 text-blue-600 focus:ring-blue-500"
                      />
                      引き出し線付き
                    </label>
                    </div>
                  </div>
                )}
              </div>
              <button
                onClick={() => setTool('pen')}
                className={`p-1.5 rounded ${tool === 'pen' ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:text-white'}`}
                title="ペン"
              >
                <Pen size={16} />
              </button>
              <button
                onClick={() => setTool('text')}
                className={`p-1.5 rounded ${tool === 'text' ? 'bg-blue-600 text-white' : 'text-neutral-400 hover:text-white'}`}
                title="テキスト"
              >
                <Type size={16} />
              </button>
              <button
                onClick={() => setTool('crop')}
                className={`p-1.5 rounded ${tool === 'crop' ? 'bg-green-600 text-white' : 'text-neutral-400 hover:text-white'}`}
                title="切り取り"
              >
                <Crop size={16} />
              </button>
              <button
                onClick={() => setTool('hand')}
                className={`p-1.5 rounded ${tool === 'hand' || isSpacePanning ? 'bg-amber-600 text-white' : 'text-neutral-400 hover:text-white'}`}
                title="手のひら (Space押しながらドラッグ)"
              >
                <Hand size={16} />
              </button>
            </div>

            {/* 線の太さと色（rect/pen/textツールで表示） */}
            {(tool === 'rect' || tool === 'pen' || tool === 'text') && (
              <div ref={colorPaletteRef} className="flex items-center gap-0.5 bg-neutral-900 rounded p-0.5 relative">
                {(tool === 'rect' || tool === 'pen') && (
                  <button
                    onClick={decreaseLineWidth}
                    disabled={lineWidth === LINE_WIDTHS[0]}
                    className="p-1.5 rounded text-neutral-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                    title="細く"
                  >
                    <Minus size={14} />
                  </button>
                )}
                <button
                  onClick={() => setShowColorPalette(!showColorPalette)}
                  className="flex items-center justify-center w-7 h-7 rounded hover:bg-neutral-700 cursor-pointer"
                  title="色を選択"
                >
                  <div
                    className="rounded-full border-2 border-neutral-600"
                    style={{
                      width: (tool === 'rect' || tool === 'pen') ? lineWidth * 2.5 : 14,
                      height: (tool === 'rect' || tool === 'pen') ? lineWidth * 2.5 : 14,
                      backgroundColor: color,
                    }}
                  />
                </button>
                {(tool === 'rect' || tool === 'pen') && (
                  <button
                    onClick={increaseLineWidth}
                    disabled={lineWidth === LINE_WIDTHS[LINE_WIDTHS.length - 1]}
                    className="p-1.5 rounded text-neutral-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                    title="太く"
                  >
                    <Plus size={14} />
                  </button>
                )}

                {/* 色パレットポップアップ */}
                {showColorPalette && (
                  <div className="absolute top-full left-0 mt-2 p-2 bg-neutral-900 rounded-lg shadow-xl border-2 border-neutral-500 z-20">
                    <div className="grid grid-cols-4 gap-1">
                      {COLORS.map(c => (
                        <button
                          key={c}
                          onClick={() => { setColor(c); setShowColorPalette(false); }}
                          className={`w-6 h-6 rounded border ${color === c ? 'ring-2 ring-white ring-offset-1 ring-offset-neutral-900' : 'border-neutral-600'} hover:opacity-80 transition-opacity`}
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 元に戻す */}
            <button
              onClick={handleUndo}
              disabled={history.length === 0}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded"
              title="Ctrl+Z"
            >
              <Undo2 size={12} /> 戻す
            </button>

            {/* クロップ状態表示 */}
            {cropRegion && (
              <div className="text-xs text-green-400 bg-green-900/50 px-1.5 py-0.5 rounded">
                切り取り済
              </div>
            )}

            {/* ズームコントロール */}
            <div className="flex items-center gap-0.5 bg-neutral-900 rounded p-0.5">
              <button
                onClick={zoomOut}
                className="p-1.5 rounded text-neutral-400 hover:text-white"
                title="縮小"
              >
                <ZoomOut size={14} />
              </button>
              <span className="text-neutral-300 text-xs min-w-[2.5rem] text-center">
                {Math.round(zoom * 100)}%
              </span>
              <button
                onClick={zoomIn}
                className="p-1.5 rounded text-neutral-400 hover:text-white"
                title="拡大"
              >
                <ZoomIn size={14} />
              </button>
              <button
                onClick={resetZoom}
                className="p-1.5 rounded text-neutral-400 hover:text-white"
                title="フィット"
              >
                <Maximize size={14} />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* ショートカットヒント */}
            <div className="flex items-center gap-3 text-xs px-2 py-1 bg-neutral-800 rounded border border-neutral-600">
              <span className="flex items-center gap-1">
                <kbd className="px-1 py-0.5 bg-neutral-700 rounded text-neutral-200 font-mono text-[10px] border border-neutral-500">Space</kbd>
                <span className="text-neutral-400">手</span>
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1 py-0.5 bg-neutral-700 rounded text-neutral-200 font-mono text-[10px] border border-neutral-500">Ctrl+Z</kbd>
                <span className="text-neutral-400">戻す</span>
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1 py-0.5 bg-neutral-700 rounded text-neutral-200 font-mono text-[10px] border border-neutral-500">Ctrl+-/+</kbd>
                <span className="text-neutral-400">ズーム</span>
              </span>
            </div>
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-3 py-1 text-sm bg-green-600 hover:bg-green-500 text-white rounded transition-colors"
            >
              <Copy size={14} /> コピー
            </button>
            <button
              onClick={handleSaveAs}
              className="flex items-center gap-1.5 px-3 py-1 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
            >
              <Download size={14} /> 保存
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-neutral-400 hover:text-white"
              title="Esc"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Canvas */}
        <div
          ref={containerRef}
          className="flex-1 overflow-auto min-h-0"
          style={{ cursor: zoom > 1 ? (isPanning ? 'grabbing' : 'grab') : (tool === 'crop' ? 'crosshair' : 'default') }}
          onMouseDown={handleContainerMouseDown}
          onMouseMove={handleContainerMouseMove}
          onMouseUp={handleContainerMouseUp}
          onMouseLeave={handleContainerMouseUp}
        >
          <div
            className="inline-block"
            style={{
              // コンテナの半分のパディングを追加して中央配置 + 端までスクロール可能にする
              padding: containerSize.width > 0
                ? `${containerSize.height / 2}px ${containerSize.width / 2}px`
                : '200px',
            }}
          >
            {/* 画像と注釈Canvasを重ねるコンテナ */}
            <div
              style={{
                position: 'relative',
                display: displayRegion.width > 0 ? 'block' : 'none',
                width: displayWidth,
                height: displayHeight,
                overflow: 'hidden',
                transition: 'width 0.1s ease-out, height 0.1s ease-out',
              }}
              className="shadow-lg"
            >
              {/* 画像表示（ダブルビューワーと同じ<img>タグ） */}
              <img
                src={imageData}
                alt="Editor"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  // 画像全体を表示スケールに合わせる
                  width: imageSize.width * baseScale * zoom,
                  height: imageSize.height * baseScale * zoom,
                  // クロップ開始位置分、負の方向にずらす
                  marginLeft: -displayRegion.x * baseScale * zoom,
                  marginTop: -displayRegion.y * baseScale * zoom,
                  pointerEvents: 'none',
                  userSelect: 'none',
                }}
                draggable={false}
              />
              {/* 注釈用の透明Canvas（画像の上に重ねる） */}
              <canvas
                ref={canvasRef}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={(e) => handleMouseUp(e)}
                onMouseLeave={(e) => handleMouseUp(e)}
                onDoubleClick={handleDoubleClick}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: displayWidth,
                  height: displayHeight,
                  cursor: isPanning ? 'grabbing' : (tool === 'hand' || isSpacePanning) ? 'grab' : (tool === 'text' ? 'text' : (tool === 'select' ? (isResizing ? (
                    resizeHandle === 'tl' || resizeHandle === 'br' ? 'nwse-resize' :
                    resizeHandle === 'tr' || resizeHandle === 'bl' ? 'nesw-resize' :
                    resizeHandle === 't' || resizeHandle === 'b' ? 'ns-resize' :
                    resizeHandle === 'l' || resizeHandle === 'r' ? 'ew-resize' : 'nwse-resize'
                  ) : (isMoving ? 'move' : 'default')) : 'crosshair')),
                }}
              />
            </div>
          </div>
        </div>

        {/* テキスト入力ダイアログ */}
        {textInput && (
          <div
            className="fixed z-[110] bg-neutral-800 rounded-lg shadow-xl border border-neutral-600 p-2"
            style={{ left: textInput.screenX, top: textInput.screenY }}
          >
            <textarea
              ref={textInputRef}
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleTextSubmit();
                } else if (e.key === 'Escape') {
                  handleTextCancel();
                }
              }}
              className="bg-neutral-700 text-neutral-200 px-2 py-1 rounded outline-none focus:ring-2 focus:ring-blue-500 min-w-[200px] min-h-[60px] resize-none placeholder:text-neutral-400"
              placeholder="テキストを入力... (Shift+Enterで改行)"
              rows={3}
            />
            <div className="flex gap-1 mt-2">
              <button
                onClick={() => setTextVertical(!textVertical)}
                className={`px-2 py-1 text-sm rounded transition ${textVertical ? 'bg-purple-600 text-white' : 'bg-neutral-600 text-neutral-300 hover:bg-neutral-500'}`}
                title="縦書き/横書き切替"
              >
                {textVertical ? '縦' : '横'}
              </button>
              <button
                onClick={handleTextSubmit}
                className="flex-1 px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded"
              >
                確定
              </button>
              <button
                onClick={handleTextCancel}
                className="flex-1 px-2 py-1 bg-neutral-600 hover:bg-neutral-500 text-white text-sm rounded"
              >
                キャンセル
              </button>
            </div>
          </div>
        )}

        {/* 引き出し線テキスト入力ダイアログ */}
        {leaderTextInput && (
          <div
            className="fixed z-[110] bg-neutral-800 rounded-lg shadow-xl border border-neutral-600 p-2"
            style={{ left: leaderTextInput.screenX, top: leaderTextInput.screenY }}
          >
            <div className="text-xs text-neutral-400 mb-1">補足テキスト</div>
            <textarea
              ref={leaderTextInputRef}
              value={leaderTextValue}
              onChange={(e) => setLeaderTextValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleLeaderTextSubmit();
                } else if (e.key === 'Escape') {
                  handleLeaderTextCancel();
                }
              }}
              className="bg-neutral-700 text-neutral-200 px-2 py-1 rounded outline-none focus:ring-2 focus:ring-blue-500 min-w-[200px] min-h-[60px] resize-none placeholder:text-neutral-400"
              placeholder="補足テキストを入力... (Shift+Enterで改行)"
              rows={3}
            />
            <div className="flex gap-1 mt-2">
              <button
                onClick={() => setTextVertical(!textVertical)}
                className={`px-2 py-1 text-sm rounded transition ${textVertical ? 'bg-purple-600 text-white' : 'bg-neutral-600 text-neutral-300 hover:bg-neutral-500'}`}
                title="縦書き/横書き切替"
              >
                {textVertical ? '縦' : '横'}
              </button>
              <button
                onClick={handleLeaderTextSubmit}
                className="flex-1 px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded"
              >
                確定
              </button>
              <button
                onClick={handleLeaderTextCancel}
                className="flex-1 px-2 py-1 bg-neutral-600 hover:bg-neutral-500 text-white text-sm rounded"
              >
                スキップ
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
    </>
  );
}
