use base64::{engine::general_purpose::STANDARD, Engine};
use image::{ImageBuffer, Rgba, DynamicImage, GenericImageView};
use image::imageops::FilterType;
use psd::Psd;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::Mutex;
use std::collections::{HashMap, VecDeque};
use tauri::State;

// ============== 画像キャッシュ ==============
struct CachedImage {
    data: Vec<u8>,  // PNG bytes
    width: u32,
    height: u32,
}

struct ImageCache {
    cache: HashMap<String, CachedImage>,
    order: VecDeque<String>,
    max_size: usize,
}

impl ImageCache {
    fn new(max_size: usize) -> Self {
        Self {
            cache: HashMap::new(),
            order: VecDeque::new(),
            max_size,
        }
    }

    fn get(&self, key: &str) -> Option<&CachedImage> {
        self.cache.get(key)
    }

    fn insert(&mut self, key: String, image: CachedImage) {
        // LRUキャッシュ: 古いものを削除
        if self.cache.len() >= self.max_size {
            if let Some(oldest) = self.order.pop_front() {
                self.cache.remove(&oldest);
            }
        }
        self.order.push_back(key.clone());
        self.cache.insert(key, image);
    }

    fn clear(&mut self) {
        self.cache.clear();
        self.order.clear();
    }
}

// グローバルキャッシュ（Mutexで保護）
struct AppState {
    image_cache: Mutex<ImageCache>,
}

// ============== 画像処理結果 ==============
#[derive(Serialize)]
struct ImageResult {
    data_url: String,
    width: u32,
    height: u32,
    original_width: u32,
    original_height: u32,
}

// PSD解析結果（Base64 PNG画像として返す）
#[derive(Serialize)]
struct PsdImageResult {
    data_url: String, // data:image/png;base64,... 形式
    width: u32,
    height: u32,
}

// PSDファイルをパースしてBase64 PNG画像を返す
#[tauri::command]
fn parse_psd(path: String) -> Result<PsdImageResult, String> {
    // ファイル読み込み
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;

    // PSD解析
    let psd = Psd::from_bytes(&bytes).map_err(|e| format!("Failed to parse PSD: {}", e))?;
    let width = psd.width();
    let height = psd.height();
    let rgba = psd.rgba();

    // RGBA画像を作成
    let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(width, height, rgba)
            .ok_or_else(|| "Failed to create image buffer".to_string())?;

    // PNG形式でエンコード
    let mut png_data = Cursor::new(Vec::new());
    img.write_to(&mut png_data, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode PNG: {}", e))?;

    // Base64エンコード
    let base64_str = STANDARD.encode(png_data.get_ref());
    let data_url = format!("data:image/png;base64,{}", base64_str);

    Ok(PsdImageResult {
        data_url,
        width,
        height,
    })
}

// ファイルをシステムのデフォルトアプリで開く
#[tauri::command]
fn open_file_with_default_app(path: String) -> Result<(), String> {
    open::that(&path).map_err(|e| format!("Failed to open file: {}", e))
}

// スクリーンショット保存結果
#[derive(Serialize)]
struct SaveScreenshotResult {
    file_path: String,
    folder_path: String,
}

// スクリーンショットを保存
#[tauri::command]
fn save_screenshot(image_data: String, file_name: String) -> Result<SaveScreenshotResult, String> {
    // デスクトップパスを取得
    let desktop = dirs::desktop_dir()
        .ok_or_else(|| "Failed to get desktop path".to_string())?;

    // 保存先フォルダを作成
    let folder_path = desktop.join("Script_Output").join("検版ツール");
    fs::create_dir_all(&folder_path)
        .map_err(|e| format!("Failed to create folder: {}", e))?;

    // ファイル名を生成（拡張子を.pngに変更）
    let base_name = PathBuf::from(&file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "screenshot".to_string());

    // 重複回避のためタイムスタンプを追加
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let final_name = format!("{}_{}.png", base_name, timestamp);
    let file_path = folder_path.join(&final_name);

    // Base64デコード（data:image/png;base64, プレフィックスを除去）
    let base64_data = image_data
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(&image_data);
    let image_bytes = STANDARD.decode(base64_data)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    // ファイルに保存
    fs::write(&file_path, image_bytes)
        .map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(SaveScreenshotResult {
        file_path: file_path.to_string_lossy().to_string(),
        folder_path: folder_path.to_string_lossy().to_string(),
    })
}

// フォルダをエクスプローラーで開く
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    open::that(&path).map_err(|e| format!("Failed to open folder: {}", e))
}

