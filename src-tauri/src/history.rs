//! 转写历史持久化（JSONL · append-only）。
//!
//! 设计取舍：
//!   • JSONL（一行一条 JSON）而非 SQLite —— 体量小、append 廉价、人类可读、
//!     损坏只丢一行而非整库；缺点是 cleanup 要全文重写。预估 50 字/行 ×
//!     30 天 × 100 条/天 = 150KB/月，重写代价可忽略。
//!   • 文件路径走 dirs::config_dir()（跟 config.json 同目录），不另起 data
//!     目录 —— 卸载时一处清。
//!   • 不存音频（spec 要求 raw audio 不留盘）；只存文本 + 时间戳 + 引擎/模型
//!     标签便于事后排查谁出的活儿。
//!   • Cleanup 是 best-effort：失败只 log，不打断 pipeline。

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryItem {
    pub at: DateTime<Utc>,
    pub text: String,
    /// "tititalk_cloud" / "qwen" / "openai" —— 排查 BYOK vs 平台问题用。
    #[serde(default)]
    pub engine: String,
    /// ASR 模型，可选；老条目可能没有。
    #[serde(default)]
    pub model: Option<String>,
}

pub fn history_path() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("TiTiTalk");
    let _ = fs::create_dir_all(&p);
    p.push("history.jsonl");
    p
}

pub fn append(item: &HistoryItem) {
    let path = history_path();
    let line = match serde_json::to_string(item) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("history serialize failed: {e}");
            return;
        }
    };
    let mut f = match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(f) => f,
        Err(e) => {
            log::warn!("history open failed: {e}");
            return;
        }
    };
    if let Err(e) = writeln!(f, "{line}") {
        log::warn!("history write failed: {e}");
    }
}

/// 返回最近 `limit` 条（按时间倒序，最新在前）。
/// 简单全文加载 —— 30 天 ~3000 行的量级，O(n) 没问题；真要超大可以改 mmap
/// 倒序读，目前用不上。
pub fn load_recent(limit: usize) -> Vec<HistoryItem> {
    let path = history_path();
    let f = match fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return vec![],
    };
    let mut items: Vec<HistoryItem> = BufReader::new(f)
        .lines()
        .map_while(Result::ok)
        .filter_map(|l| {
            if l.trim().is_empty() {
                None
            } else {
                serde_json::from_str(&l).ok()
            }
        })
        .collect();
    items.sort_by(|a, b| b.at.cmp(&a.at));
    items.truncate(limit);
    items
}

/// 删除超过 `retention_days` 天的条目（best-effort 重写）。
/// `retention_days = 0` 等于禁用 cleanup（直接 return）。
pub fn cleanup(retention_days: u32) {
    if retention_days == 0 {
        return;
    }
    let path = history_path();
    let f = match fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return,
    };
    let cutoff = Utc::now() - chrono::Duration::days(retention_days as i64);
    let kept: Vec<String> = BufReader::new(f)
        .lines()
        .map_while(Result::ok)
        .filter(|l| {
            if l.trim().is_empty() {
                return false;
            }
            // 解析失败的行（坏数据）一并丢弃 —— 反正 cleanup 也是清理动作。
            match serde_json::from_str::<HistoryItem>(l) {
                Ok(item) => item.at >= cutoff,
                Err(_) => false,
            }
        })
        .collect();
    // 原子写：先写 .tmp 再 rename，掉电不会损坏老文件。
    let tmp = path.with_extension("jsonl.tmp");
    let mut out = match fs::File::create(&tmp) {
        Ok(f) => f,
        Err(e) => {
            log::warn!("history cleanup tmp create failed: {e}");
            return;
        }
    };
    for line in &kept {
        if writeln!(out, "{line}").is_err() {
            log::warn!("history cleanup tmp write failed");
            return;
        }
    }
    drop(out);
    if let Err(e) = fs::rename(&tmp, &path) {
        log::warn!("history cleanup rename failed: {e}");
    } else {
        log::info!("history cleanup ok: kept {} entries (cutoff {})", kept.len(), cutoff);
    }
}

pub fn clear_all() -> std::io::Result<()> {
    let path = history_path();
    if path.exists() {
        fs::remove_file(&path)?;
    }
    Ok(())
}
