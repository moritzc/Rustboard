#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pdf;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use serde::Deserialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Manager, State};

/// Large binary payloads (e.g. original PDFs for round-trip export) are staged
/// here first via a raw IPC body, then referenced by id from JSON commands.
#[derive(Default)]
struct Blobs {
    next: AtomicU32,
    map: Mutex<HashMap<u32, Vec<u8>>>,
}

fn raw_body(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(data) => Ok(data.clone()),
        _ => Err("expected a raw binary body".into()),
    }
}

fn header(request: &Request<'_>, name: &str) -> Result<String, String> {
    let v = request
        .headers()
        .get(name)
        .ok_or_else(|| format!("missing header {name}"))?
        .to_str()
        .map_err(|e| e.to_string())?;
    Ok(percent_decode(v))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
async fn read_file(path: String) -> Result<Response, String> {
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("Could not read {path}: {e}"))
}

#[tauri::command]
async fn write_file(request: Request<'_>) -> Result<(), String> {
    let path = header(&request, "x-path")?;
    let data = raw_body(&request)?;
    write_atomic(&path, &data)
}

fn write_atomic(path: &str, data: &[u8]) -> Result<(), String> {
    let p = std::path::Path::new(path);
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = p.with_extension("rbtmp");
    std::fs::write(&tmp, data).map_err(|e| format!("Could not write {path}: {e}"))?;
    std::fs::rename(&tmp, p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Could not write {path}: {e}")
    })
}

#[tauri::command]
async fn delete_file(path: String) -> Result<(), String> {
    if std::path::Path::new(&path).exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
fn recovery_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("recovery");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn get_startup_file() -> Option<String> {
    std::env::args().skip(1).find(|a| {
        let l = a.to_lowercase();
        (l.ends_with(".rboard") || l.ends_with(".pdf")) && std::path::Path::new(a).exists()
    })
}

#[tauri::command]
async fn stage_blob(request: Request<'_>, blobs: State<'_, Blobs>) -> Result<u32, String> {
    let data = raw_body(&request)?;
    let id = blobs.next.fetch_add(1, Ordering::SeqCst) + 1;
    blobs.map.lock().unwrap().insert(id, data);
    Ok(id)
}

#[derive(Deserialize)]
struct SvgPage {
    svg: String,
    width: f32,
    height: f32,
}

#[tauri::command]
async fn export_pdf(pages: Vec<SvgPage>, path: String) -> Result<(), String> {
    let pages: Vec<(String, f32, f32)> = pages
        .into_iter()
        .map(|p| (p.svg, p.width, p.height))
        .collect();
    let bytes = tauri::async_runtime::spawn_blocking(move || pdf::build_pdf(&pages))
        .await
        .map_err(|e| e.to_string())??;
    write_atomic(&path, &bytes)
}

#[derive(Deserialize)]
struct Overlay {
    page: usize,
    svg: String,
}

#[tauri::command]
async fn export_annotated_pdf(
    blob: u32,
    overlays: Vec<Overlay>,
    path: String,
    blobs: State<'_, Blobs>,
) -> Result<(), String> {
    let original = blobs
        .map
        .lock()
        .unwrap()
        .remove(&blob)
        .ok_or("original PDF not staged")?;
    let overlays: Vec<(usize, String)> = overlays.into_iter().map(|o| (o.page, o.svg)).collect();
    let bytes =
        tauri::async_runtime::spawn_blocking(move || pdf::annotate_pdf(&original, &overlays))
            .await
            .map_err(|e| e.to_string())??;
    write_atomic(&path, &bytes)
}

#[tauri::command]
async fn clipboard_read_image() -> Result<Response, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let img = match cb.get_image() {
        Ok(img) => img,
        Err(_) => return Ok(Response::new(Vec::new())),
    };
    let buf =
        image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.into_owned())
            .ok_or("invalid clipboard image")?;
    let mut out = std::io::Cursor::new(Vec::new());
    buf.write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(Response::new(out.into_inner()))
}

#[tauri::command]
async fn clipboard_read_files() -> Result<Vec<String>, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    match cb.get().file_list() {
        Ok(files) => Ok(files
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect()),
        Err(_) => Ok(Vec::new()),
    }
}

#[tauri::command]
async fn clipboard_write_image(request: Request<'_>) -> Result<(), String> {
    let data = raw_body(&request)?;
    let img = image::load_from_memory(&data)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let (w, h) = img.dimensions();
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_image(arboard::ImageData {
        width: w as usize,
        height: h as usize,
        bytes: std::borrow::Cow::Owned(img.into_raw()),
    })
    .map_err(|e| e.to_string())
}

/// Download an image that was dragged in from a browser (WebView fetch would hit CORS).
#[tauri::command]
async fn fetch_url(url: String) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Response, String> {
        let tls = native_tls::TlsConnector::new().map_err(|e| e.to_string())?;
        let agent = ureq::AgentBuilder::new()
            .tls_connector(std::sync::Arc::new(tls))
            .timeout(std::time::Duration::from_secs(30))
            .build();
        let resp = agent.get(&url).call().map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        use std::io::Read;
        resp.into_reader()
            .take(200 * 1024 * 1024)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        Ok(Response::new(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn main() {
    if std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_err() {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--enable-gpu-rasterization --enable-zero-copy",
        );
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Blobs::default())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            delete_file,
            file_exists,
            recovery_dir,
            get_startup_file,
            stage_blob,
            export_pdf,
            export_annotated_pdf,
            clipboard_read_image,
            clipboard_read_files,
            clipboard_write_image,
            fetch_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rustboard");
}
