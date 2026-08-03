//! Cancel flag + progress payload, mirroring `catalog_job`.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub const MODULES_CANCELLED: &str = "cancelado";

static MODULES_CANCEL: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));

pub fn reset_cancel() {
    MODULES_CANCEL.store(false, Ordering::SeqCst);
}

pub fn request_cancel() {
    MODULES_CANCEL.store(true, Ordering::SeqCst);
}

pub fn is_cancelled() -> bool {
    MODULES_CANCEL.load(Ordering::SeqCst)
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ModulesUpdateProgress {
    /// probe|list|metadata|migrate|archive|download|delete|persist|registry|done
    pub phase: String,
    /// "" | "zip" | "raw"
    pub transport: String,
    pub files_done: usize,
    pub files_total: usize,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub current: String,
    pub failed: usize,
    pub message: String,
}

pub type ProgressSink<'a> = &'a (dyn Fn(ModulesUpdateProgress) + Send + Sync);

/// Coalesces emissions so ~600 files do not flood the webview. Phase changes
/// and the terminal `done` always get through.
pub struct Emitter<'a> {
    sink: Option<ProgressSink<'a>>,
    last: Mutex<(Instant, String)>,
    min_gap: Duration,
}

impl<'a> Emitter<'a> {
    pub fn new(sink: Option<ProgressSink<'a>>) -> Self {
        Self {
            sink,
            last: Mutex::new((Instant::now() - Duration::from_secs(1), String::new())),
            min_gap: Duration::from_millis(100),
        }
    }

    pub fn send(&self, p: ModulesUpdateProgress) {
        let Some(sink) = self.sink else { return };
        let force = p.phase == "done" || p.phase == "persist";
        {
            let mut last = self.last.lock();
            let now = Instant::now();
            let same_phase = last.1 == p.phase;
            if !force && same_phase && now.duration_since(last.0) < self.min_gap {
                return;
            }
            last.0 = now;
            last.1 = p.phase.clone();
        }
        sink(p);
    }

    pub fn phase(&self, phase: &str, message: &str) {
        self.send(ModulesUpdateProgress {
            phase: phase.into(),
            message: message.into(),
            ..Default::default()
        });
    }
}