// MojiQのパスを探す
fn find_mojiq_path() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // 1. Program Files
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        candidates.push(PathBuf::from(&program_files).join("MojiQ").join("MojiQ.exe"));
    }

    // 2. Program Files (x86)
    if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(&program_files_x86).join("MojiQ").join("MojiQ.exe"));
    }

    // 3. ユーザーのLocalAppData\Programs（Electronのデフォルト）
    if let Some(local_app_data) = dirs::data_local_dir() {
        candidates.push(local_app_data.join("Programs").join("MojiQ").join("MojiQ.exe"));
        candidates.push(local_app_data.join("Programs").join("mojiq").join("MojiQ.exe"));
    }

    // 4. デスクトップ > MojiK > MojiQ（開発用）
    if let Some(desktop) = dirs::desktop_dir() {
        candidates.push(desktop.join("MojiK").join("MojiQ").join("dist").join("win-unpacked").join("MojiQ.exe"));
    }

    // 最初に見つかったパスを返す
    for path in candidates {
        if path.exists() {
            return Some(path);
        }
    }

    None
}

// MojiQでPDFを開く（ページ指定付き）
#[tauri::command]
fn open_pdf_in_mojiq(pdf_path: String, page: Option<u32>) -> Result<(), String> {
    // MojiQ.exeのパスを探す
    let mojiq_path = find_mojiq_path()
        .ok_or_else(|| "MojiQ.exe が見つかりません。MojiQをインストールしてください。".to_string())?;

    let mut cmd = std::process::Command::new(&mojiq_path);

    if let Some(p) = page {
        cmd.arg("--page");
        cmd.arg(p.to_string());
    }
    cmd.arg(&pdf_path);

    cmd.spawn().map_err(|e| format!("Failed to launch MojiQ: {}", e))?;

    Ok(())
}

// ============== 並列ビューモード用の高速画像処理 ==============

// 画像をリサイズしてBase64 PNGとして返す（内部ヘルパー）
fn resize_image_to_png(img: &DynamicImage, max_width: u32, max_height: u32) -> Result<(Vec<u8>, u32, u32), String> {
    let (orig_w, orig_h) = img.dimensions();

    // アスペクト比を保ちながらリサイズ
    let scale_w = max_width as f64 / orig_w as f64;
    let scale_h = max_height as f64 / orig_h as f64;
    let scale = scale_w.min(scale_h).min(1.0); // 拡大はしない

    let new_w = (orig_w as f64 * scale).round() as u32;
    let new_h = (orig_h as f64 * scale).round() as u32;

    // PNGエンコード（リサイズが必要な場合のみリサイズ）
    let mut png_data = Cursor::new(Vec::new());
    if scale < 1.0 {
        let resized = img.resize(new_w, new_h, FilterType::Triangle);
        resized.write_to(&mut png_data, image::ImageFormat::Png)
            .map_err(|e| format!("Failed to encode PNG: {}", e))?;
    } else {
        img.write_to(&mut png_data, image::ImageFormat::Png)
            .map_err(|e| format!("Failed to encode PNG: {}", e))?;
    }

    Ok((png_data.into_inner(), new_w, new_h))
}

