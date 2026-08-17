use std::collections::{HashMap, VecDeque};

use lystar_protocol::{ToolCall, TranscriptItem, TranscriptViewItem};
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Style},
    widgets::Widget,
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::{
    image::image_placeholder,
    rich_text::{RenderedRichText, RichTextKey, parse_ansi_lines},
};

use super::{AppState, ITEM_CACHE_LIMIT, ROUND_CACHE_LIMIT, UTF8_CACHE_LIMIT, VisibleLink};

const OLDER_PAGE_THRESHOLD: usize = 2;
#[derive(Debug, Clone)]
pub struct ImageDescriptor {
    pub content_ref: String,
    pub mime_type: String,
    pub byte_length: u64,
    pub alt: Option<String>,
}

#[derive(Debug)]
pub struct ImagePendingRequest {
    pub content_ref: String,
    pub generation: u64,
}

#[derive(Debug)]
pub struct RichTextPendingRequest {
    pub key: RichTextKey,
    pub generation: u64,
}

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

    pub fn is_tool_round(&self) -> bool {
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
                .map(|call| {
                    if call.name == "subagent" {
                        format!("Subagent {}  Ctrl+O 打开工作台", call.summary)
                    } else {
                        format!("Tool {} {}", call.name, call.summary)
                    }
                })
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
        TranscriptViewItem::User { text, .. } => format!("用户  {text}"),
        TranscriptViewItem::Assistant { text, .. } => format!("助手  {text}"),
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

pub fn transcript_images(item: &TranscriptItem) -> Vec<ImageDescriptor> {
    let images = match &item.view {
        TranscriptViewItem::User { images, .. }
        | TranscriptViewItem::Assistant { images, .. }
        | TranscriptViewItem::ToolResult { images, .. } => images.as_deref().unwrap_or_default(),
        _ => &[],
    };
    images
        .iter()
        .map(|image| ImageDescriptor {
            content_ref: image.content_ref.clone(),
            mime_type: image.mime_type.clone(),
            byte_length: image.byte_length,
            alt: image.alt.clone(),
        })
        .collect()
}

pub(super) fn rich_text_source(item: &TranscriptItem) -> Option<(&'static str, &str)> {
    match &item.view {
        TranscriptViewItem::User { text, .. } => Some(("user", text)),
        TranscriptViewItem::Assistant { text, .. } => Some(("assistant", text)),
        TranscriptViewItem::Custom { text } | TranscriptViewItem::Bash { text } => {
            Some(("custom", text))
        }
        TranscriptViewItem::Summary { text, .. } => Some(("summary", text)),
        TranscriptViewItem::ToolResult {
            detail: Some(text), ..
        } => Some(("custom", text)),
        TranscriptViewItem::Thinking { text } => Some(("assistant", text)),
        TranscriptViewItem::System { text } => Some(("custom", text)),
        TranscriptViewItem::ToolCall { .. }
        | TranscriptViewItem::ToolResult { detail: None, .. } => None,
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

    pub fn current_tool_is_subagent(&self) -> bool {
        self.rounds.get(self.current).is_some_and(|round| {
            round
                .items
                .iter()
                .flat_map(tool_calls)
                .any(|call| call.name == "subagent")
        })
    }

    pub fn selected_summary(&self) -> Option<String> {
        self.rounds.get(self.current).map(TranscriptRound::summary)
    }

    pub fn last_assistant_text(&self) -> Option<String> {
        self.rounds
            .iter()
            .rev()
            .flat_map(|round| round.items.iter().rev())
            .find_map(|item| match &item.view {
                TranscriptViewItem::Assistant { text, .. } => Some(text.clone()),
                _ => None,
            })
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
    pub(super) fn clear_transient(&mut self) {
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

pub struct TranscriptView<'a> {
    state: &'a AppState,
}
impl<'a> TranscriptView<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    fn rendered_round(&self, round: &TranscriptRound, width: u16) -> Option<&RenderedRichText> {
        if round.is_tool_round() {
            return None;
        }
        let item = round.items.first()?;
        let streaming = matches!(item.view, TranscriptViewItem::Assistant { .. })
            && self.state.is_active_operation();
        let (key, _, _) = AppState::rich_text_key(item, width, streaming)?;
        self.state.rich_text_for(&key)
    }

    pub fn visible_link(&self, area: Rect) -> Option<VisibleLink> {
        let search_height = u16::from(self.state.search.open).saturating_mul(2);
        let content_height = area.height.saturating_sub(1 + search_height);
        let width = usize::from(area.width.saturating_sub(1));
        let rich_width = area.width.saturating_sub(3);
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
            if !round.is_tool_round()
                && index == self.state.transcript.current
                && let Some(rendered) = self.rendered_round(round, rich_width)
            {
                for rich_line in &rendered.lines {
                    if let Some(span) = rich_line.spans.iter().find(|span| span.href.is_some()) {
                        let label = truncate_graphemes(&span.text, usize::from(rich_width));
                        if !label.is_empty() {
                            return Some(VisibleLink {
                                column: area.x + 2,
                                row: area.y + row,
                                label,
                                href: span.href.clone().unwrap_or_default(),
                            });
                        }
                    }
                    row = row.saturating_add(1);
                }
                continue;
            }
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
            row = row.saturating_add(
                self.rendered_round(round, rich_width)
                    .map_or(1, |rendered| {
                        u16::try_from(rendered.lines.len().max(1)).unwrap_or(u16::MAX)
                    }),
            );
            row = row.saturating_add(
                u16::try_from(
                    round
                        .items
                        .iter()
                        .map(transcript_images)
                        .map(|images| images.len() * 3)
                        .sum::<usize>(),
                )
                .unwrap_or(u16::MAX),
            );
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
        let header_lines = self
            .state
            .extension_header_lines(usize::from(area.height.saturating_sub(1 + search_height)));
        let header_height = u16::try_from(header_lines.len()).unwrap_or(u16::MAX);
        for (index, line) in header_lines.iter().enumerate() {
            put_ansi_line(
                buffer,
                area.x,
                area.y + u16::try_from(index).unwrap_or(u16::MAX),
                line,
                usize::from(area.width),
            );
        }
        let content_y = area.y.saturating_add(header_height);
        let content_height = area
            .height
            .saturating_sub(1 + search_height)
            .saturating_sub(header_height);
        let width = usize::from(area.width.saturating_sub(1));
        let rich_width = area.width.saturating_sub(3);
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
            if let Some(rendered) = self.rendered_round(round, rich_width) {
                for (line_index, line) in rendered.lines.iter().enumerate() {
                    if row >= content_height {
                        break;
                    }
                    let prefix = if line_index == 0 {
                        format!("{marker}{expansion} ")
                    } else {
                        "  ".to_owned()
                    };
                    put_line(
                        buffer,
                        area.x,
                        content_y + row,
                        &prefix,
                        width,
                        Style::default().fg(color),
                    );
                    put_rich_line(
                        buffer,
                        area.x + 2,
                        content_y + row,
                        line,
                        usize::from(rich_width),
                    );
                    row += 1;
                }
            } else {
                put_line(
                    buffer,
                    area.x,
                    content_y + row,
                    &format!("{marker}{expansion} {}", round.summary()),
                    width,
                    Style::default().fg(color),
                );
                row += 1;
            }
            for image in round.items.iter().flat_map(transcript_images) {
                for placeholder_row in 0..3 {
                    if row >= content_height {
                        break;
                    }
                    let value = if placeholder_row == 0 {
                        image_placeholder(&image.mime_type, image.byte_length)
                    } else {
                        String::new()
                    };
                    put_line(
                        buffer,
                        area.x + 2,
                        content_y + row,
                        &value,
                        usize::from(rich_width),
                        Style::default().fg(Color::DarkGray),
                    );
                    row += 1;
                }
            }
            if round.expanded {
                for detail in round.detail_lines() {
                    if row >= content_height {
                        break;
                    }
                    put_line(
                        buffer,
                        area.x,
                        content_y + row,
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
                content_y + row,
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

pub(super) fn put_rich_line(
    buffer: &mut Buffer,
    x: u16,
    y: u16,
    line: &crate::rich_text::RichLine,
    width: usize,
) {
    let mut used = 0;
    for span in &line.spans {
        if used >= width {
            break;
        }
        let text = truncate_graphemes(
            &sanitize_render_text(&span.text),
            width.saturating_sub(used),
        );
        let text_width = UnicodeWidthStr::width(text.as_str());
        buffer.set_string(
            x.saturating_add(u16::try_from(used).unwrap_or(u16::MAX)),
            y,
            text,
            span.style,
        );
        used = used.saturating_add(text_width);
    }
}

fn sanitize_render_text(text: &str) -> String {
    text.chars()
        .filter(|character| !character.is_control())
        .collect()
}

pub(super) fn put_ansi_line(buffer: &mut Buffer, x: u16, y: u16, text: &str, width: usize) {
    let rendered = parse_ansi_lines(&[text.to_owned()]);
    if let Some(line) = rendered.lines.first() {
        put_rich_line(buffer, x, y, line, width);
    }
}

pub(super) fn put_line(
    buffer: &mut Buffer,
    x: u16,
    y: u16,
    text: &str,
    width: usize,
    style: Style,
) {
    let text = sanitize_render_text(text);
    buffer.set_string(x, y, truncate_graphemes(&text, width), style);
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
