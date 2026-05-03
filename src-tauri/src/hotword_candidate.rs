//! (v0.8.4 P1-2) 词汇检测 + 建议加词典 —— 跟 Mac HotwordCandidateLog 同源。
//!
//! 后台扫每次转写文本，对**英文 token**（ASCII 字母 + 数字 ≥3 字符）做候选。
//! 出现 ≥3 次 → 升级 ready，DictionaryTab 顶部 banner 提示加进字典。
//! 中文分词 v0.8.4 不做（复杂度高且噪音大）；中文术语用户手动加词典。
//!
//! 落盘：`%APPDATA%/TiTiTalk/hotword-candidates.json`
//! 简单 HashMap<String, u32> 即可，重启从 disk 读回，stop words + user dict
//! 现场过滤。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

pub const PROMOTION_THRESHOLD: u32 = 3;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CandidateStore {
    pub counters: HashMap<String, u32>,
}

static STORE: once_cell::sync::Lazy<Arc<Mutex<CandidateStore>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(load_from_disk())));

/// 入口：转写完后调（不阻塞主链路）。enabled=false 直接返回。
pub fn observe(text: &str, current_dictionary: &[String], enabled: bool) {
    if !enabled {
        return;
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }
    let dict: std::collections::HashSet<String> = current_dictionary
        .iter()
        .map(|w| w.to_lowercase())
        .collect();

    let mut g = STORE.lock();
    for tok in extract_tokens(trimmed) {
        let lower = tok.to_lowercase();
        if STOP_WORDS.contains(&lower.as_str()) {
            continue;
        }
        if dict.contains(&lower) {
            continue;
        }
        *g.counters.entry(tok).or_insert(0) += 1;
    }
    let snapshot = g.clone();
    drop(g);
    let _ = save_to_disk(&snapshot);
}

/// 给前端读：返回 ready 候选（≥ threshold + 不在 dict）按计数倒序。
pub fn ready_candidates(current_dictionary: &[String]) -> Vec<(String, u32)> {
    let dict: std::collections::HashSet<String> = current_dictionary
        .iter()
        .map(|w| w.to_lowercase())
        .collect();
    let g = STORE.lock();
    let mut out: Vec<(String, u32)> = g
        .counters
        .iter()
        .filter(|(k, v)| **v >= PROMOTION_THRESHOLD && !dict.contains(&k.to_lowercase()))
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out
}

pub fn dismiss(token: &str) {
    let mut g = STORE.lock();
    g.counters.remove(token);
    let snapshot = g.clone();
    drop(g);
    let _ = save_to_disk(&snapshot);
}

pub fn clear_all() {
    let mut g = STORE.lock();
    g.counters.clear();
    let snapshot = g.clone();
    drop(g);
    let _ = save_to_disk(&snapshot);
}

fn extract_tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for c in text.chars() {
        let is_alnum = c.is_ascii_alphanumeric();
        if is_alnum {
            current.push(c);
        } else {
            if current.len() >= 3 && current.chars().next().map(|x| x.is_ascii_alphabetic()) == Some(true) {
                out.push(current.clone());
            }
            current.clear();
        }
    }
    if current.len() >= 3 && current.chars().next().map(|x| x.is_ascii_alphabetic()) == Some(true) {
        out.push(current);
    }
    out
}

fn store_path() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("TiTiTalk");
    let _ = std::fs::create_dir_all(&p);
    p.push("hotword-candidates.json");
    p
}

fn load_from_disk() -> CandidateStore {
    let p = store_path();
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => CandidateStore::default(),
    }
}

fn save_to_disk(store: &CandidateStore) -> std::io::Result<()> {
    let p = store_path();
    let s = serde_json::to_string_pretty(store).unwrap_or_else(|_| "{}".into());
    std::fs::write(p, s)
}

/// 跟 Mac 端 stop words 对齐（最高频英文虚词 + 几个 fillers）。
const STOP_WORDS: &[&str] = &[
    "the","and","that","you","for","are","with","but","this","have","not",
    "they","from","one","all","was","when","were","what","your","how","its",
    "out","can","into","just","like","there","then","than","them","also",
    "very","much","more","most","some","other","such","over","off","get",
    "got","had","has","his","her","him","she","who","why","yes","yeah",
    "okay","ok","right","sure","well","now","here","because","about","would",
    "could","should","will","still","really","actually","probably","maybe",
    "kind","sort","stuff","thing","things","quite","ever","again","always",
    "going","been","make","made","makes","take","taken","done","does","didnt",
    "isnt","wasnt","arent","wont","cant","dont","doesnt","ive","youre","youll",
    "weve","theyre","theyll","ill","hes","shes",
];