// TIFF/PNG/JPG画像をデコード+リサイズして返す
#[tauri::command]
fn decode_and_resize_image(
    state: State<'_, AppState>,
    path: String,
    max_width: u32,
    max_height: u32,
) -> Result<ImageResult, String> {
    // キャッシュキー生成
    let cache_key = format!("{}:{}x{}", path, max_width, max_height);

    // キャッシュチェック
    {
        let cache = state.image_cache.lock().map_err(|e| e.to_string())?;
        if let Some(cached) = cache.get(&cache_key) {
            let base64_str = STANDARD.encode(&cached.data);
            return Ok(ImageResult {
                data_url: format!("data:image/png;base64,{}", base64_str),
                width: cached.width,
                height: cached.height,
                original_width: cached.width, // キャッシュからは元サイズ不明
                original_height: cached.height,
            });
        }
    }

    // 画像読み込み
    let img = image::open(&path)
        .map_err(|e| format!("Failed to open image: {}", e))?;

    let (orig_w, orig_h) = img.dimensions();

    // リサイズ+PNGエンコード
    let (png_data, new_w, new_h) = resize_image_to_png(&img, max_width, max_height)?;

    // キャッシュに保存し、キャッシュからbase64エンコード（clone回避）
    let base64_str = {
        let mut cache = state.image_cache.lock().map_err(|e| e.to_string())?;
        cache.insert(cache_key.clone(), CachedImage {
            data: png_data,
            width: new_w,
            height: new_h,
        });
        STANDARD.encode(&cache.get(&cache_key).unwrap().data)
    };
    Ok(ImageResult {
        data_url: format!("data:image/png;base64,{}", base64_str),
        width: new_w,
        height: new_h,
        original_width: orig_w,
        original_height: orig_h,
    })
}

// 複数画像を先読み（バックグラウンドでキャッシュ）- rayon並列化版
#[tauri::command]
async fn preload_images(
    state: State<'_, AppState>,
    paths: Vec<String>,
    max_width: u32,
    max_height: u32,
) -> Result<Vec<String>, String> {
    // 既にキャッシュにあるパスを除外
    let paths_to_load: Vec<String> = {
        let cache = state.image_cache.lock().map_err(|e| e.to_string())?;
        paths.into_iter()
            .filter(|path| {
                let cache_key = format!("{}:{}x{}", path, max_width, max_height);
                cache.get(&cache_key).is_none()
            })
            .collect()
    };

    if paths_to_load.is_empty() {
        return Ok(vec!["all cached".to_string()]);
    }

    // rayonで並列に画像を読み込み・リサイズ
    let loaded: Vec<(String, Result<(Vec<u8>, u32, u32), String>)> = paths_to_load
        .par_iter()
        .map(|path| {
            let result = image::open(path)
                .map_err(|e| format!("open error: {}", e))
                .and_then(|img| {
                    resize_image_to_png(&img, max_width, max_height)
                });
            (path.clone(), result)
        })
        .collect();

    // キャッシュに一括登録
    let mut results = Vec::new();
    {
        let mut cache = state.image_cache.lock().map_err(|e| e.to_string())?;
        for (path, result) in loaded {
            let cache_key = format!("{}:{}x{}", path, max_width, max_height);
            match result {
                Ok((png_data, new_w, new_h)) => {
                    cache.insert(cache_key, CachedImage {
                        data: png_data,
                        width: new_w,
                        height: new_h,
                    });
                    results.push(format!("loaded:{}", path));
                }
                Err(e) => results.push(format!("error:{}:{}", path, e)),
            }
        }
    }

    Ok(results)
}

// キャッシュクリア
#[tauri::command]
fn clear_image_cache(state: State<'_, AppState>) -> Result<(), String> {
    let mut cache = state.image_cache.lock().map_err(|e| e.to_string())?;
    cache.clear();
    Ok(())
}

