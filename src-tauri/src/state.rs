use std::sync::Arc;

use parking_lot::RwLock;
use serde::Serialize;
use tokio::sync::mpsc::UnboundedSender;

use crate::audio::CapturedAudio;
use crate::config::{load_config, save_config, AppConfig};

/// Where in the record→ASR→(polish→)insert pipeline we currently are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PipelinePhase {
    Idle,
    Recording,
    Stopping,
    Transcribing,
    Polishing,
    Inserting,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PipelineEvent {
    Phase { phase: PipelinePhase },
    Level { rms: f32 },
    Transcript { text: String },
    Error { message: String },
}

/// Mutable global app state. Cheap to clone (`Arc`).
pub struct AppState {
    pub config: RwLock<AppConfig>,
    pub event_tx: UnboundedSender<PipelineEvent>,
    pub current_audio: RwLock<Option<CapturedAudio>>,
    pub phase: RwLock<PipelinePhase>,
}

impl AppState {
    pub fn new(event_tx: UnboundedSender<PipelineEvent>) -> Self {
        Self {
            config: RwLock::new(load_config()),
            event_tx,
            current_audio: RwLock::new(None),
            phase: RwLock::new(PipelinePhase::Idle),
        }
    }

    pub fn replace_config(self: &Arc<Self>, new_config: AppConfig) -> anyhow::Result<()> {
        save_config(&new_config)?;
        *self.config.write() = new_config;
        Ok(())
    }

    pub fn emit(&self, ev: PipelineEvent) {
        let _ = self.event_tx.send(ev);
    }

    pub fn set_phase(&self, phase: PipelinePhase) {
        *self.phase.write() = phase;
        self.emit(PipelineEvent::Phase { phase });
    }

    pub fn current_phase(&self) -> PipelinePhase {
        *self.phase.read()
    }

    /// Driven by Tauri commands or hotkey thread to request a transition.
    /// Actual pipeline orchestration lives in `audio::orchestrate`.
    pub fn request_phase(self: &Arc<Self>, phase: PipelinePhase) {
        match (self.current_phase(), phase) {
            (PipelinePhase::Idle, PipelinePhase::Recording)
            | (PipelinePhase::Done, PipelinePhase::Recording)
            | (PipelinePhase::Failed, PipelinePhase::Recording) => {
                let s = self.clone();
                tauri::async_runtime::spawn(async move {
                    crate::audio::orchestrate_start(s).await;
                });
            }
            (PipelinePhase::Recording, PipelinePhase::Stopping) => {
                let s = self.clone();
                tauri::async_runtime::spawn(async move {
                    crate::audio::orchestrate_stop(s).await;
                });
            }
            _ => {
                log::debug!(
                    "phase request ignored: {:?} → {:?}",
                    self.current_phase(),
                    phase
                );
            }
        }
    }
}
