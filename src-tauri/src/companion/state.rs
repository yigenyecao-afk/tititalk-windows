//! Mood + Facing 状态机。Mac PetCompanion.swift 的 Win 等价。
//!
//! 4 mood:
//!   • wandering  — 屏幕底部巡游（30fps 推 X 位置；前端切 row 1/2 left/right run）
//!   • stationary — 站定不动（pill 显示中、用户拖动后；前端按 phase 切 row）
//!   • wave       — 一次性招手（点击宠物触发；700ms 后回 baseline）
//!   • jump       — 一次性跳（840ms 后回；当前未自发触发，留着以后调味）
//!
//! Mac 用 GCD asyncAfter + UUID token 比对实现 transient 自动复位；
//! Win 这边 tokio::spawn + AtomicU64 token 对齐效果（spawn 触发的 task 复位前
//! 检查 token 是否还是自己排的，否则放弃）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::RwLock;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mood {
    Wandering,
    Stationary,
    Wave,
    /// 当前后端没自发触发；保留接口跟前端 PetView mapState 对齐
    /// （后续若加录音开始 200ms 反应可直接 trigger(Mood::Jump)）。
    #[allow(dead_code)]
    Jump,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Facing {
    Left,
    Right,
}

/// 同 Mac PetCompanion —— mood + facing + 用户意图 + transient reset token。
///
/// Arc 包是因为 30fps wander tick + pipeline event hook + 用户交互
/// 三条 task 都要并发读写它。RwLock 颗粒度够（mood/facing 都是 enum，
/// clone 极廉价；transient token 用 AtomicU64 避免锁）。
pub struct CompanionState {
    pub mood: RwLock<Mood>,
    pub facing: RwLock<Facing>,
    /// 双击 toggle 巡游意图。pill 显示中临时强制 stationary，pill 消失
    /// 后恢复到这个意图。
    pub user_wants_wandering: RwLock<bool>,
    /// transient (wave/jump) 自动复位 token —— spawn 出去的 task 复位
    /// 前 load 比对，token 已被新动作 bump 了就放弃复位。
    reset_token: AtomicU64,
}

impl CompanionState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            mood: RwLock::new(Mood::Stationary),
            facing: RwLock::new(Facing::Right),
            user_wants_wandering: RwLock::new(false),
            reset_token: AtomicU64::new(0),
        })
    }

    pub fn mood(&self) -> Mood {
        *self.mood.read()
    }

    pub fn facing(&self) -> Facing {
        *self.facing.read()
    }

    /// 直接设 mood（wandering/stationary）。会取消尚未触发完的 transient。
    pub fn set(self: &Arc<Self>, next: Mood) {
        if !matches!(next, Mood::Wandering | Mood::Stationary) {
            return;
        }
        // bump token 让 in-flight transient 复位 task 失效
        self.reset_token.fetch_add(1, Ordering::SeqCst);
        let mut cur = self.mood.write();
        if *cur != next {
            *cur = next;
        }
    }

    pub fn flip_facing(self: &Arc<Self>) {
        let mut f = self.facing.write();
        *f = match *f {
            Facing::Left => Facing::Right,
            Facing::Right => Facing::Left,
        };
    }

    /// 触发 transient（wave/jump），duration 后自动回 fallback。
    /// Mac 用 GCD；这里 tokio::spawn + AtomicU64 token 比对 ——
    /// 比 Task::sleep 准时（v0.x 时期 Task::sleep 在 main actor 拥塞下会被推迟数秒，
    /// Mac 那边踩过坑改成 GCD；Win tokio runtime 默认多线程不存在那个 actor 拥塞，
    /// 但仍走 token guard 防重叠 transient 把状态搞乱）。
    pub fn trigger(self: &Arc<Self>, transient: Mood, duration: Duration, fallback: Mood) {
        if !matches!(transient, Mood::Wave | Mood::Jump) {
            return;
        }
        let token = self.reset_token.fetch_add(1, Ordering::SeqCst) + 1;
        {
            let mut cur = self.mood.write();
            *cur = transient;
        }
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(duration).await;
            // 比对 token；中间被 set() 或 trigger() 改过就放弃复位
            if me.reset_token.load(Ordering::SeqCst) != token {
                return;
            }
            let mut cur = me.mood.write();
            if matches!(*cur, Mood::Wave | Mood::Jump) {
                *cur = fallback;
            }
        });
    }
}

/// Snapshot 给前端 emit 用——零拷贝 mood/facing。
#[derive(Debug, Clone, Serialize)]
pub struct CompanionSnapshot {
    pub mood: Mood,
    pub facing: Facing,
}

impl CompanionState {
    pub fn snapshot(&self) -> CompanionSnapshot {
        CompanionSnapshot {
            mood: *self.mood.read(),
            facing: *self.facing.read(),
        }
    }
}