// フォルダ内のファイル一覧を取得
#[tauri::command]
fn list_files_in_folder(path: String, extensions: Vec<String>) -> Result<Vec<String>, String> {
    let dir = std::fs::read_dir(&path)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut files: Vec<String> = dir
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if path.is_file() {
                let ext = path.extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_lowercase())
                    .unwrap_or_default();
                if extensions.iter().any(|e| e.to_lowercase() == ext) {
                    return path.to_str().map(|s| s.to_string());
                }
            }
            None
        })
        .collect();

    // 自然順ソート（ファイル名でソート）
    files.sort_by(|a, b| {
        let name_a = PathBuf::from(a).file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_lowercase();
        let name_b = PathBuf::from(b).file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_lowercase();
        natord::compare(&name_a, &name_b)
    });

    Ok(files)
}

// ============== 差分計算 ==============

#[derive(Deserialize)]
struct CropBounds {
    left: u32,
    top: u32,
    right: u32,
    bottom: u32,
}

#[derive(Serialize, Clone)]
struct DiffMarker {
    x: f64,
    y: f64,
    radius: f64,
    count: u32,
}

#[derive(Serialize)]
struct DiffSimpleResult {
    src_a: String,
    src_b: String,
    diff_src: String,
    has_diff: bool,
    diff_count: u32,
    markers: Vec<DiffMarker>,
    image_width: u32,
    image_height: u32,
}

#[derive(Serialize)]
struct DiffHeatmapResult {
    src_a: String,
    src_b: String,
    processed_a: String,
    diff_src: String,
    has_diff: bool,
    diff_probability: f64,
    high_density_count: u32,
    markers: Vec<DiffMarker>,
    image_width: u32,
    image_height: u32,
}

// 拡張子でPSD/TIFF/その他を自動判定してデコード
fn decode_image_file(path: &str) -> Result<DynamicImage, String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".psd") {
        decode_psd_to_image(path)
    } else {
        image::open(path).map_err(|e| format!("Failed to open image {}: {}", path, e))
    }
}

// PSDファイルをDynamicImageとしてデコード
fn decode_psd_to_image(path: &str) -> Result<DynamicImage, String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read PSD: {}", e))?;
    let psd = Psd::from_bytes(&bytes).map_err(|e| format!("Failed to parse PSD: {}", e))?;
    let width = psd.width();
    let height = psd.height();
    let rgba = psd.rgba();
    let img_buf: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(width, height, rgba)
            .ok_or_else(|| "Failed to create image buffer from PSD".to_string())?;
    Ok(DynamicImage::ImageRgba8(img_buf))
}

// RGBA画像をbase64 data URLにエンコード
fn encode_to_data_url(img: &DynamicImage) -> Result<String, String> {
    let mut png_data = Cursor::new(Vec::new());
    img.write_to(&mut png_data, image::ImageFormat::Png)
        .map_err(|e| format!("PNG encode error: {}", e))?;
    let base64_str = STANDARD.encode(png_data.get_ref());
    Ok(format!("data:image/png;base64,{}", base64_str))
}

// RGBAバッファから直接data URLにエンコード（DynamicImage変換なし）
fn encode_rgba_to_data_url(buf: &[u8], width: u32, height: u32) -> Result<String, String> {
    let img: ImageBuffer<Rgba<u8>, &[u8]> =
        ImageBuffer::from_raw(width, height, buf)
            .ok_or_else(|| "Failed to create image buffer".to_string())?;
    let mut png_data = Cursor::new(Vec::new());
    img.write_to(&mut png_data, image::ImageFormat::Png)
        .map_err(|e| format!("PNG encode error: {}", e))?;
    let base64_str = STANDARD.encode(png_data.get_ref());
    Ok(format!("data:image/png;base64,{}", base64_str))
}

struct DiffPixel {
    x: u32,
    y: u32,
}

