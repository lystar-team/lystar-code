use super::{AppState, TranscriptWindow};

#[derive(Debug, Clone, Default)]
pub struct ReadonlySessionView {
    pub path: String,
    pub generation: u64,
    pub transcript: TranscriptWindow,
    pub search: SearchState,
    pub status: String,
}

#[derive(Debug, Clone, Default)]
pub struct SearchState {
    pub open: bool,
    pub query: String,
    pub hits: Vec<SearchHit>,
    pub selected: usize,
    pub pending_jump: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub entry_id: String,
    pub kind: String,
    pub timestamp: String,
    pub snippet: String,
}

impl AppState {
    pub fn open_search(&mut self) {
        self.search.open = true;
        self.search.status.clear();
    }

    pub fn close_search(&mut self) {
        self.search.open = false;
        self.search.status.clear();
    }

    pub fn clear_for_reload(&mut self, reason: impl Into<String>) {
        self.transcript.clear_for_reload(reason);
        self.search.hits.clear();
        self.search.selected = 0;
        self.search.pending_jump = None;
        self.clear_transient();
    }

    pub fn set_search_results(&mut self, hits: Vec<SearchHit>) {
        self.search.selected = 0;
        self.search.hits = hits;
        self.search.status = format!("{} 个结果", self.search.hits.len());
    }

    pub fn select_search_result(&mut self) -> Option<String> {
        let entry_id = self.search.hits.get(self.search.selected)?.entry_id.clone();
        if self.transcript.jump_to(&entry_id) {
            self.search.status = "已跳转".to_owned();
            return None;
        }
        self.search.pending_jump = Some(entry_id.clone());
        self.search.status = "正在加载目标记录".to_owned();
        Some(entry_id)
    }

    pub fn resolve_pending_jump(&mut self) {
        if let Some(entry_id) = self.search.pending_jump.clone()
            && self.transcript.jump_to(&entry_id)
        {
            self.search.pending_jump = None;
            self.search.status = "已跳转".to_owned();
        }
    }
}
