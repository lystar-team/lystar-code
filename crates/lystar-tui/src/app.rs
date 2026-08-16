use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    time::{Duration, Instant},
};

use crate::editor::EditorState;
use lystar_protocol::{
    OperationSnapshot, SessionProgress, SessionSnapshot, ToolCall, TranscriptItem,
    TranscriptViewItem,
};
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Style},
    widgets::Widget,
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

pub const ROUND_CACHE_LIMIT: usize = 400;
pub const ITEM_CACHE_LIMIT: usize = 800;
pub const UTF8_CACHE_LIMIT: usize = 4 * 1024 * 1024;
pub const B3_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const OLDER_PAGE_THRESHOLD: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptRound {
    pub entry_ids: Vec<String>,
    pub items: Vec<TranscriptItem>,
    pub tool_call_ids: Vec<String>,
    pub expanded: bool,
}

impl TranscriptRound {
    fn new(item: TranscriptItem) -> Self {
        let tool_call_ids = tool_calls(&item)
            .iter()
            .map(|call| call.id.clone())
            .collect();
        Self {
            entry_ids: vec![item.entry_id.clone()],
            items: vec![item],
            tool_call_ids,
            expanded: false,
        }
    }

    fn push(&mut self, item: TranscriptItem) {
        self.entry_ids.push(item.entry_id.clone());
        self.items.push(item);
    }

    pub fn contains(&self, entry_id: &str) -> bool {
        self.entry_ids.iter().any(|candidate| candidate == entry_id)
    }

    fn is_tool_round(&self) -> bool {
        !self.tool_call_ids.is_empty()
    }

    fn byte_len(&self) -> usize {
        self.items.iter().map(TranscriptItem::utf8_len).sum()
    }

    fn item_count(&self) -> usize {
        self.items.len()
    }

    pub fn summary(&self) -> String {
        if self.is_tool_round() {
            let calls = self
                .items
                .iter()
                .flat_map(tool_calls)
                .map(|call| format!("Tool {} {}", call.name, call.summary))
                .collect::<Vec<_>>()
                .join(" | ");
            let results = self
                .items
                .iter()
                .filter_map(tool_result_summary)
                .collect::<Vec<_>>()
                .join(" | ");
            return if results.is_empty() {
                format!("{calls}  运行中")
            } else {
                format!("{calls}  {results}")
            };
        }
        self.items
            .first()
            .map(item_summary)
            .unwrap_or_else(|| "空记录".to_owned())
    }

    pub fn detail_lines(&self) -> Vec<String> {
        self.items
            .iter()
            .flat_map(|item| match &item.view {
                TranscriptViewItem::ToolResult {
                    detail,
                    content_ref,
                    ..
                } => {
                    let mut lines = vec![format!("{} {}", item.entry_id, item.timestamp)];
                    if let Some(detail) = detail {
                        lines.push(detail.clone());
                    }
                    if let Some(content_ref) = content_ref {
                        lines.push(format!("content_ref: {content_ref}"));
                    }
                    lines
                }
                _ => vec![
                    format!("{} {}", item.entry_id, item.timestamp),
                    item_summary(item),
                ],
            })
            .collect()
    }

    fn hyperlink(&self) -> Option<(&str, &str)> {
        self.items.iter().flat_map(tool_calls).find_map(|call| {
            call.href
                .as_deref()
                .map(|href| (href, call.summary.as_str()))
        })
    }
}

fn tool_calls(item: &TranscriptItem) -> &[ToolCall] {
    match &item.view {
        TranscriptViewItem::ToolCall { calls } => calls,
        _ => &[],
    }
}

fn tool_result_summary(item: &TranscriptItem) -> Option<String> {
    match &item.view {
        TranscriptViewItem::ToolResult {
            name,
            status,
            summary,
            ..
        } if status == "error" => Some(format!("{name} 错误: {summary}")),
        TranscriptViewItem::ToolResult { name, summary, .. } => {
            Some(format!("{name} 完成: {summary}"))
        }
        _ => None,
    }
}