// ピクセル単位の単純差分計算 (rayon行並列)
// 返り値: (差分RGBAバッファ, 差分ピクセル数, 差分ピクセル座標リスト)
fn diff_simple_core(
    a: &[u8], b: &[u8], width: u32, height: u32, threshold: u8,
) -> (Vec<u8>, u32, Vec<DiffPixel>) {
    let threshold = threshold as i16;
    let row_size = (width as usize) * 4;

    // 行ごとに並列処理
    let rows: Vec<(Vec<u8>, u32, Vec<DiffPixel>)> = (0..height)
        .into_par_iter()
        .map(|y| {
            let offset = (y as usize) * row_size;
            let row_a = &a[offset..offset + row_size];
            let row_b = &b[offset..offset + row_size];
            let mut row_buf = vec![0u8; row_size];
            let mut count = 0u32;
            let mut pixels = Vec::new();

            for x in 0..width as usize {
                let i = x * 4;
                let dr = (row_a[i] as i16 - row_b[i] as i16).abs();
                let dg = (row_a[i + 1] as i16 - row_b[i + 1] as i16).abs();
                let db = (row_a[i + 2] as i16 - row_b[i + 2] as i16).abs();

                if dr > threshold || dg > threshold || db > threshold {
                    row_buf[i] = 255;     // R
                    row_buf[i + 1] = 0;   // G
                    row_buf[i + 2] = 0;   // B
                    row_buf[i + 3] = 255; // A
                    count += 1;
                    pixels.push(DiffPixel { x: x as u32, y });
                } else {
                    // 黒背景（alpha=255）
                    row_buf[i + 3] = 255;
                }
            }
            (row_buf, count, pixels)
        })
        .collect();

    let total_size = (width as usize) * (height as usize) * 4;
    let mut diff_buf = vec![0u8; total_size];
    let mut total_count = 0u32;
    let mut all_pixels = Vec::new();

    for (y, (row_buf, count, pixels)) in rows.into_iter().enumerate() {
        let offset = y * row_size;
        diff_buf[offset..offset + row_size].copy_from_slice(&row_buf);
        total_count += count;
        all_pixels.extend(pixels);
    }

    (diff_buf, total_count, all_pixels)
}

