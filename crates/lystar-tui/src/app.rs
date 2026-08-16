use std::collections::{BTreeMap, HashMap, VecDeque};

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

    fn summary(&self) -> String {
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

    fn detail_lines(&self) -> Vec<String> {
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

#[derive(Debug, Default)]
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

#[derive(Debug, Default)]
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
    composer_width: u16,
}

impl AppState {
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
}
