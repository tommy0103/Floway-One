//! Process-local update work, independent of the durable staged artifact.
#[derive(Clone, Debug)]
pub struct UpdateActivity {
    pub revision: u64,
    pub phase: &'static str,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub received: u64,
    pub total: Option<u64>,
    pub checked_at: Option<u64>,
    pub updated_version: Option<String>,
    busy: bool,
    consecutive_failures: u32,
}

impl Default for UpdateActivity {
    fn default() -> Self {
        Self {
            revision: 0,
            phase: "idle",
            version: None,
            notes: None,
            received: 0,
            total: None,
            checked_at: None,
            updated_version: None,
            busy: false,
            consecutive_failures: 0,
        }
    }
}

impl UpdateActivity {
    pub fn begin_check(&mut self, at: u64) -> bool {
        if self.busy {
            return false;
        }
        self.busy = true;
        self.phase = "checking";
        self.checked_at = Some(at);
        self.version = None;
        self.notes = None;
        self.received = 0;
        self.total = None;
        true
    }
    pub fn begin_install(&mut self, staged: bool) -> bool {
        if self.busy || !staged {
            return false;
        }
        self.busy = true;
        self.phase = "installing";
        true
    }
    pub fn download(&mut self, chunk: u64, total: Option<u64>) {
        self.received = self.received.saturating_add(chunk);
        self.total = total.filter(|total| *total > 0);
    }
    pub fn finish(&mut self, phase: &'static str) {
        self.phase = phase;
        self.busy = false;
        self.consecutive_failures = if phase == "error" {
            self.consecutive_failures.saturating_add(1)
        } else {
            0
        };
    }
    pub fn is_busy(&self) -> bool {
        self.busy
    }
    pub fn poll_delay_seconds(&self) -> u64 {
        30 * 60 * 2_u64.pow(self.consecutive_failures.min(2))
    }
}