// ヒートマップ差分計算（積分画像→密度マップ→着色）
fn diff_heatmap_core(
    a: &[u8], b: &[u8], width: u32, height: u32, threshold: u8,
) -> (Vec<u8>, u32, Vec<DiffPixel>) {
    let w = width as usize;
    let h = height as usize;
    let threshold = threshold as i16;

    // Phase 1: diffMask作成（rayon並列）
    let diff_mask: Vec<u8> = (0..h)
        .into_par_iter()
        .flat_map(|y| {
            let offset = y * w * 4;
            (0..w).map(move |x| {
                let i = offset + x * 4;
                let dr = (a[i] as i16 - b[i] as i16).abs();
                let dg = (a[i + 1] as i16 - b[i + 1] as i16).abs();
                let db = (a[i + 2] as i16 - b[i + 2] as i16).abs();
                if dr > threshold || dg > threshold || db > threshold { 1u8 } else { 0u8 }
            }).collect::<Vec<_>>()
        })
        .collect();

    // Phase 2: 積分画像（sequential - データ依存あり）
    let iw = w + 1;
    let ih = h + 1;
    let mut integral = vec![0f32; iw * ih];
    for y in 0..h {
        for x in 0..w {
            let idx = (y + 1) * iw + (x + 1);
            integral[idx] = diff_mask[y * w + x] as f32
                + integral[idx - 1]
                + integral[idx - iw]
                - integral[idx - iw - 1];
        }
    }

    // Phase 3: 密度マップ（rayon並列 - integralは読み取り専用）
    let radius: i32 = 15;
    let density_and_max: Vec<(f32, f32)> = (0..h)
        .into_par_iter()
        .map(|y| {
            let mut row_max = 0f32;
            let row: Vec<f32> = (0..w).map(|x| {
                let x1 = (x as i32 - radius).max(0) as usize;
                let y1 = (y as i32 - radius).max(0) as usize;
                let x2 = ((x as i32 + radius) as usize).min(w - 1);
                let y2 = ((y as i32 + radius) as usize).min(h - 1);
                let area = ((x2 - x1 + 1) * (y2 - y1 + 1)) as f32;
                let sum = integral[(y2 + 1) * iw + (x2 + 1)]
                    - integral[y1 * iw + (x2 + 1)]
                    - integral[(y2 + 1) * iw + x1]
                    + integral[y1 * iw + x1];
                let d = sum / area;
                if d > row_max { row_max = d; }
                d
            }).collect();
            // rowとrow_maxをタプルで返す（後でflatten）
            row.into_iter().map(move |d| (d, row_max)).collect::<Vec<_>>()
        })
        .flatten()
        .collect();

    // maxDensityを求める
    let max_density = density_and_max.iter().map(|(_, m)| *m).fold(0f32, f32::max);

    // Phase 4: ヒートマップ着色 + 高密度ピクセル収集（rayon並列）
    let density_threshold = 0.05f32;
    let rows: Vec<(Vec<u8>, u32, Vec<DiffPixel>)> = (0..h)
        .into_par_iter()
        .map(|y| {
            let row_size = w * 4;
            let mut row_buf = vec![0u8; row_size];
            let mut high_count = 0u32;
            let mut high_pixels = Vec::new();

            for x in 0..w {
                let pixel_idx = y * w + x;
                let di = x * 4;
                let (density, _) = density_and_max[pixel_idx];
                let normalized = if max_density > 0.0 { density / max_density } else { 0.0 };

                if diff_mask[pixel_idx] == 1 && density > density_threshold {
                    let (r, g, b) = if normalized < 0.3 {
                        (0u8, (normalized / 0.3 * 200.0) as u8, 200u8)
                    } else if normalized < 0.6 {
                        let t = (normalized - 0.3) / 0.3;
                        ((t * 255.0) as u8, (200.0 + t * 55.0) as u8, ((1.0 - t) * 200.0) as u8)
                    } else {
                        let t = (normalized - 0.6) / 0.4;
                        high_count += 1;
                        high_pixels.push(DiffPixel { x: x as u32, y: y as u32 });
                        (255u8, ((1.0 - t) * 255.0) as u8, 0u8)
                    };
                    row_buf[di] = r;
                    row_buf[di + 1] = g;
                    row_buf[di + 2] = b;
                    row_buf[di + 3] = 255;
                } else {
                    // 黒背景
                    row_buf[di + 3] = 255;
                }
            }
            (row_buf, high_count, high_pixels)
        })
        .collect();

    let total_size = w * h * 4;
    let mut heatmap_buf = vec![0u8; total_size];
    let mut total_high = 0u32;
    let mut all_high_pixels = Vec::new();

    for (y, (row_buf, count, pixels)) in rows.into_iter().enumerate() {
        let offset = y * w * 4;
        heatmap_buf[offset..offset + w * 4].copy_from_slice(&row_buf);
        total_high += count;
        all_high_pixels.extend(pixels);
    }

    (heatmap_buf, total_high, all_high_pixels)
}

