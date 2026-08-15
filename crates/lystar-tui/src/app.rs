use std::collections::{HashMap, VecDeque};

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Style},
    widgets::Widget,
};
use serde_json::Value;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

pub const ROUND_CACHE_LIMIT: usize = 400;
const OLDER_PAGE_THRESHOLD: usize = 2;

#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptItem {
    pub entry_id: String,
    pub kind: String,
    pub timestamp: String,
    pub payload: Value,
}

impl TranscriptItem {
    pub fn from_value(value: &Value) -> Option<Self> {
        Some(Self {
            entry_id: value.get("entryId")?.as_str()?.to_owned(),
            kind: value.get("kind")?.as_str()?.to_owned(),
            timestamp: value.get("timestamp")?.as_str()?.to_owned(),
            payload: value.get("payload")?.clone(),
        })
    }

    fn role(&self) -> Option<&str> {
        self.payload.get("message")?.get("role")?.as_str()
    }

    fn tool_call_ids(&self) -> Vec<String> {
        self.payload
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("toolCall"))
            .filter_map(|part| part.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect()
    }

    fn tool_result_id(&self) -> Option<&str> {
        self.payload.get("message")?.get("toolCallId")?.as_str()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptRound {
    pub entry_ids: Vec<String>,
    pub items: Vec<TranscriptItem>,
    pub tool_call_ids: Vec<String>,
    pub expanded: bool,
}

impl TranscriptRound {
    fn new(item: TranscriptItem) -> Self {
        let tool_call_ids = item.tool_call_ids();
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

    fn summary(&self) -> String {
        if self.is_tool_round() {
            let call = self
                .items
                .iter()
                .find_map(tool_call_summary)
                .unwrap_or_default();
            let result = self.items.iter().find_map(tool_result_summary);
            return match result {
                Some(result) => format!("{}  {}", call, result),
                None => format!("{}  运行中", call),
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
            .flat_map(|item| {
                let mut lines = vec![format!("{} {}", item.kind, item.timestamp)];
                let payload =
                    serde_json::to_string(&item.payload).unwrap_or_else(|_| "{}".to_owned());
                lines.push(payload);
                lines
            })
            .collect()
    }
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
        while self.rounds.len() > ROUND_CACHE_LIMIT {
            self.rounds.pop_front();
        }
        self.generation = Some(generation);
        self.revision = revision;
        self.previous_cursor = previous_cursor;
        self.loading_previous = false;
        self.scroll = self.rounds.len().saturating_sub(1);
        self.current = self.scroll;
        self.status = format!("{} 轮", self.rounds.len());
    }

    pub fn prepend_page(&mut self, items: Vec<TranscriptItem>, previous_cursor: Option<String>) {
        let rounds = group_rounds(items);
        let added = rounds.len();
        for round in rounds.into_iter().rev() {
            self.rounds.push_front(round);
        }
        self.scroll = self.scroll.saturating_add(added);
        self.current = self.current.saturating_add(added);
        while self.rounds.len() > ROUND_CACHE_LIMIT {
            self.rounds.pop_back();
        }
        self.previous_cursor = previous_cursor;
        self.loading_previous = false;
        self.status = format!("已加载更早记录，缓存 {} 轮", self.rounds.len());
    }

    pub fn append_committed(
        &mut self,
        generation: &str,
        from_revision: u64,
        to_revision: u64,
        items: Vec<TranscriptItem>,
    ) -> bool {
        if self.generation.as_deref() != Some(generation) || self.revision != from_revision {
            return false;
        }
        let was_at_tail = self.current.saturating_add(1) >= self.rounds.len();
        for round in group_rounds(items) {
            self.rounds.push_back(round);
        }
        while self.rounds.len() > ROUND_CACHE_LIMIT {
            self.rounds.pop_front();
            self.scroll = self.scroll.saturating_sub(1);
            self.current = self.current.saturating_sub(1);
        }
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

#[derive(Debug, Default)]
pub struct AppState {
    pub transcript: TranscriptWindow,
    pub search: SearchState,
    pub disconnected: Option<String>,
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
        let Some(entry_id) = self.search.pending_jump.clone() else {
            return;
        };
        if self.transcript.jump_to(&entry_id) {
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
                &format!("~ {}", preview),
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
            &format!("只读  |  {status}  |  q 退出"),
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
            let selected = self.state.search.hits.get(self.state.search.selected);
            let result = selected
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
    let mut rounds: Vec<TranscriptRound> = Vec::new();
    let mut calls = HashMap::<String, usize>::new();
    for item in items {
        if !item.tool_call_ids().is_empty() {
            let index = rounds.len();
            let round = TranscriptRound::new(item);
            for call in &round.tool_call_ids {
                calls.insert(call.clone(), index);
            }
            rounds.push(round);
        } else if let Some(call_id) = item.tool_result_id().map(str::to_owned) {
            if let Some(index) = calls.get(&call_id).copied() {
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

fn item_summary(item: &TranscriptItem) -> String {
    match item.role() {
        Some("user") => format!("用户  {}", message_text(item)),
        Some("assistant") => format!("助手  {}", message_text(item)),
        Some("thinking") => format!("思考  {}", message_text(item)),
        Some("toolResult") => tool_result_summary(item).unwrap_or_else(|| "Tool 结果".to_owned()),
        Some(role) => format!("{role}  {}", message_text(item)),
        None if item.kind == "compaction" => "上下文压缩".to_owned(),
        None if item.kind == "branch_summary" => "分支摘要".to_owned(),
        None if item.kind == "custom" || item.kind == "custom_message" => {
            format!("自定义  {}", message_text(item))
        }
        None => format!("{}  {}", item.kind, message_text(item)),
    }
}

fn tool_call_summary(item: &TranscriptItem) -> Option<String> {
    let part = item
        .payload
        .get("message")?
        .get("content")?
        .as_array()?
        .iter()
        .find(|part| part.get("type").and_then(Value::as_str) == Some("toolCall"))?;
    let name = part.get("name").and_then(Value::as_str).unwrap_or("Tool");
    let arguments = part.get("arguments").cloned().unwrap_or(Value::Null);
    Some(format!("Tool {name} {}", compact_value(&arguments)))
}

fn tool_result_summary(item: &TranscriptItem) -> Option<String> {
    let message = item.payload.get("message")?;
    let name = message
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or("Tool");
    let is_error = message
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let content = message
        .get("content")
        .map(compact_value)
        .unwrap_or_default();
    Some(if is_error {
        format!("{name} 错误: {content}")
    } else {
        format!("{name} 完成: {content}")
    })
}

fn message_text(item: &TranscriptItem) -> String {
    item.payload
        .get("message")
        .and_then(|message| message.get("content"))
        .map(compact_value)
        .or_else(|| item.payload.get("text").map(compact_value))
        .unwrap_or_default()
}

fn compact_value(value: &Value) -> String {
    let mut text = match value {
        Value::String(value) => value.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| serde_json::to_string(part).unwrap_or_default())
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => serde_json::to_string(value).unwrap_or_default(),
    };
    if text.contains("content_ref") {
        text = "content_ref 输出".to_owned();
    } else if text.contains("image") {
        text = "图片内容".to_owned();
    } else if text.contains("diff") {
        text = "Diff".to_owned();
    }
    truncate_graphemes(&text, 220)
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

    fn item(id: &str, role: &str, content: Value) -> TranscriptItem {
        TranscriptItem {
            entry_id: id.to_owned(),
            kind: "message".to_owned(),
            timestamp: "2026-08-15T00:00:00Z".to_owned(),
            payload: serde_json::json!({ "message": { "role": role, "content": content } }),
        }
    }

    #[test]
    fn groups_tool_calls_and_results_by_call_id() {
        let mut result = item(
            "result",
            "toolResult",
            serde_json::json!([{ "type": "text", "text": "done" }]),
        );
        result.payload["message"]["toolCallId"] = Value::String("call-1".to_owned());
        result.payload["message"]["toolName"] = Value::String("read".to_owned());
        let rounds = group_rounds(vec![
            item(
                "assistant",
                "assistant",
                serde_json::json!([{ "type": "toolCall", "id": "call-1", "name": "read", "arguments": { "path": "a" } }]),
            ),
            result,
        ]);
        assert_eq!(rounds.len(), 1);
        assert_eq!(rounds[0].items.len(), 2);
        assert!(rounds[0].summary().contains("read"));
    }

    #[test]
    fn bounds_the_round_cache_when_appending_and_prepending() {
        let mut window = TranscriptWindow::default();
        window.replace_page(
            (0..ROUND_CACHE_LIMIT)
                .map(|index| {
                    item(
                        &format!("tail-{index}"),
                        "user",
                        Value::String(index.to_string()),
                    )
                })
                .collect(),
            "generation".to_owned(),
            1,
            Some("older".to_owned()),
        );
        window.prepend_page(
            (0..20)
                .map(|index| {
                    item(
                        &format!("older-{index}"),
                        "user",
                        Value::String(index.to_string()),
                    )
                })
                .collect(),
            None,
        );
        assert_eq!(window.cached_rounds(), ROUND_CACHE_LIMIT);
        assert!(window.rounds().front().unwrap().contains("older-0"));
    }

    #[test]
    fn detects_revision_gaps_and_keeps_streaming_uncommitted() {
        let mut window = TranscriptWindow::default();
        window.replace_page(
            vec![item("a", "user", Value::String("a".to_owned()))],
            "g".to_owned(),
            2,
            None,
        );
        window.streaming_preview = Some("partial".to_owned());
        assert!(!window.append_committed("g", 3, 4, vec![]));
        assert_eq!(window.streaming_preview.as_deref(), Some("partial"));
        assert!(window.append_committed(
            "g",
            2,
            3,
            vec![item("b", "assistant", Value::String("b".to_owned()))]
        ));
        assert_eq!(window.cached_rounds(), 2);
    }

    #[test]
    fn renders_tool_errors_and_content_references_as_stable_summaries() {
        let mut result = item(
            "result",
            "toolResult",
            serde_json::json!([{ "type": "content_ref", "contentRef": "ref" }]),
        );
        result.payload["message"]["toolCallId"] = Value::String("call".to_owned());
        result.payload["message"]["toolName"] = Value::String("bash".to_owned());
        result.payload["message"]["isError"] = Value::Bool(true);
        assert_eq!(
            tool_result_summary(&result).unwrap(),
            "bash 错误: content_ref 输出"
        );
    }

    #[test]
    fn search_state_jumps_from_result_or_requests_older_pages() {
        let mut app = AppState::default();
        app.transcript.replace_page(
            vec![item("tail", "user", Value::String("tail".to_owned()))],
            "g".to_owned(),
            1,
            Some("older".to_owned()),
        );
        app.set_search_results(vec![SearchHit {
            entry_id: "older".to_owned(),
            kind: "message".to_owned(),
            timestamp: String::new(),
            snippet: "older".to_owned(),
        }]);
        assert_eq!(app.select_search_result(), Some("older".to_owned()));
        assert_eq!(app.search.pending_jump.as_deref(), Some("older"));
    }
}
