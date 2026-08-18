use std::time::Instant;

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Style},
    widgets::Widget,
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use super::transcript::{put_line, truncate_graphemes};
use super::{
    AppState, InputFocus, ModelDescriptor, PendingIntent, PendingRequest, SettingDescriptor,
    TranscriptViewKind, UiRequest, WORKSPACE_REQUEST_TIMEOUT, WorkspaceOverlayGeneration,
    WorkspaceRequest,
};
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

impl AppState {
    pub fn open_overlay(&mut self, overlay: OverlayState) {
        if self.overlays.is_empty() {
            self.focus_before_overlay = Some(self.input_focus);
            self.input_focus = InputFocus::Overlay;
        }
        self.overlay_error = None;
        self.overlays.push(overlay);
        self.workspace_overlay_stack.push(None);
    }

    pub fn open_workspace_overlay(&mut self, key: impl Into<String>, overlay: OverlayState) {
        let key = key.into();
        let generation = self.workspace_generations.entry(key.clone()).or_default();
        *generation = generation.saturating_add(1);
        let workspace = WorkspaceOverlayGeneration {
            key,
            generation: *generation,
        };
        self.open_overlay(overlay);
        if let Some(slot) = self.workspace_overlay_stack.last_mut() {
            *slot = Some(workspace);
        }
    }

    pub fn replace_workspace_overlay(&mut self, key: impl Into<String>, overlay: OverlayState) {
        let key = key.into();
        let generation = self.workspace_generations.entry(key.clone()).or_default();
        *generation = generation.saturating_add(1);
        let workspace = WorkspaceOverlayGeneration {
            key,
            generation: *generation,
        };
        if self.overlays.is_empty() {
            self.open_workspace_overlay(workspace.key, overlay);
            return;
        }
        self.replace_overlay(overlay);
        if let Some(slot) = self.workspace_overlay_stack.last_mut() {
            *slot = Some(workspace);
        }
    }

    pub fn close_overlay(&mut self) -> bool {
        if self.overlays.pop().is_none() {
            return false;
        }
        self.workspace_overlay_stack.pop();
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
        self.attachment_preview = None;
        self.composer_completion = None;
        self.clipboard_read = None;
        self.overlays.clear();
        self.workspace_overlay_stack.clear();
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

    pub fn begin_request(&mut self, id: String, request: WorkspaceRequest, intent: PendingIntent) {
        let workspace = self.workspace_overlay_stack.last().cloned().flatten();
        self.pending_requests.insert(
            id,
            PendingRequest {
                intent,
                workspace,
                request,
                started_at: Instant::now(),
            },
        );
    }

    pub fn pending_workspace_is_current(&self, pending: &PendingRequest) -> bool {
        let Some(expected) = &pending.workspace else {
            return true;
        };
        self.workspace_overlay_stack.last().and_then(Option::as_ref) == Some(expected)
    }

    pub fn take_pending(&mut self, id: &str) -> Option<PendingRequest> {
        let pending = self.pending_requests.remove(id)?;
        if matches!(
            pending.intent,
            PendingIntent::SkillMutation { .. }
                | PendingIntent::TrustMutation
                | PendingIntent::InstructionMutation { .. }
                | PendingIntent::PackageMutation { .. }
                | PendingIntent::SettingMutation { .. }
                | PendingIntent::SessionMutation { .. }
                | PendingIntent::TreeMutation { .. }
                | PendingIntent::TreeNavigate { .. }
                | PendingIntent::AuthMutation { .. }
                | PendingIntent::SubagentMutation { .. }
                | PendingIntent::ClipboardMutation { .. }
                | PendingIntent::Export
        ) {
            self.write_pending = false;
        }
        Some(pending)
    }

    pub fn timed_out_workspace_request(&self) -> Option<(String, WorkspaceRequest)> {
        self.pending_requests.iter().find_map(|(id, pending)| {
            (pending.started_at.elapsed() >= WORKSPACE_REQUEST_TIMEOUT)
                .then(|| (id.clone(), pending.request.clone()))
        })
    }

    pub fn invalidate_pending(&mut self) {
        self.pending_requests.clear();
        self.pending_transcript_requests.clear();
        self.pending_editor_replace = None;
        self.write_pending = false;
    }

    pub fn restart_timed_out_workspace_request(&mut self) -> Option<(String, WorkspaceRequest)> {
        let (id, request) = self.timed_out_workspace_request()?;
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
            || !self.pending_custom_editor_submits.is_empty()
            || !self.pending_attachment_submits.is_empty()
            || self.is_active_operation()
    }

    pub fn overlay_copy_text(&self) -> Option<String> {
        match self.overlay() {
            Some(OverlayState::Detail(detail)) => detail.copy_text.clone(),
            Some(OverlayState::List(list)) => list
                .items
                .get(list.selected)
                .map(|item| format!("{}  {}", item.label, item.detail)),
            _ => None,
        }
    }

    pub fn context_copy_text(&self) -> Option<String> {
        self.readonly_view
            .as_ref()
            .and_then(|view| view.transcript.selected_summary())
            .or_else(|| self.transcript.selected_summary())
            .or_else(|| self.transcript.last_assistant_text())
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
        if self.recover_exhausted_custom_editor_submit() {
            self.set_overlay_error("提交超时，已保留恢复草稿");
            return;
        }
        if self.timed_out_workspace_request().is_some()
            || self.timed_out_custom_editor_submit().is_some()
            || self.timed_out_attachment_submit().is_some()
        {
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

    pub fn overlay_move_left(&mut self) {
        if let Some(OverlayState::TextEditor(editor)) = self.overlay_mut()
            && editor.cursor > 0
        {
            let mut cursor = editor.cursor - 1;
            while !editor.value.is_char_boundary(cursor) {
                cursor -= 1;
            }
            editor.cursor = cursor;
        }
    }

    pub fn overlay_move_right(&mut self) {
        if let Some(OverlayState::TextEditor(editor)) = self.overlay_mut()
            && editor.cursor < editor.value.len()
        {
            let mut cursor = editor.cursor + 1;
            while cursor < editor.value.len() && !editor.value.is_char_boundary(cursor) {
                cursor += 1;
            }
            editor.cursor = cursor;
        }
    }

    pub fn overlay_insert_newline(&mut self) {
        if matches!(self.overlay(), Some(OverlayState::TextEditor(_))) {
            self.overlay_insert("\n");
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