// Union-Findクラスタリング → DiffMarkerリスト
fn cluster_markers(
    pixels: &[DiffPixel], grid_size: u32, min_cluster: u32, min_radius: f64,
) -> Vec<DiffMarker> {
    if pixels.is_empty() {
        return Vec::new();
    }

    // グリッドにピクセルを分配
    struct GridCell {
        gx: i32,
        gy: i32,
        count: u32,
        min_x: u32,
        max_x: u32,
        min_y: u32,
        max_y: u32,
    }

    let mut grid: HashMap<(i32, i32), GridCell> = HashMap::new();
    for p in pixels {
        let gx = (p.x / grid_size) as i32;
        let gy = (p.y / grid_size) as i32;
        let cell = grid.entry((gx, gy)).or_insert(GridCell {
            gx, gy, count: 0, min_x: p.x, max_x: p.x, min_y: p.y, max_y: p.y,
        });
        cell.count += 1;
        cell.min_x = cell.min_x.min(p.x);
        cell.max_x = cell.max_x.max(p.x);
        cell.min_y = cell.min_y.min(p.y);
        cell.max_y = cell.max_y.max(p.y);
    }

    let cells: Vec<GridCell> = grid.into_values().collect();
    if cells.is_empty() {
        return Vec::new();
    }

    // Union-Find
    let mut parent: Vec<usize> = (0..cells.len()).collect();
    let find = |parent: &mut Vec<usize>, mut i: usize| -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    };

    for i in 0..cells.len() {
        for j in (i + 1)..cells.len() {
            let dx = (cells[i].gx - cells[j].gx).abs();
            let dy = (cells[i].gy - cells[j].gy).abs();
            if dx <= 1 && dy <= 1 {
                let pi = find(&mut parent, i);
                let pj = find(&mut parent, j);
                if pi != pj {
                    parent[pi] = pj;
                }
            }
        }
    }

    // グループ集約
    let mut groups: HashMap<usize, (u32, u32, u32, u32, u32)> = HashMap::new(); // minX, maxX, minY, maxY, count
    for (i, cell) in cells.iter().enumerate() {
        let root = find(&mut parent, i);
        let g = groups.entry(root).or_insert((u32::MAX, 0, u32::MAX, 0, 0));
        g.0 = g.0.min(cell.min_x);
        g.1 = g.1.max(cell.max_x);
        g.2 = g.2.min(cell.min_y);
        g.3 = g.3.max(cell.max_y);
        g.4 += cell.count;
    }

    let mut markers: Vec<DiffMarker> = groups.values()
        .filter(|g| g.4 >= min_cluster)
        .map(|g| {
            let cx = (g.0 as f64 + g.1 as f64) / 2.0;
            let cy = (g.2 as f64 + g.3 as f64) / 2.0;
            let radius_x = (g.1 as f64 - g.0 as f64) / 2.0 + if min_radius > 200.0 { 100.0 } else { 60.0 };
            let radius_y = (g.3 as f64 - g.2 as f64) / 2.0 + if min_radius > 200.0 { 100.0 } else { 60.0 };
            let marker_radius = min_radius.max(radius_x.max(radius_y));
            DiffMarker { x: cx, y: cy, radius: marker_radius, count: g.4 }
        })
        .collect();

    markers.sort_by(|a, b| b.count.cmp(&a.count));
    markers
}

// tiff-tiff / psd-psd 用の差分計算
#[tauri::command]
fn compute_diff_simple(
    path_a: String, path_b: String, threshold: u8,
) -> Result<DiffSimpleResult, String> {
    // 2ファイル並列デコード
    let (img_a, img_b) = rayon::join(
        || decode_image_file(&path_a),
        || decode_image_file(&path_b),
    );
    let img_a = img_a?;
    let img_b = img_b?;

    let (wa, ha) = img_a.dimensions();
    let (wb, hb) = img_b.dimensions();
    let width = wa.max(wb);
    let height = ha.max(hb);

    // 必要ならリサイズ
    let img_a = if wa != width || ha != height {
        img_a.resize_exact(width, height, FilterType::Triangle)
    } else {
        img_a
    };
    let img_b = if wb != width || hb != height {
        img_b.resize_exact(width, height, FilterType::Triangle)
    } else {
        img_b
    };

    let rgba_a = img_a.to_rgba8();
    let rgba_b = img_b.to_rgba8();

    // 差分計算
    let (diff_buf, diff_count, diff_pixels) =
        diff_simple_core(rgba_a.as_raw(), rgba_b.as_raw(), width, height, threshold);

    // マーカークラスタリング
    let markers = cluster_markers(&diff_pixels, 200, 1, 300.0);

    // 3画像を並列エンコード
    let (src_a_result, (src_b_result, diff_result)) = rayon::join(
        || encode_to_data_url(&img_a),
        || rayon::join(
            || encode_to_data_url(&img_b),
            || encode_rgba_to_data_url(&diff_buf, width, height),
        ),
    );

    Ok(DiffSimpleResult {
        src_a: src_a_result?,
        src_b: src_b_result?,
        diff_src: diff_result?,
        has_diff: diff_count > 0,
        diff_count,
        markers,
        image_width: width,
        image_height: height,
    })
}