fn item_summary(item: &TranscriptItem) -> String {
    match &item.view {
        TranscriptViewItem::User { text } => format!("用户  {text}"),
        TranscriptViewItem::Assistant { text } => format!("助手  {text}"),
        TranscriptViewItem::Thinking { text } => format!("思考  {text}"),
        TranscriptViewItem::Bash { text } => format!("Bash  {text}"),
        TranscriptViewItem::Custom { text } => format!("自定义  {text}"),
        TranscriptViewItem::Summary { title, text } => format!("{title}  {text}"),
        TranscriptViewItem::System { text } => format!("系统  {text}"),
        TranscriptViewItem::ToolCall { .. } | TranscriptViewItem::ToolResult { .. } => {
            "Tool".to_owned()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TranscriptDiagnostics {
    pub cached_rounds: usize,
    pub cached_items: usize,
    pub cached_utf8_bytes: usize,
    pub streaming_preview_utf8_bytes: usize,
    pub total_utf8_bytes: usize,
}

#[derive(Debug, Clone, Default)]
pub struct TranscriptWindow {
    rounds: VecDeque<TranscriptRound>,
    pub scroll: usize,
    pub current: usize,
    pub generation: Option<String>,
    pub revision: u64,
    pub previous_cursor: Option<String>,
    pub loading_previous: bool,
    pub streaming_preview: Option<String>,
    pub status: String,
}

impl TranscriptWindow {
    pub fn replace_page(
        &mut self,
        items: Vec<TranscriptItem>,
        generation: String,
        revision: u64,
        previous_cursor: Option<String>,
    ) {
        self.rounds = group_rounds(items).into();
        self.enforce_limits(false);
        self.generation = Some(generation);
        self.revision = revision;
        self.previous_cursor = previous_cursor;
        self.loading_previous = false;
        self.scroll = self.rounds.len().saturating_sub(1);
        self.current = self.scroll;
        self.status = format!("{} 轮", self.rounds.len());
    }

    pub fn prepend_page(&mut self, items: Vec<TranscriptItem>, previous_cursor: Option<String>) {
        let current_entry_id = self
            .rounds
            .get(self.current)
            .and_then(|round| round.entry_ids.first())
            .cloned();
        let scroll_entry_id = self
            .rounds
            .get(self.scroll)
            .and_then(|round| round.entry_ids.first())
            .cloned();
        let mut combined = items;
        combined.extend(self.rounds.iter().flat_map(|round| round.items.clone()));
        self.rounds = group_rounds(combined).into();
        self.enforce_limits(true);
        self.previous_cursor = previous_cursor;
        self.loading_previous = false;
        self.scroll = scroll_entry_id
            .as_deref()
            .and_then(|entry_id| {
                self.rounds
                    .iter()
                    .position(|round| round.contains(entry_id))
            })
            .unwrap_or(0);
        self.current = current_entry_id
            .as_deref()
            .and_then(|entry_id| {
                self.rounds
                    .iter()
                    .position(|round| round.contains(entry_id))
            })
            .unwrap_or(self.scroll);
        self.status = format!("已加载更早记录，缓存 {} 轮", self.rounds.len());
    }

    pub fn accepts_previous_page(
        &self,
        generation: &str,
        revision: u64,
        request_generation: Option<&str>,
        request_revision: Option<u64>,
    ) -> bool {
        self.generation.as_deref() == Some(generation)
            && request_generation == self.generation.as_deref()
            && request_revision == Some(self.revision)
            && revision == self.revision
    }

    pub fn append_committed(
        &mut self,
        generation: &str,
        from_revision: u64,
        to_revision: u64,
        items: Vec<TranscriptItem>,
    ) -> bool {
        if self.generation.as_deref() != Some(generation)
            || self.revision != from_revision
            || to_revision < from_revision
        {
            return false;
        }
        let was_at_tail = self.current.saturating_add(1) >= self.rounds.len();
        let mut combined = self
            .rounds
            .iter()
            .flat_map(|round| round.items.clone())
            .collect::<Vec<_>>();
        combined.extend(items);
        self.rounds = group_rounds(combined).into();
        self.enforce_limits(false);
        self.revision = to_revision;
        if was_at_tail {
            self.current = self.rounds.len().saturating_sub(1);
            self.scroll = self.current;
        }
        self.status = "已提交新记录".to_owned();
        true
    }

    pub fn clear_for_reload(&mut self, reason: impl Into<String>) {
        self.rounds.clear();
        self.scroll = 0;
        self.current = 0;
        self.generation = None;
        self.revision = 0;
        self.previous_cursor = None;
        self.loading_previous = false;
        self.streaming_preview = None;
        self.status = reason.into();
    }

    pub fn scroll_by(&mut self, delta: isize) {
        self.current = self
            .current
            .saturating_add_signed(delta)
            .min(self.rounds.len().saturating_sub(1));
        self.scroll = self.current;
    }

    pub fn jump_to(&mut self, entry_id: &str) -> bool {
        let Some(index) = self
            .rounds
            .iter()
            .position(|round| round.contains(entry_id))
        else {
            return false;
        };
        self.current = index;
        self.scroll = index;
        true
    }

    pub fn toggle_current_tool(&mut self) {
        if let Some(round) = self.rounds.get_mut(self.current)
            && round.is_tool_round()
        {
            round.expanded = !round.expanded;
            self.status = if round.expanded {
                "已展开当前 Tool"
            } else {
                "已收起当前 Tool"
            }
            .to_owned();
        }
    }

    pub fn needs_previous_page(&self) -> bool {
        !self.loading_previous
            && self.previous_cursor.is_some()
            && self.current <= OLDER_PAGE_THRESHOLD
    }

    pub fn take_previous_cursor(&mut self) -> Option<String> {
        self.loading_previous = true;
        self.previous_cursor.clone()
    }

    pub fn current_entry_id(&self) -> Option<&str> {
        self.rounds
            .get(self.current)
            .and_then(|round| round.entry_ids.first())
            .map(String::as_str)
    }

    pub fn cached_rounds(&self) -> usize {
        self.rounds.len()
    }
    pub fn rounds(&self) -> &VecDeque<TranscriptRound> {
        &self.rounds
    }
    pub fn diagnostics(&self) -> TranscriptDiagnostics {
        let cached_utf8_bytes = self.rounds.iter().map(TranscriptRound::byte_len).sum();
        let streaming_preview_utf8_bytes = self.streaming_preview.as_ref().map_or(0, String::len);
        TranscriptDiagnostics {
            cached_rounds: self.rounds.len(),
            cached_items: self.rounds.iter().map(TranscriptRound::item_count).sum(),
            cached_utf8_bytes,
            streaming_preview_utf8_bytes,
            total_utf8_bytes: cached_utf8_bytes + streaming_preview_utf8_bytes,
        }
    }
    fn enforce_limits(&mut self, preserve_older: bool) {
        while self.rounds.len() > ROUND_CACHE_LIMIT
            || self
                .rounds
                .iter()
                .map(TranscriptRound::item_count)
                .sum::<usize>()
                > ITEM_CACHE_LIMIT
            || self
                .rounds
                .iter()
                .map(TranscriptRound::byte_len)
                .sum::<usize>()
                > UTF8_CACHE_LIMIT
        {
            if preserve_older {
                self.rounds.pop_back();
            } else {
                self.rounds.pop_front();
            }
        }
        self.scroll = self.scroll.min(self.rounds.len().saturating_sub(1));
        self.current = self.current.min(self.rounds.len().saturating_sub(1));
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverlayItem {
    pub label: String,
    pub detail: String,
    pub action: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum OverlayOrigin {
    #[default]
    User,
    RecoverySession,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListOverlay {
    pub title: String,
    pub origin: OverlayOrigin,
    pub items: Vec<OverlayItem>,
    pub selected: usize,
    pub filter: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverlayLink {
    pub line: usize,
    pub label: String,
    pub href: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetailOverlay {
    pub title: String,
    pub lines: Vec<String>,
    pub scroll: usize,
    pub status: String,
    pub link: Option<OverlayLink>,
    pub copy_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextEditorOverlay {
    pub title: String,
    pub value: String,
    pub cursor: usize,
    pub save_action: String,
    pub status: String,
    pub secret: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmOverlay {
    pub title: String,
    pub message: String,
    pub confirm_action: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverlayState {
    List(ListOverlay),
    Detail(DetailOverlay),
    TextEditor(TextEditorOverlay),
    Confirm(ConfirmOverlay),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingDescriptor {
    pub id: String,
    pub label: String,
    pub description: String,
    pub kind: String,
    pub value: serde_json::Value,
    pub display_value: String,
    pub options: Vec<String>,
    pub minimum: Option<i64>,
    pub maximum: Option<i64>,
    pub scope: String,
    pub read_only: bool,
    pub restart_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelDescriptor {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub reasoning: bool,
    pub input: Vec<String>,
    pub context_window: u64,
    pub configured: bool,
    pub supported_thinking_levels: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderDescriptor {
    pub id: String,
    pub name: String,
    pub configured: bool,
    pub auth_methods: Vec<String>,
    pub auth_source: Option<String>,
    pub model_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSummary {
    pub path: String,
    pub id: String,
    pub cwd: String,
    pub name: Option<String>,
    pub updated_at: u64,
    pub first_message: String,
    pub activity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionTreeNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub label: Option<String>,
    pub timestamp: String,
    pub preview: String,
    pub is_leaf: bool,
    pub depth: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveSessionContext {
    pub path: String,
    pub lease_id: Option<String>,
    pub generation: u64,
    pub cwd: String,
}

#[derive(Debug, Clone)]
pub struct SessionRestorePoint {
    pub context: Option<ActiveSessionContext>,
    pub transcript: TranscriptWindow,
    pub search: SearchState,
    pub editor: EditorState,
    pub snapshot: Option<SessionSnapshot>,
    pub lease_id: Option<String>,
    pub operation: Option<OperationSnapshot>,
    pub live_tools: BTreeMap<String, LiveTool>,
    pub assistant_stream: String,
    pub thinking_stream: String,
    pub overlays: Vec<OverlayState>,
    pub input_focus: InputFocus,
    pub focus_before_overlay: Option<InputFocus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptViewKind {
    Active,
    Readonly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptRequestKind {
    Initial,
    Older,
    Search,
}

#[derive(Debug, Clone)]
pub struct TranscriptPendingRequest {
    pub view: TranscriptViewKind,
    pub kind: TranscriptRequestKind,
    pub session_path: String,
    pub generation: u64,
    pub context: Option<lystar_protocol::TranscriptRequestContext>,
}

#[derive(Debug, Clone, Default)]
pub struct ReadonlySessionView {
    pub path: String,
    pub generation: u64,
    pub transcript: TranscriptWindow,
    pub search: SearchState,
    pub status: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkbenchTarget {
    Settings,
    Model,
    Thinking,
    Login,
    Sessions,
    Tree,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TreeFilter {
    #[default]
    Default,
    NoTools,
    UserOnly,
    LabeledOnly,
    All,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct B3Request {
    pub command: lystar_protocol::B3Command,
    pub payload: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingIntent {
    Overlay {
        target: String,
    },
    ClipboardMutation {
        toast: String,
    },
    WorkbenchLoad {
        target: WorkbenchTarget,
        selected_key: Option<String>,
        filter: String,
    },
    SettingMutation {
        selected_key: String,
        filter: String,
    },
    SessionMutation {
        toast: String,
        close_overlay: bool,
    },
    TreeMutation {
        selected_key: String,
        filter: String,
    },
    TreeNavigate {
        selected_key: String,
        filter: String,
    },
    AuthMutation {
        selected_key: Option<String>,
        filter: String,
        toast: String,
    },
}

#[derive(Debug, Clone)]
pub struct PendingRequest {
    pub intent: PendingIntent,
    pub generation: u64,
    pub request: B3Request,
    pub started_at: Instant,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum InputFocus {
    #[default]
    Composer,
    Overlay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiRequestKind {
    Select,
    Confirm,
    Input,
    Secret,
    Editor,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiRequest {
    pub id: String,
    pub kind: UiRequestKind,
}

impl UiRequest {
    pub fn secret(&self) -> bool {
        matches!(self.kind, UiRequestKind::Secret)
    }
}

impl OverlayState {
    pub fn title(&self) -> &str {
        match self {
            Self::List(value) => &value.title,
            Self::Detail(value) => &value.title,
            Self::TextEditor(value) => &value.title,
            Self::Confirm(value) => &value.title,
        }
    }
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveTool {
    pub name: String,
    pub summary: String,
    pub status: String,
}

#[derive(Debug, Default)]
pub struct AppState {
    pub active_session: Option<ActiveSessionContext>,
    pub sessions: Vec<SessionSummary>,
    pub tree: Vec<SessionTreeNode>,
    pub tree_filter: TreeFilter,
    pub readonly_view: Option<ReadonlySessionView>,
    pub session_generation: u64,
    pub transcript: TranscriptWindow,
    pub search: SearchState,
    pub editor: EditorState,
    pub snapshot: Option<SessionSnapshot>,
    pub lease_id: Option<String>,
    pub operation: Option<OperationSnapshot>,
    pub live_tools: BTreeMap<String, LiveTool>,
    pub assistant_stream: String,
    pub thinking_stream: String,
    pub disconnected: Option<String>,
    pub overlays: Vec<OverlayState>,
    pub input_focus: InputFocus,
    focus_before_overlay: Option<InputFocus>,
    pub toast: Option<String>,
    pub overlay_error: Option<String>,
    pub settings: Vec<SettingDescriptor>,
    pub models: Vec<ModelDescriptor>,
    pub providers: Vec<ProviderDescriptor>,
    pub write_pending: bool,
    pub pending_editor_replace: Option<String>,
    pub page_load_pending: bool,
    pub pending_requests: HashMap<String, PendingRequest>,
    pub pending_transcript_requests: HashMap<String, TranscriptPendingRequest>,
    pub request_generation: u64,
    pub active_ui_request: Option<UiRequest>,
    responded_ui_requests: HashSet<String>,
    composer_width: u16,
}

impl AppState {
    pub fn active_session_path(&self) -> Option<&str> {
        self.active_session
            .as_ref()
            .map(|context| context.path.as_str())
    }

    pub fn active_session_cwd(&self) -> Option<&str> {
        self.active_session
            .as_ref()
            .map(|context| context.cwd.as_str())
    }

    pub fn begin_active_session(&mut self, path: String, cwd: String) -> u64 {
        self.session_generation = self.session_generation.saturating_add(1);
        self.invalidate_transcript_requests(TranscriptViewKind::Active);
        self.active_session = Some(ActiveSessionContext {
            path,
            lease_id: None,
            generation: self.session_generation,
            cwd,
        });
        self.session_generation
    }

    pub fn apply_active_lease(&mut self, lease_id: String, snapshot: SessionSnapshot) {
        if let Some(context) = &mut self.active_session {
            context.path = snapshot.path.clone();
            context.cwd = snapshot.cwd.clone();
            context.lease_id = Some(lease_id.clone());
        }
        self.apply_lease(lease_id, snapshot);
    }

    pub fn restore_point(&self) -> SessionRestorePoint {
        SessionRestorePoint {
            context: self.active_session.clone(),
            transcript: self.transcript.clone(),
            search: self.search.clone(),
            editor: self.editor.clone(),
            snapshot: self.snapshot.clone(),
            lease_id: self.lease_id.clone(),
            operation: self.operation.clone(),
            live_tools: self.live_tools.clone(),
            assistant_stream: self.assistant_stream.clone(),
            thinking_stream: self.thinking_stream.clone(),
            overlays: self.overlays.clone(),
            input_focus: self.input_focus,
            focus_before_overlay: self.focus_before_overlay,
        }
    }

    pub fn restore_session(&mut self, restore: SessionRestorePoint) {
        self.active_session = restore.context;
        self.transcript = restore.transcript;
        self.search = restore.search;
        self.editor = restore.editor;
        self.snapshot = restore.snapshot;
        self.lease_id = restore.lease_id;
        self.operation = restore.operation;
        self.live_tools = restore.live_tools;
        self.assistant_stream = restore.assistant_stream;
        self.thinking_stream = restore.thinking_stream;
        self.overlays = restore.overlays;
        self.input_focus = restore.input_focus;
        self.focus_before_overlay = restore.focus_before_overlay;
    }

    pub fn clear_active_session(&mut self, reason: impl Into<String>) {
        self.active_session = None;
        self.lease_id = None;
        self.snapshot = None;
        self.operation = None;
        self.invalidate_transcript_requests(TranscriptViewKind::Active);
        self.clear_for_reload(reason);
    }

    pub fn clear_connection_state(&mut self, reason: impl Into<String>) {
        self.clear_active_lease();
        self.page_load_pending = false;
        self.transcript.loading_previous = false;
        if let Some(view) = &mut self.readonly_view {
            view.transcript.loading_previous = false;
        }
        self.disconnected = Some(reason.into());
    }

    pub fn clear_active_lease(&mut self) {
        self.lease_id = None;
        if let Some(context) = &mut self.active_session {
            context.lease_id = None;
        }
    }

    pub fn begin_transcript_request(
        &mut self,
        id: String,
        view: TranscriptViewKind,
        kind: TranscriptRequestKind,
        session_path: String,
        generation: u64,
        context: Option<lystar_protocol::TranscriptRequestContext>,
    ) {
        self.pending_transcript_requests.insert(
            id,
            TranscriptPendingRequest {
                view,
                kind,
                session_path,
                generation,
                context,
            },
        );
    }

    pub fn take_transcript_request(&mut self, id: &str) -> Option<TranscriptPendingRequest> {
        self.pending_transcript_requests.remove(id)
    }

    pub fn invalidate_transcript_requests(&mut self, view: TranscriptViewKind) {
        self.pending_transcript_requests
            .retain(|_, request| request.view != view);
    }

    pub fn commit_session_switch(
        &mut self,
        path: String,
        lease_id: String,
        snapshot: SessionSnapshot,
    ) {
        self.begin_active_session(path, snapshot.cwd.clone());
        self.apply_active_lease(lease_id, snapshot);
        self.transcript.clear_for_reload("正在读取最新记录");
        self.search = SearchState::default();
        self.editor.clear();
        self.operation = None;
        self.clear_transient();
        self.clear_overlay_transient();
    }

    pub fn apply_lease(&mut self, lease_id: String, snapshot: SessionSnapshot) {
        self.lease_id = Some(lease_id);
        self.snapshot = Some(snapshot);
    }

    pub fn apply_snapshot(&mut self, snapshot: SessionSnapshot) {
        self.snapshot = Some(snapshot);
    }

    pub fn apply_operation(&mut self, operation: OperationSnapshot) {
        let terminal = matches!(
            operation.status.as_str(),
            "aborted" | "interrupted" | "failed"
        );
        self.operation = Some(operation);
        if terminal {
            self.clear_transient();
        }
    }

    pub fn apply_progress(&mut self, progress: SessionProgress) {
        match progress {
            SessionProgress::AssistantDelta { text } => self.assistant_stream.push_str(&text),
            SessionProgress::ThinkingDelta { text } => self.thinking_stream.push_str(&text),
            SessionProgress::ToolStart {
                tool_call_id,
                name,
                summary,
            } => {
                self.live_tools.insert(
                    tool_call_id,
                    LiveTool {
                        name,
                        summary: summary.unwrap_or_default(),
                        status: "运行中".to_owned(),
                    },
                );
            }
            SessionProgress::ToolUpdate {
                tool_call_id,
                name,
                summary,
            } => {
                self.live_tools.insert(
                    tool_call_id,
                    LiveTool {
                        name,
                        summary,
                        status: "运行中".to_owned(),
                    },
                );
            }
            SessionProgress::ToolEnd { tool_call_id, .. } => {
                self.live_tools.remove(&tool_call_id);
            }
            SessionProgress::QueueUpdate {
                steering_count,
                follow_up_count,
            } => {
                if let Some(snapshot) = &mut self.snapshot {
                    snapshot.queued_steer_count = steering_count;
                    snapshot.queued_follow_up_count = follow_up_count;
                }
            }
            SessionProgress::Phase { phase } => {
                if let Some(snapshot) = &mut self.snapshot {
                    snapshot.phase = phase;
                }
            }
            SessionProgress::Status { status, .. } => self.transcript.status = status,
            SessionProgress::Usage { usage } => {
                if let Some(elapsed) = usage.elapsed_ms {
                    self.transcript.status = format!("运行 {}ms", elapsed);
                }
            }
        }
    }

    pub fn clear_live_after_commit(&mut self, items: &[TranscriptItem]) {
        for item in items {
            if let TranscriptViewItem::ToolResult { call_id, .. } = &item.view {
                self.live_tools.remove(call_id);
            }
        }
        self.assistant_stream.clear();
        self.thinking_stream.clear();
    }

    pub fn is_recovery_session_chooser(&self) -> bool {
        self.active_session.is_none()
            && self.lease_id.is_none()
            && matches!(
                self.overlay(),
                Some(OverlayState::List(ListOverlay {
                    origin: OverlayOrigin::RecoverySession,
                    ..
                }))
            )
    }

    pub fn open_overlay(&mut self, overlay: OverlayState) {
        if self.overlays.is_empty() {
            self.focus_before_overlay = Some(self.input_focus);
            self.input_focus = InputFocus::Overlay;
        }
        self.overlay_error = None;
        self.overlays.push(overlay);
    }

    pub fn close_overlay(&mut self) -> bool {
        if self.overlays.pop().is_none() {
            return false;
        }
        self.overlay_error = None;
        if self.overlays.is_empty() {
            self.input_focus = self
                .focus_before_overlay
                .take()
                .unwrap_or(InputFocus::Composer);
        }
        true
    }

    pub fn clear_overlay_transient(&mut self) {
        self.invalidate_pending();
        self.invalidate_transcript_requests(TranscriptViewKind::Active);
        self.invalidate_transcript_requests(TranscriptViewKind::Readonly);
        self.overlays.clear();
        self.active_ui_request = None;
        self.overlay_error = None;
        self.input_focus = self
            .focus_before_overlay
            .take()
            .unwrap_or(InputFocus::Composer);
    }

    pub fn overlay_mut(&mut self) -> Option<&mut OverlayState> {
        self.overlays.last_mut()
    }

    pub fn overlay(&self) -> Option<&OverlayState> {
        self.overlays.last()
    }

    pub fn replace_overlay(&mut self, overlay: OverlayState) {
        if let Some(current) = self.overlays.last_mut() {
            *current = overlay;
        } else {
            self.open_overlay(overlay);
        }
    }

    pub fn begin_request(&mut self, id: String, request: B3Request, intent: PendingIntent) -> u64 {
        self.request_generation = self.request_generation.saturating_add(1);
        let generation = self.request_generation;
        self.pending_requests.insert(
            id,
            PendingRequest {
                intent,
                generation,
                request,
                started_at: Instant::now(),
            },
        );
        generation
    }

    pub fn take_pending(&mut self, id: &str) -> Option<PendingRequest> {
        let pending = self.pending_requests.remove(id)?;
        if matches!(
            pending.intent,
            PendingIntent::SettingMutation { .. }
                | PendingIntent::SessionMutation { .. }
                | PendingIntent::TreeMutation { .. }
                | PendingIntent::TreeNavigate { .. }
                | PendingIntent::AuthMutation { .. }
                | PendingIntent::ClipboardMutation { .. }
        ) {
            self.write_pending = false;
        }
        Some(pending)
    }

    pub fn timed_out_b3_request(&self) -> Option<(String, B3Request)> {
        self.pending_requests.iter().find_map(|(id, pending)| {
            (pending.started_at.elapsed() >= B3_REQUEST_TIMEOUT)
                .then(|| (id.clone(), pending.request.clone()))
        })
    }

    pub fn invalidate_pending(&mut self) {
        self.request_generation = self.request_generation.saturating_add(1);
        self.pending_requests.clear();
        self.pending_transcript_requests.clear();
        self.pending_editor_replace = None;
        self.write_pending = false;
    }

    pub fn restart_timed_out_b3_request(&mut self) -> Option<(String, B3Request)> {
        let (id, request) = self.timed_out_b3_request()?;
        if let Some(pending) = self.pending_requests.get_mut(&id) {
            pending.started_at = Instant::now();
        }
        Some((id, request))
    }

    pub fn mark_page_load_pending(&mut self) {
        self.page_load_pending = true;
    }

    pub fn clear_page_load_pending(&mut self) {
        self.page_load_pending = false;
    }

    pub fn has_pending_work(&self) -> bool {
        self.page_load_pending
            || self.transcript.loading_previous
            || self
                .readonly_view
                .as_ref()
                .is_some_and(|view| view.transcript.loading_previous)
            || !self.pending_requests.is_empty()
            || !self.pending_transcript_requests.is_empty()
            || self.is_active_operation()
    }

    pub fn overlay_copy_text(&self) -> Option<String> {
        match self.overlay() {
            Some(OverlayState::Detail(detail)) => detail.copy_text.clone(),
            _ => None,
        }
    }

    pub fn set_overlay_error(&mut self, message: impl Into<String>) {
        self.overlay_error = Some(message.into());
    }

    pub fn setting(&self, id: &str) -> Option<&SettingDescriptor> {
        self.settings.iter().find(|setting| setting.id == id)
    }

    pub fn model_supports_reasoning(&self) -> Result<&ModelDescriptor, String> {
        let snapshot = self
            .snapshot
            .as_ref()
            .ok_or_else(|| "尚未获取会话状态".to_owned())?;
        let model = snapshot
            .model
            .as_ref()
            .ok_or_else(|| "当前会话没有选择模型".to_owned())?;
        let descriptor = self
            .models
            .iter()
            .find(|candidate| candidate.provider == model.provider && candidate.id == model.id)
            .ok_or_else(|| "当前模型不可用或未完成认证".to_owned())?;
        if !descriptor.configured {
            return Err("当前模型未完成认证".to_owned());
        }
        if !descriptor.reasoning {
            return Err("当前模型不支持思考强度".to_owned());
        }
        Ok(descriptor)
    }

    pub fn mark_write_pending(&mut self) {
        self.write_pending = true;
    }

    pub fn set_timeout_notice(&mut self) {
        if self.timed_out_b3_request().is_some() {
            self.set_overlay_error("请求超时，按 r 重试");
        }
    }

    pub fn set_toast(&mut self, message: impl Into<String>) {
        self.toast = Some(message.into());
    }

    pub fn register_ui_request(&mut self, request: UiRequest) -> bool {
        if self.responded_ui_requests.contains(&request.id)
            || self
                .active_ui_request
                .as_ref()
                .is_some_and(|active| active.id == request.id)
        {
            return false;
        }
        self.active_ui_request = Some(request);
        true
    }

    pub fn take_ui_response(&mut self) -> Option<UiRequest> {
        let request = self.active_ui_request.take()?;
        if !self.responded_ui_requests.insert(request.id.clone()) {
            return None;
        }
        Some(request)
    }

    pub fn mark_ui_responded(&mut self, id: &str) -> bool {
        self.responded_ui_requests.insert(id.to_owned())
    }

    pub fn cancel_unknown_ui_request(&mut self, id: &str) -> bool {
        self.mark_ui_responded(id)
    }

    fn list_matches(list: &ListOverlay, index: usize) -> bool {
        list.items.get(index).is_some_and(|item| {
            list.filter.is_empty()
                || format!("{} {}", item.label, item.detail)
                    .to_lowercase()
                    .contains(&list.filter.to_lowercase())
        })
    }

    fn normalize_list_selection(list: &mut ListOverlay) {
        if Self::list_matches(list, list.selected) {
            return;
        }
        list.selected = (0..list.items.len())
            .find(|index| Self::list_matches(list, *index))
            .unwrap_or(0);
    }

    pub fn tree_visible_indices(&self) -> Vec<usize> {
        let Some(OverlayState::List(list)) = self.overlay() else {
            return Vec::new();
        };
        if list.title != "分支树" {
            return Vec::new();
        }
        list.items
            .iter()
            .enumerate()
            .filter(|(index, _)| Self::list_matches(list, *index))
            .filter_map(|(_, item)| item.action.strip_prefix("tree:")?.parse::<usize>().ok())
            .collect()
    }

    pub fn select_tree_visible(&mut self, delta: isize, labelled_only: bool) {
        let visible = self
            .tree_visible_indices()
            .into_iter()
            .filter(|index| {
                !labelled_only
                    || self
                        .tree
                        .get(*index)
                        .is_some_and(|node| node.label.is_some())
            })
            .collect::<Vec<_>>();
        let Some(current) = self
            .current_overlay_action()
            .as_deref()
            .and_then(|action| action.strip_prefix("tree:"))
            .and_then(|value| value.parse::<usize>().ok())
        else {
            return;
        };
        let Some(position) = visible.iter().position(|index| *index == current) else {
            return;
        };
        let next = position
            .saturating_add_signed(delta)
            .min(visible.len().saturating_sub(1));
        let Some(target) = visible.get(next) else {
            return;
        };
        if let Some(OverlayState::List(list)) = self.overlay_mut()
            && let Some(selected) = list
                .items
                .iter()
                .position(|item| item.action == format!("tree:{target}"))
        {
            list.selected = selected;
        }
    }
    pub fn move_overlay_selection(&mut self, delta: isize) {
        let Some(OverlayState::List(list)) = self.overlay_mut() else {
            return;
        };
        let matches = (0..list.items.len())
            .filter(|index| Self::list_matches(list, *index))
            .collect::<Vec<_>>();
        let Some(position) = matches.iter().position(|index| *index == list.selected) else {
            Self::normalize_list_selection(list);
            return;
        };
        let next = position
            .saturating_add_signed(delta)
            .min(matches.len().saturating_sub(1));
        list.selected = matches[next];
    }

    pub fn current_overlay_action(&self) -> Option<String> {
        match self.overlay() {
            Some(OverlayState::List(list)) if Self::list_matches(list, list.selected) => list
                .items
                .get(list.selected)
                .map(|item| item.action.clone()),
            Some(OverlayState::TextEditor(editor)) => Some(editor.save_action.clone()),
            Some(OverlayState::Confirm(confirm)) => Some(confirm.confirm_action.clone()),
            Some(OverlayState::Detail(_)) | Some(OverlayState::List(_)) | None => None,
        }
    }

    pub fn overlay_insert(&mut self, value: &str) {
        match self.overlay_mut() {
            Some(OverlayState::List(list)) => {
                list.filter.push_str(value);
                Self::normalize_list_selection(list);
            }
            Some(OverlayState::TextEditor(editor)) => {
                editor.value.insert_str(editor.cursor, value);
                editor.cursor += value.len();
            }
            _ => {}
        }
    }

    pub fn overlay_backspace(&mut self) {
        match self.overlay_mut() {
            Some(OverlayState::List(list)) => {
                list.filter.pop();
                Self::normalize_list_selection(list);
            }
            Some(OverlayState::TextEditor(editor)) if editor.cursor > 0 => {
                let mut start = editor.cursor - 1;
                while !editor.value.is_char_boundary(start) {
                    start -= 1;
                }
                editor.value.drain(start..editor.cursor);
                editor.cursor = start;
            }
            _ => {}
        }
    }

    pub fn overlay_page(&mut self, delta: isize) {
        match self.overlay_mut() {
            Some(OverlayState::List(list)) => {
                let matches = (0..list.items.len())
                    .filter(|index| Self::list_matches(list, *index))
                    .collect::<Vec<_>>();
                if let Some(position) = matches.iter().position(|index| *index == list.selected) {
                    let next = position
                        .saturating_add_signed(delta * 10)
                        .min(matches.len().saturating_sub(1));
                    list.selected = matches[next];
                }
            }
            Some(OverlayState::Detail(detail)) => {
                detail.scroll = detail.scroll.saturating_add_signed(delta * 10)
            }
            _ => {}
        }
    }

    pub fn overlay_home_end(&mut self, end: bool) {
        match self.overlay_mut() {
            Some(OverlayState::List(list)) => {
                let matches = (0..list.items.len())
                    .filter(|index| Self::list_matches(list, *index))
                    .collect::<Vec<_>>();
                list.selected = if end {
                    matches.last().copied().unwrap_or(0)
                } else {
                    matches.first().copied().unwrap_or(0)
                };
            }
            Some(OverlayState::Detail(detail)) => {
                detail.scroll = if end {
                    detail.lines.len().saturating_sub(1)
                } else {
                    0
                }
            }
            _ => {}
        }
    }

    pub fn composer_height(&self, total_height: u16) -> u16 {
        if total_height <= 8 { 4 } else { 6 }
    }

    pub fn is_active_operation(&self) -> bool {
        self.snapshot.as_ref().is_some_and(|snapshot| {
            matches!(snapshot.activity.as_str(), "running" | "waiting_for_input")
                || matches!(
                    snapshot.phase.as_str(),
                    "turn" | "compaction" | "branch_summary" | "retry" | "waiting_for_input"
                )
        }) || self.operation.as_ref().is_some_and(|operation| {
            matches!(
                operation.status.as_str(),
                "accepted" | "running" | "waiting_for_input"
            )
        })
    }

    pub fn composer_width(&self) -> u16 {
        self.composer_width
    }

    pub fn prepare_composer(&mut self, area: Rect) {
        self.composer_width = area.width;
        self.editor
            .ensure_cursor_visible(area.width, area.height.saturating_sub(3).max(1));
    }

    pub fn footer_status(&self) -> String {
        let Some(snapshot) = &self.snapshot else {
            return "未获取会话租约".to_owned();
        };
        let model = snapshot
            .model
            .as_ref()
            .map_or("无模型".to_owned(), |model| {
                format!("{}/{}", model.provider, model.id)
            });
        format!(
            "{} 队列 {}/{} {} 思考 {} {}",
            snapshot.phase,
            snapshot.queued_steer_count,
            snapshot.queued_follow_up_count,
            model,
            snapshot.thinking_level,
            snapshot.cwd
        )
    }

    pub fn open_search(&mut self) {
        self.search.open = true;
        self.search.status.clear();
    }
    pub fn close_search(&mut self) {
        self.search.open = false;
        self.search.status.clear();
    }
    pub fn clear_transient(&mut self) {
        self.assistant_stream.clear();
        self.thinking_stream.clear();
        self.live_tools.clear();
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisibleLink {
    pub column: u16,
    pub row: u16,
    pub label: String,
    pub href: String,
}

pub struct WorkbenchOverlayView<'a> {
    state: &'a AppState,
}

impl<'a> WorkbenchOverlayView<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }
}

fn overlay_rect(area: Rect) -> Option<Rect> {
    if area.width < 8 || area.height < 4 {
        return None;
    }
    let width = area.width.saturating_sub(4).clamp(8, 96);
    let height = area.height.saturating_sub(2).clamp(4, 28);
    Some(Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    ))
}

impl WorkbenchOverlayView<'_> {
    pub fn visible_link(&self, area: Rect) -> Option<VisibleLink> {
        let OverlayState::Detail(detail) = self.state.overlay()? else {
            return None;
        };
        let link = detail.link.as_ref()?;
        let overlay = overlay_rect(area)?;
        let visible = usize::from(overlay.height.saturating_sub(4));
        if link.line < detail.scroll || link.line >= detail.scroll.saturating_add(visible) {
            return None;
        }
        let line = detail.lines.get(link.line)?;
        let offset = line.find(&link.label)?;
        let label = truncate_graphemes(
            &line[offset..],
            usize::from(overlay.width.saturating_sub(4))
                .saturating_sub(UnicodeWidthStr::width(&line[..offset])),
        );
        if label.is_empty() {
            return None;
        }
        Some(VisibleLink {
            column: overlay.x + 2 + u16::try_from(UnicodeWidthStr::width(&line[..offset])).ok()?,
            row: overlay.y + 1 + u16::try_from(link.line - detail.scroll).ok()?,
            label,
            href: link.href.clone(),
        })
    }
}

impl Widget for WorkbenchOverlayView<'_> {
    fn render(self, area: Rect, buffer: &mut Buffer) {
        if let Some(toast) = &self.state.toast {
            put_line(
                buffer,
                area.x.saturating_add(1),
                area.y,
                toast,
                usize::from(area.width.saturating_sub(2)),
                Style::default().fg(Color::Yellow),
            );
        }
        let Some(overlay) = self.state.overlay() else {
            if let Some(error) = &self.state.overlay_error {
                put_line(
                    buffer,
                    area.x.saturating_add(1),
                    area.y.saturating_add(1),
                    error,
                    usize::from(area.width.saturating_sub(2)),
                    Style::default().fg(Color::Red),
                );
            }
            return;
        };
        let Some(overlay_rect) = overlay_rect(area) else {
            return;
        };
        let width = overlay_rect.width;
        let height = overlay_rect.height;
        let x = overlay_rect.x;
        let y = overlay_rect.y;
        for row in 0..height {
            let line = if row == 0 || row == height.saturating_sub(1) {
                "─".repeat(usize::from(width))
            } else {
                format!("│{}│", " ".repeat(usize::from(width.saturating_sub(2))))
            };
            put_line(
                buffer,
                x,
                y + row,
                &line,
                usize::from(width),
                Style::default().fg(Color::Cyan),
            );
        }
        put_line(
            buffer,
            x + 1,
            y,
            overlay.title(),
            usize::from(width.saturating_sub(2)),
            Style::default().fg(Color::Yellow),
        );
        let inner_width = usize::from(width.saturating_sub(4));
        let visible = usize::from(height.saturating_sub(4));
        match overlay {
            OverlayState::List(list) => {
                let filtered = list
                    .items
                    .iter()
                    .filter(|item| {
                        list.filter.is_empty()
                            || format!("{} {}", item.label, item.detail)
                                .to_lowercase()
                                .contains(&list.filter.to_lowercase())
                    })
                    .collect::<Vec<_>>();
                for (row, item) in filtered.iter().take(visible).enumerate() {
                    let selected = list
                        .items
                        .iter()
                        .position(|candidate| candidate.action == item.action)
                        == Some(list.selected);
                    put_line(
                        buffer,
                        x + 2,
                        y + 1 + u16::try_from(row).unwrap_or(0),
                        &format!(
                            "{} {}  {}",
                            if selected { ">" } else { " " },
                            item.label,
                            item.detail
                        ),
                        inner_width,
                        Style::default().fg(if selected {
                            Color::White
                        } else {
                            Color::DarkGray
                        }),
                    );
                }
                put_line(
                    buffer,
                    x + 2,
                    y + height.saturating_sub(2),
                    &format!("{}  {}", list.filter, list.status),
                    inner_width,
                    Style::default().fg(Color::DarkGray),
                );
            }
            OverlayState::Detail(detail) => {
                for (row, line) in detail
                    .lines
                    .iter()
                    .skip(detail.scroll)
                    .take(visible)
                    .enumerate()
                {
                    put_line(
                        buffer,
                        x + 2,
                        y + 1 + u16::try_from(row).unwrap_or(0),
                        line,
                        inner_width,
                        Style::default().fg(Color::White),
                    );
                }
                put_line(
                    buffer,
                    x + 2,
                    y + height.saturating_sub(2),
                    &detail.status,
                    inner_width,
                    Style::default().fg(Color::DarkGray),
                );
            }
            OverlayState::TextEditor(editor) => {
                let displayed = if editor.secret {
                    editor
                        .value
                        .graphemes(true)
                        .map(|_| "*")
                        .collect::<String>()
                } else {
                    editor.value.clone()
                };
                for (row, line) in displayed.lines().take(visible).enumerate() {
                    put_line(
                        buffer,
                        x + 2,
                        y + 1 + u16::try_from(row).unwrap_or(0),
                        line,
                        inner_width,
                        Style::default().fg(Color::White),
                    );
                }
                put_line(
                    buffer,
                    x + 2,
                    y + height.saturating_sub(2),
                    &editor.status,
                    inner_width,
                    Style::default().fg(Color::DarkGray),
                );
            }
            OverlayState::Confirm(confirm) => {
                put_line(
                    buffer,
                    x + 2,
                    y + 2,
                    &confirm.message,
                    inner_width,
                    Style::default().fg(Color::White),
                );
                put_line(
                    buffer,
                    x + 2,
                    y + height.saturating_sub(2),
                    &format!("Enter 确认  Esc 取消  {}", confirm.status),
                    inner_width,
                    Style::default().fg(Color::Yellow),
                );
            }
        }
        if let Some(error) = &self.state.overlay_error {
            put_line(
                buffer,
                x + 2,
                y + height.saturating_sub(3),
                error,
                inner_width,
                Style::default().fg(Color::Red),
            );
        }
    }
}

pub struct TranscriptView<'a> {
    state: &'a AppState,
}
impl<'a> TranscriptView<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn visible_link(&self, area: Rect) -> Option<VisibleLink> {
        let search_height = u16::from(self.state.search.open).saturating_mul(2);
        let content_height = area.height.saturating_sub(1 + search_height);
        let width = usize::from(area.width.saturating_sub(1));
        let mut row = 0_u16;
        for (index, round) in self
            .state
            .transcript
            .rounds()
            .iter()
            .enumerate()
            .skip(self.state.transcript.scroll)
        {
            if row >= content_height {
                return None;
            }
            let marker = if index == self.state.transcript.current {
                ">"
            } else {
                " "
            };
            let expansion = if round.is_tool_round() {
                if round.expanded { "v" } else { ">" }
            } else {
                " "
            };
            let line = format!("{marker}{expansion} {}", round.summary());
            if index == self.state.transcript.current {
                let (href, label) = round.hyperlink()?;
                let visible_line = truncate_graphemes(&line, width);
                let offset = visible_line.find(label)?;
                let label = truncate_graphemes(
                    &visible_line[offset..],
                    width.saturating_sub(UnicodeWidthStr::width(&visible_line[..offset])),
                );
                if label.is_empty() {
                    return None;
                }
                return Some(VisibleLink {
                    column: area.x
                        + u16::try_from(UnicodeWidthStr::width(&visible_line[..offset])).ok()?,
                    row: area.y + row,
                    label,
                    href: href.to_owned(),
                });
            }
            row += 1;
            if round.expanded {
                row = row
                    .saturating_add(u16::try_from(round.detail_lines().len()).unwrap_or(u16::MAX));
            }
        }
        None
    }
}

impl Widget for TranscriptView<'_> {
    fn render(self, area: Rect, buffer: &mut Buffer) {
        if area.width == 0 || area.height == 0 {
            return;
        }
        let search_height = u16::from(self.state.search.open).saturating_mul(2);
        let status_y = area.y + area.height.saturating_sub(1);
        let content_height = area.height.saturating_sub(1 + search_height);
        let width = usize::from(area.width.saturating_sub(1));
        let mut row = 0_u16;
        for (index, round) in self
            .state
            .transcript
            .rounds()
            .iter()
            .enumerate()
            .skip(self.state.transcript.scroll)
        {
            if row >= content_height {
                break;
            }
            let marker = if index == self.state.transcript.current {
                ">"
            } else {
                " "
            };
            let expansion = if round.is_tool_round() {
                if round.expanded { "v" } else { ">" }
            } else {
                " "
            };
            let color = if round.summary().contains("错误") || round.summary().contains("error") {
                Color::Red
            } else if round.is_tool_round() {
                Color::Cyan
            } else {
                Color::White
            };
            put_line(
                buffer,
                area.x,
                area.y + row,
                &format!("{marker}{expansion} {}", round.summary()),
                width,
                Style::default().fg(color),
            );
            row += 1;
            if round.expanded {
                for detail in round.detail_lines() {
                    if row >= content_height {
                        break;
                    }
                    put_line(
                        buffer,
                        area.x,
                        area.y + row,
                        &format!("   {detail}"),
                        width,
                        Style::default().fg(Color::DarkGray),
                    );
                    row += 1;
                }
            }
        }
        if let Some(preview) = &self.state.transcript.streaming_preview
            && row < content_height
        {
            put_line(
                buffer,
                area.x,
                area.y + row,
                &format!("~ {preview}"),
                width,
                Style::default().fg(Color::Yellow),
            );
        }
        render_scrollbar(
            area,
            buffer,
            self.state.transcript.cached_rounds(),
            self.state.transcript.current,
        );
        let status = self
            .state
            .disconnected
            .as_deref()
            .unwrap_or(&self.state.transcript.status);
        put_line(
            buffer,
            area.x,
            status_y,
            &format!("{status}  |  {}", self.state.footer_status()),
            usize::from(area.width),
            Style::default().fg(if self.state.disconnected.is_some() {
                Color::Red
            } else {
                Color::DarkGray
            }),
        );
        if self.state.search.open {
            let query_y = status_y.saturating_sub(2);
            let result_y = status_y.saturating_sub(1);
            put_line(
                buffer,
                area.x,
                query_y,
                &format!("搜索: {}", self.state.search.query),
                usize::from(area.width),
                Style::default().fg(Color::Yellow),
            );
            let result = self
                .state
                .search
                .hits
                .get(self.state.search.selected)
                .map(|hit| format!("{} {}", hit.kind, hit.snippet))
                .unwrap_or_else(|| self.state.search.status.clone());
            put_line(
                buffer,
                area.x,
                result_y,
                &result,
                usize::from(area.width),
                Style::default().fg(Color::DarkGray),
            );
        }
    }
}

pub struct ComposerView<'a> {
    state: &'a AppState,
}

impl<'a> ComposerView<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }
}

impl Widget for ComposerView<'_> {
    fn render(self, area: Rect, buffer: &mut Buffer) {
        if area.width == 0 || area.height == 0 {
            return;
        }
        let width = usize::from(area.width);
        put_line(
            buffer,
            area.x,
            area.y,
            "─",
            width,
            Style::default().fg(Color::DarkGray),
        );
        let visible_lines = usize::from(area.height.saturating_sub(3)).max(1);
        let start_line = self.state.editor.scroll_line();
        for (line_index, rendered) in self
            .state
            .editor
            .visual_lines_with_cursor(area.width)
            .iter()
            .enumerate()
            .skip(start_line)
            .take(visible_lines)
        {
            put_line(
                buffer,
                area.x,
                area.y + 1 + u16::try_from(line_index - start_line).unwrap_or(0),
                rendered,
                width,
                Style::default().fg(Color::White),
            );
        }
        let tool_line = live_tool_line(&self.state.live_tools, width);
        if !tool_line.is_empty() {
            put_line(
                buffer,
                area.x,
                area.y + area.height.saturating_sub(2),
                &tool_line,
                width,
                Style::default().fg(Color::Cyan),
            );
        }
        let shortcuts = if self.state.is_active_operation() {
            "Enter 引导  Alt+Enter 后续  Esc 停止  Ctrl+O Tool"
        } else {
            "Enter 提交  Shift+Enter 换行  Ctrl+F 搜索  Ctrl+O Tool"
        };
        put_line(
            buffer,
            area.x,
            area.y + area.height.saturating_sub(1),
            shortcuts,
            width,
            Style::default().fg(Color::DarkGray),
        );
    }
}

pub fn transcript_area(state: &AppState, area: Rect) -> Rect {
    Rect::new(
        area.x,
        area.y,
        area.width,
        area.height
            .saturating_sub(state.composer_height(area.height)),
    )
}

pub fn composer_area(state: &AppState, area: Rect) -> Rect {
    let transcript = transcript_area(state, area);
    Rect::new(
        area.x,
        area.y + transcript.height,
        area.width,
        area.height.saturating_sub(transcript.height),
    )
}

fn group_rounds(items: Vec<TranscriptItem>) -> Vec<TranscriptRound> {
    let mut rounds = Vec::new();
    let mut calls = HashMap::<String, usize>::new();
    for item in items {
        if !tool_calls(&item).is_empty() {
            let index = rounds.len();
            let round = TranscriptRound::new(item);
            for call in &round.tool_call_ids {
                calls.insert(call.clone(), index);
            }
            rounds.push(round);
        } else if let TranscriptViewItem::ToolResult { call_id, .. } = &item.view {
            if let Some(index) = calls.get(call_id).copied() {
                rounds[index].push(item);
            } else {
                rounds.push(TranscriptRound::new(item));
            }
        } else {
            rounds.push(TranscriptRound::new(item));
        }
    }
    rounds
}

fn render_scrollbar(area: Rect, buffer: &mut Buffer, total: usize, current: usize) {
    if area.width < 2 || area.height < 3 || total <= 1 {
        return;
    }
    let track = area.height.saturating_sub(1);
    let position = ((current as f64 / (total.saturating_sub(1)) as f64)
        * f64::from(track.saturating_sub(1))) as u16;
    for offset in 0..track {
        buffer.set_string(
            area.x + area.width - 1,
            area.y + offset,
            if offset == position { "#" } else { "|" },
            Style::default().fg(Color::DarkGray),
        );
    }
}

fn live_tool_line(tools: &BTreeMap<String, LiveTool>, width: usize) -> String {
    let mut line = String::new();
    let mut hidden = 0;
    for tool in tools.values() {
        let item = format!("Tool {} {} {}", tool.name, tool.status, tool.summary);
        let separator = if line.is_empty() { "" } else { " | " };
        let candidate = line.clone() + separator + &item;
        if UnicodeWidthStr::width(candidate.as_str()) <= width {
            line.push_str(separator);
            line.push_str(&item);
        } else {
            hidden += 1;
        }
    }
    if hidden > 0 {
        let more = format!(" +{hidden}");
        while !line.is_empty() && UnicodeWidthStr::width((line.clone() + &more).as_str()) > width {
            line.pop();
        }
        line.push_str(&more);
    }
    line
}
fn put_line(buffer: &mut Buffer, x: u16, y: u16, text: &str, width: usize, style: Style) {
    buffer.set_string(x, y, truncate_graphemes(text, width), style);
}

pub fn truncate_graphemes(input: &str, width: usize) -> String {
    let mut output = String::new();
    let mut used = 0;
    for grapheme in input.graphemes(true) {
        let next = UnicodeWidthStr::width(grapheme);
        if used + next > width {
            break;
        }
        output.push_str(grapheme);
        used += next;
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    fn user(id: &str, text: &str) -> TranscriptItem {
        TranscriptItem {
            entry_id: id.to_owned(),
            timestamp: String::new(),
            view: TranscriptViewItem::User {
                text: text.to_owned(),
            },
        }
    }
    #[test]
    fn pairs_every_tool_call_on_page_boundaries() {
        let call = TranscriptItem {
            entry_id: "call".to_owned(),
            timestamp: String::new(),
            view: TranscriptViewItem::ToolCall {
                calls: vec![
                    ToolCall {
                        id: "one".to_owned(),
                        name: "read".to_owned(),
                        summary: "a".to_owned(),
                        href: None,
                    },
                    ToolCall {
                        id: "two".to_owned(),
                        name: "grep".to_owned(),
                        summary: "b".to_owned(),
                        href: None,
                    },
                ],
            },
        };
        let result = |id: &str, call_id: &str| TranscriptItem {
            entry_id: id.to_owned(),
            timestamp: String::new(),
            view: TranscriptViewItem::ToolResult {
                call_id: call_id.to_owned(),
                name: "Tool".to_owned(),
                status: "success".to_owned(),
                summary: "done".to_owned(),
                detail: None,
                content_ref: None,
            },
        };
        let mut window = TranscriptWindow::default();
        window.replace_page(vec![call], "g".to_owned(), 1, None);
        assert!(window.append_committed("g", 1, 2, vec![result("r1", "one"), result("r2", "two")]));
        assert_eq!(window.rounds()[0].items.len(), 3);
    }
    #[test]
    fn clears_stream_and_search_on_reload() {
        let mut app = AppState::default();
        app.transcript.streaming_preview = Some("partial".to_owned());
        app.search.pending_jump = Some("old".to_owned());
        app.search.selected = 2;
        app.clear_for_reload("rewrite");
        assert!(app.transcript.streaming_preview.is_none());
        assert!(app.search.pending_jump.is_none());
        assert_eq!(app.search.selected, 0);
    }
    #[test]
    fn bounds_rounds_items_and_bytes() {
        let mut window = TranscriptWindow::default();
        window.replace_page(
            (0..10_000)
                .map(|index| user(&format!("{index}"), &"x".repeat(1024)))
                .collect(),
            "g".to_owned(),
            1,
            Some("older".to_owned()),
        );
        let diagnostics = window.diagnostics();
        assert!(diagnostics.cached_rounds <= ROUND_CACHE_LIMIT);
        assert!(diagnostics.cached_items <= ITEM_CACHE_LIMIT);
        assert!(diagnostics.cached_utf8_bytes <= UTF8_CACHE_LIMIT);
    }
    #[test]
    fn preserves_the_visible_anchor_when_prepending() {
        let mut window = TranscriptWindow::default();
        window.replace_page(
            vec![user("tail-1", "tail-1"), user("tail-2", "tail-2")],
            "g".to_owned(),
            1,
            Some("older".to_owned()),
        );
        window.current = 0;
        window.scroll = 0;
        window.prepend_page(vec![user("old-1", "old-1"), user("old-2", "old-2")], None);
        assert!(window.rounds()[window.current].contains("tail-1"));
        assert!(window.rounds()[window.scroll].contains("tail-1"));
    }

    #[test]
    fn rejects_stale_previous_page_context() {
        let mut window = TranscriptWindow::default();
        window.replace_page(
            vec![user("tail", "tail")],
            "g".to_owned(),
            2,
            Some("older".to_owned()),
        );
        assert!(!window.accepts_previous_page("g", 1, Some("g"), Some(2)));
        assert!(!window.accepts_previous_page("g", 3, Some("g"), Some(2)));
        assert!(window.accepts_previous_page("g", 2, Some("g"), Some(2)));
    }

    #[test]
    fn restores_composer_focus_after_nested_overlays() {
        let mut app = AppState::default();
        app.open_overlay(OverlayState::Detail(DetailOverlay {
            title: "一层".to_owned(),
            lines: vec![],
            scroll: 0,
            status: String::new(),
            link: None,
            copy_text: None,
        }));
        app.open_overlay(OverlayState::Detail(DetailOverlay {
            title: "二层".to_owned(),
            lines: vec![],
            scroll: 0,
            status: String::new(),
            link: None,
            copy_text: None,
        }));
        assert_eq!(app.input_focus, InputFocus::Overlay);
        app.close_overlay();
        assert_eq!(app.input_focus, InputFocus::Overlay);
        app.close_overlay();
        assert_eq!(app.input_focus, InputFocus::Composer);
    }

    #[test]
    fn filters_lists_and_edits_text_without_fake_actions() {
        let mut app = AppState::default();
        app.open_overlay(OverlayState::List(ListOverlay {
            title: "命令面板".to_owned(),
            origin: OverlayOrigin::User,
            items: vec![
                OverlayItem {
                    label: "/help".to_owned(),
                    detail: "帮助".to_owned(),
                    action: "open:help".to_owned(),
                },
                OverlayItem {
                    label: "/doctor".to_owned(),
                    detail: "诊断".to_owned(),
                    action: "open:doctor".to_owned(),
                },
            ],
            selected: 0,
            filter: String::new(),
            status: String::new(),
        }));
        app.overlay_insert("诊");
        assert_eq!(app.current_overlay_action().as_deref(), Some("open:doctor"));
        app.close_overlay();
        app.open_overlay(OverlayState::TextEditor(TextEditorOverlay {
            title: "输入".to_owned(),
            value: "a".to_owned(),
            cursor: 1,
            save_action: "ui:input".to_owned(),
            status: String::new(),
            secret: false,
        }));
        app.overlay_insert("中");
        app.overlay_backspace();
        assert_eq!(app.current_overlay_action().as_deref(), Some("ui:input"));
    }

    #[test]
    fn distinguishes_recovery_sessions_q_exit_from_normal_filtering() {
        let mut app = AppState::default();
        app.open_overlay(OverlayState::List(ListOverlay {
            title: "会话".to_owned(),
            origin: OverlayOrigin::RecoverySession,
            items: vec![],
            selected: 0,
            filter: String::new(),
            status: String::new(),
        }));
        assert!(app.is_recovery_session_chooser());

        app.close_overlay();
        app.open_overlay(OverlayState::List(ListOverlay {
            title: "会话".to_owned(),
            origin: OverlayOrigin::User,
            items: vec![],
            selected: 0,
            filter: String::new(),
            status: String::new(),
        }));
        assert!(!app.is_recovery_session_chooser());
        app.overlay_insert("q");
        assert!(matches!(app.overlay(), Some(OverlayState::List(list)) if list.filter == "q"));
    }

    #[test]
    fn scrolls_detail_and_confirms_ui_request_once() {
        let mut app = AppState::default();
        app.open_overlay(OverlayState::Detail(DetailOverlay {
            title: "详情".to_owned(),
            lines: (0..30).map(|value| value.to_string()).collect(),
            scroll: 0,
            status: String::new(),
            link: None,
            copy_text: None,
        }));
        app.overlay_page(1);
        assert_eq!(
            match app.overlay() {
                Some(OverlayState::Detail(detail)) => detail.scroll,
                _ => 0,
            },
            10
        );
        assert!(app.register_ui_request(UiRequest {
            id: "ui-1".to_owned(),
            kind: UiRequestKind::Confirm
        }));
        assert!(app.take_ui_response().is_some());
        assert!(app.take_ui_response().is_none());
        assert!(!app.register_ui_request(UiRequest {
            id: "ui-1".to_owned(),
            kind: UiRequestKind::Confirm
        }));
    }

    #[test]
    fn restores_session_context_after_a_failed_switch() {
        let mut app = AppState::default();
        app.begin_active_session("/tmp/original.jsonl".to_owned(), "/tmp".to_owned());
        app.lease_id = Some("old-lease".to_owned());
        app.editor.insert("保留的草稿");
        app.open_overlay(OverlayState::Detail(DetailOverlay {
            title: "会话".to_owned(),
            lines: vec!["原有覆盖层".to_owned()],
            scroll: 0,
            status: String::new(),
            link: None,
            copy_text: None,
        }));
        let restore = app.restore_point();
        app.begin_active_session("/tmp/target.jsonl".to_owned(), "/tmp".to_owned());
        app.clear_for_reload("读取目标");
        app.restore_session(restore);
        assert_eq!(app.active_session_path(), Some("/tmp/original.jsonl"));
        assert_eq!(app.lease_id.as_deref(), Some("old-lease"));
        assert_eq!(
            app.editor.visual_lines_with_cursor(80),
            vec!["保留的草稿|".to_owned()]
        );
        assert!(matches!(app.overlay(), Some(OverlayState::Detail(_))));
    }

    #[test]
    fn keeps_tree_actions_on_visible_nodes_after_filtering() {
        let mut app = AppState {
            tree: vec![
                SessionTreeNode {
                    id: "root".to_owned(),
                    parent_id: None,
                    kind: "message".to_owned(),
                    label: Some("根".to_owned()),
                    timestamp: String::new(),
                    preview: "root".to_owned(),
                    is_leaf: false,
                    depth: 0,
                },
                SessionTreeNode {
                    id: "target".to_owned(),
                    parent_id: Some("root".to_owned()),
                    kind: "message".to_owned(),
                    label: Some("目标".to_owned()),
                    timestamp: String::new(),
                    preview: "needle".to_owned(),
                    is_leaf: true,
                    depth: 1,
                },
                SessionTreeNode {
                    id: "other".to_owned(),
                    parent_id: Some("root".to_owned()),
                    kind: "message".to_owned(),
                    label: Some("其他".to_owned()),
                    timestamp: String::new(),
                    preview: "other".to_owned(),
                    is_leaf: true,
                    depth: 1,
                },
            ],
            ..AppState::default()
        };
        app.open_overlay(OverlayState::List(ListOverlay {
            title: "分支树".to_owned(),
            origin: OverlayOrigin::User,
            items: app
                .tree
                .iter()
                .enumerate()
                .map(|(index, node)| OverlayItem {
                    label: node.label.clone().unwrap_or_default(),
                    detail: node.preview.clone(),
                    action: format!("tree:{index}"),
                })
                .collect(),
            selected: 1,
            filter: "needle".to_owned(),
            status: String::new(),
        }));
        assert_eq!(app.tree_visible_indices(), vec![1]);
        assert_eq!(app.current_overlay_action().as_deref(), Some("tree:1"));
        app.select_tree_visible(1, true);
        assert_eq!(app.current_overlay_action().as_deref(), Some("tree:1"));
    }

    #[test]
    fn tracks_transcript_requests_per_view_path_and_generation() {
        let mut app = AppState::default();
        app.begin_active_session("/tmp/active.jsonl".to_owned(), "/tmp".to_owned());
        app.begin_transcript_request(
            "active-1".to_owned(),
            TranscriptViewKind::Active,
            TranscriptRequestKind::Initial,
            "/tmp/active.jsonl".to_owned(),
            app.session_generation,
            None,
        );
        app.readonly_view = Some(ReadonlySessionView {
            path: "/tmp/readonly.jsonl".to_owned(),
            generation: 7,
            ..ReadonlySessionView::default()
        });
        app.begin_transcript_request(
            "readonly-1".to_owned(),
            TranscriptViewKind::Readonly,
            TranscriptRequestKind::Search,
            "/tmp/readonly.jsonl".to_owned(),
            7,
            None,
        );
        app.invalidate_transcript_requests(TranscriptViewKind::Readonly);
        assert!(app.pending_transcript_requests.contains_key("active-1"));
        assert!(!app.pending_transcript_requests.contains_key("readonly-1"));
    }
    #[test]
    fn clears_connection_lease_without_discarding_retryable_request() {
        let mut app = AppState::default();
        app.begin_active_session("/tmp/session.jsonl".to_owned(), "/tmp".to_owned());
        app.lease_id = Some("lease".to_owned());
        app.active_session.as_mut().unwrap().lease_id = Some("lease".to_owned());
        app.begin_request(
            "pending".to_owned(),
            B3Request {
                command: lystar_protocol::B3Command::GetAbout,
                payload: serde_json::Map::new(),
            },
            PendingIntent::Overlay {
                target: "关于".to_owned(),
            },
        );
        app.clear_connection_state("断线");
        assert!(app.lease_id.is_none());
        assert!(app.active_session.as_ref().unwrap().lease_id.is_none());
        assert!(app.pending_requests.contains_key("pending"));
        assert_eq!(app.disconnected.as_deref(), Some("断线"));
    }

    #[test]
    fn invalidates_stale_pending_responses_and_clears_disconnect_state() {
        let mut app = AppState::default();
        let first = app.begin_request(
            "first".to_owned(),
            B3Request {
                command: lystar_protocol::B3Command::GetAbout,
                payload: serde_json::Map::new(),
            },
            PendingIntent::Overlay {
                target: "关于".to_owned(),
            },
        );
        let second = app.begin_request(
            "second".to_owned(),
            B3Request {
                command: lystar_protocol::B3Command::GetDiagnostics,
                payload: serde_json::Map::new(),
            },
            PendingIntent::Overlay {
                target: "诊断".to_owned(),
            },
        );
        assert!(first < second);
        assert_ne!(
            app.take_pending("first").unwrap().generation,
            app.request_generation
        );
        app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
            title: "确认".to_owned(),
            message: String::new(),
            confirm_action: "ui:confirm".to_owned(),
            status: String::new(),
        }));
        app.clear_overlay_transient();
        assert!(app.pending_requests.is_empty());
        assert!(app.overlays.is_empty());
        assert_eq!(app.input_focus, InputFocus::Composer);
    }
}
