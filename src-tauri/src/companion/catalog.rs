//! 宠物 catalog 扫描。Mac PetCatalog.swift 的 Win 等价。
//!
//! 两路扫合并：
//!   1. bundle 内置 — `<resource_dir>/pets/<slug>/`，含 5 只
//!      (boba / byte-bunny / pixel-panda / lulu-capybara / aka-shiba)。
//!   2. 用户安装 — `~/.codex/pets/<slug>/`（npx petdex install ...）。
//!
//! 同 slug 时用户安装版优先（用户更新过的 sheet 压过 bundled）。

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// 给前端 picker 用——slug + displayName + 资源 URL。
///
/// `spritesheet_url` 用 Tauri `convertFileSrc` 等价的 asset:// URL 让 webview
/// 加载本地文件；前端 background-image 设到这个 URL 即可，无需 fs 权限。
#[derive(Debug, Clone, Serialize)]
pub struct PetEntry {
    pub slug: String,
    pub display_name: String,
    pub description: Option<String>,
    /// 绝对路径——前端拿到后 `convertFileSrc` 转 asset URL 用。
    pub spritesheet_path: String,
    pub is_bundled: bool,
}

#[derive(Debug, serde::Deserialize)]
struct PetManifest {
    #[allow(dead_code)]
    id: Option<String>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    description: Option<String>,
    #[serde(rename = "spritesheetPath")]
    spritesheet_path: Option<String>,
}

pub fn discover(handle: &AppHandle) -> Vec<PetEntry> {
    let mut by_slug: std::collections::BTreeMap<String, PetEntry> = std::collections::BTreeMap::new();

    for entry in scan_bundled(handle) {
        by_slug.insert(entry.slug.clone(), entry);
    }
    for entry in scan_user_installed() {
        // 用户安装版覆盖 bundled
        by_slug.insert(entry.slug.clone(), entry);
    }

    by_slug.into_values().collect()
}

fn scan_bundled(handle: &AppHandle) -> Vec<PetEntry> {
    // prod: <resource_dir>/pets/  (bundle.resources 把 src-tauri/pets/** 展平到这里)
    // dev:  fallback to CARGO_MANIFEST_DIR/pets/（debug build 资源不展平）
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(p) = handle
        .path()
        .resolve("pets", tauri::path::BaseDirectory::Resource)
    {
        roots.push(p);
    }
    // 跟 asr_local.rs 对齐：dev 模式 resource_dir 指向 src-tauri/，
    // 加 fallback 到 src-tauri/pets/（debug 时存在）
    #[cfg(debug_assertions)]
    {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pets");
        roots.push(manifest);
    }

    let mut found: Vec<PetEntry> = Vec::new();
    let mut seen_slugs: std::collections::HashSet<String> = std::collections::HashSet::new();
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        for e in scan(&root, true) {
            if seen_slugs.insert(e.slug.clone()) {
                found.push(e);
            }
        }
    }
    found
}

fn scan_user_installed() -> Vec<PetEntry> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let pets = home.join(".codex").join("pets");
    if !pets.is_dir() {
        return Vec::new();
    }
    scan(&pets, false)
}

fn scan(parent: &Path, is_bundled: bool) -> Vec<PetEntry> {
    let Ok(read) = std::fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for ent in read.flatten() {
        let dir = ent.path();
        if !dir.is_dir() {
            continue;
        }
        let manifest_path = dir.join("pet.json");
        if !manifest_path.is_file() {
            continue;
        }
        let raw = match std::fs::read_to_string(&manifest_path) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("companion: read {}: {e}", manifest_path.display());
                continue;
            }
        };
        let manifest: PetManifest = match serde_json::from_str(&raw) {
            Ok(m) => m,
            Err(e) => {
                log::warn!("companion: parse {}: {e}", manifest_path.display());
                continue;
            }
        };
        let slug = dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if slug.is_empty() {
            continue;
        }
        let sheet_rel = manifest
            .spritesheet_path
            .clone()
            .unwrap_or_else(|| "spritesheet.webp".to_string());
        let candidates = [
            dir.join(&sheet_rel),
            dir.join("spritesheet.webp"),
            dir.join("spritesheet.png"),
        ];
        let Some(sheet) = candidates.iter().find(|p| p.is_file()).cloned() else {
            log::warn!("companion: pet {slug} 缺 spritesheet（{sheet_rel}）");
            continue;
        };
        let display_name = manifest
            .display_name
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| slug.clone());
        out.push(PetEntry {
            slug,
            display_name,
            description: manifest.description,
            spritesheet_path: sheet.to_string_lossy().into_owned(),
            is_bundled,
        });
    }
    // 按 displayName 排序（跟 Mac PetCatalog 一致）
    out.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    out
}