// psd-tiff 用のヒートマップ差分計算
#[tauri::command]
fn compute_diff_heatmap(
    psd_path: String, tiff_path: String, crop_bounds: CropBounds, threshold: u8,
) -> Result<DiffHeatmapResult, String> {
    // 並列デコード
    let (psd_result, tiff_result) = rayon::join(
        || decode_psd_to_image(&psd_path),
        || image::open(&tiff_path).map_err(|e| format!("Failed to open TIFF: {}", e)),
    );
    let psd_img = psd_result?;
    let tiff_img = tiff_result?;

    let (tiff_w, tiff_h) = tiff_img.dimensions();

    // PSDをクロップ
    let crop_w = crop_bounds.right - crop_bounds.left;
    let crop_h = crop_bounds.bottom - crop_bounds.top;
    let cropped = psd_img.crop_imm(crop_bounds.left, crop_bounds.top, crop_w, crop_h);

    // TIFFサイズにリサイズ（Nearest = imageSmoothingEnabled=false 相当）
    let processed_psd = cropped.resize_exact(tiff_w, tiff_h, FilterType::Nearest);

    let rgba_a = processed_psd.to_rgba8();
    let rgba_b = tiff_img.to_rgba8();

    // ヒートマップ差分計算
    let (heatmap_buf, high_density_count, high_pixels) =
        diff_heatmap_core(rgba_a.as_raw(), rgba_b.as_raw(), tiff_w, tiff_h, threshold);

    // マーカークラスタリング (gridSize=250, minCluster=20, minRadius=80)
    let markers = cluster_markers(&high_pixels, 250, 20, 80.0);

    // diffProbability計算
    let diff_probability = if high_density_count > 0 {
        let total_pixels = (tiff_w as f64) * (tiff_h as f64);
        let base_prob = 70.0;
        let additional = (high_density_count as f64 / total_pixels * 50000.0).min(30.0);
        ((base_prob + additional) * 10.0).round() / 10.0
    } else {
        0.0
    };

    // 4画像を並列エンコード
    let ((src_a_result, src_b_result), (processed_a_result, diff_result)) = rayon::join(
        || rayon::join(
            || encode_to_data_url(&psd_img),
            || encode_to_data_url(&tiff_img),
        ),
        || rayon::join(
            || encode_to_data_url(&processed_psd),
            || encode_rgba_to_data_url(&heatmap_buf, tiff_w, tiff_h),
        ),
    );

    Ok(DiffHeatmapResult {
        src_a: src_a_result?,
        src_b: src_b_result?,
        processed_a: processed_a_result?,
        diff_src: diff_result?,
        has_diff: high_density_count > 0,
        diff_probability,
        high_density_count,
        markers,
        image_width: tiff_w,
        image_height: tiff_h,
    })
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            image_cache: Mutex::new(ImageCache::new(100)), // 最大100件キャッシュ
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            parse_psd,
            open_file_with_default_app,
            save_screenshot,
            open_folder,
            decode_and_resize_image,
            preload_images,
            clear_image_cache,
            list_files_in_folder,
            open_pdf_in_mojiq,
            compute_diff_simple,
            compute_diff_heatmap
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
