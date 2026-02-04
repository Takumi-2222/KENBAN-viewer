use base64::{engine::general_purpose::STANDARD, Engine};
use image::{ImageBuffer, Rgba, DynamicImage, GenericImageView};
use image::imageops::FilterType;
use psd::Psd;
use rayon::prelude::*;
use serde::Serialize;
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

    // ページ番号が指定されている場合は引数として追加
    // 注意: --page とページ番号をPDFパスより前に配置
    // （MojiQ/Electronが自動追加するオプションの影響を避けるため）
    if let Some(p) = page {
        cmd.arg("--page");
        cmd.arg(p.to_string());
    }

    // PDFパスは最後に追加
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

    let resized = if scale < 1.0 {
        img.resize(new_w, new_h, FilterType::Lanczos3)
    } else {
        img.clone()
    };

    // PNGエンコード
    let mut png_data = Cursor::new(Vec::new());
    resized.write_to(&mut png_data, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode PNG: {}", e))?;

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

    // キャッシュに保存
    {
        let mut cache = state.image_cache.lock().map_err(|e| e.to_string())?;
        cache.insert(cache_key, CachedImage {
            data: png_data.clone(),
            width: new_w,
            height: new_h,
        });
    }

    // Base64エンコードして返す
    let base64_str = STANDARD.encode(&png_data);
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
            open_pdf_in_mojiq
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
