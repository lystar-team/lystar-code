use std::{
    fmt,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use lystar_protocol::OperationSnapshot;
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Color, Style},
    widgets::Widget,
};
use sha2::{Digest, Sha256};

use super::transcript::{put_ansi_line, put_line};
use super::{AppState, WORKSPACE_REQUEST_TIMEOUT};
#[derive(Clone, PartialEq, Eq)]
pub struct ComposerAttachment {
    pub id: u64,
    pub name: String,
    pub source: String,
    pub mime_type: String,
    pub byte_length: usize,
    pub content_hash: String,
    pub base64: String,
}

impl fmt::Debug for ComposerAttachment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ComposerAttachment")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("source", &self.source)
            .field("mime_type", &self.mime_type)
            .field("byte_length", &self.byte_length)
            .field("content_hash", &self.content_hash)
            .field("base64", &"[redacted]")
            .finish()
    }
}

#[derive(Clone)]
pub struct PendingCustomEditorSubmit {
    pub command: String,
    pub session_path: String,
    pub session_generation: u64,
    pub editor_component_generation: Option<u64>,
    pub lease_id: String,
    pub client_instance_id: String,
    pub client_request_id: String,
    pub text: String,
    pub submit_revision: u64,
    pub attachments: Vec<ComposerAttachment>,
    pub started_at: Instant,
    pub retry_count: u8,
}

fn short_hash(value: &str) -> String {
    value.chars().take(12).collect()
}

fn draft_debug_fields(
    formatter: &mut fmt::DebugStruct<'_, '_>,
    text: &str,
    attachment_hashes: &[String],
) {
    formatter
        .field("text_bytes", &text.len())
        .field(
            "text_hash",
            &short_hash(&format!("{:x}", Sha256::digest(text.as_bytes()))),
        )
        .field("attachments_count", &attachment_hashes.len())
        .field(
            "attachment_hashes",
            &attachment_hashes
                .iter()
                .map(|hash| short_hash(hash))
                .collect::<Vec<_>>(),
        );
}

impl fmt::Debug for PendingCustomEditorSubmit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let attachment_hashes = self
            .attachments
            .iter()
            .map(|attachment| attachment.content_hash.clone())
            .collect::<Vec<_>>();
        let mut debug = formatter.debug_struct("PendingCustomEditorSubmit");
        draft_debug_fields(&mut debug, &self.text, &attachment_hashes);
        debug.finish()
    }
}

#[derive(Clone)]
pub struct RecoveryDraft {
    pub session_path: String,
    pub session_generation: u64,
    pub editor_component_generation: Option<u64>,
    pub submit_revision: u64,
    text: String,
    submitted_attachment_hashes: Vec<String>,
}

impl RecoveryDraft {
    fn from_submit(submit: PendingCustomEditorSubmit) -> Self {
        Self {
            session_path: submit.session_path,
            session_generation: submit.session_generation,
            editor_component_generation: submit.editor_component_generation,
            submit_revision: submit.submit_revision,
            text: submit.text,
            submitted_attachment_hashes: submit
                .attachments
                .into_iter()
                .map(|attachment| attachment.content_hash)
                .collect(),
        }
    }
}

impl fmt::Debug for RecoveryDraft {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut debug = formatter.debug_struct("RecoveryDraft");
        draft_debug_fields(&mut debug, &self.text, &self.submitted_attachment_hashes);
        debug.finish()
    }
}

#[derive(Clone)]
pub struct PendingAttachmentSubmit {
    pub command: String,
    pub session_path: String,
    pub lease_id: String,
    pub client_instance_id: String,
    pub client_request_id: String,
    pub text: String,
    pub attachments: Vec<ComposerAttachment>,
    pub started_at: Instant,
}

impl fmt::Debug for PendingAttachmentSubmit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingAttachmentSubmit")
            .field("command", &self.command)
            .field("session_path", &self.session_path)
            .field("lease_id", &"[redacted]")
            .field("client_instance_id", &self.client_instance_id)
            .field("client_request_id", &self.client_request_id)
            .field("text", &self.text)
            .field("attachments", &self.attachments)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerCompletionItem {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerCompletion {
    pub text: String,
    pub prefix_start: usize,
    pub prefix_end: usize,
    pub items: Vec<ComposerCompletionItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClipboardReadTarget {
    Insert,
    Overlay,
}

#[derive(Debug, Clone)]
pub struct ClipboardReadState {
    pub generation: u64,
    pub target: ClipboardReadTarget,
    pub text: Option<ClipboardDescriptor>,
    pub image: Option<ComposerAttachment>,
    pub text_done: bool,
    pub image_done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClipboardDescriptor {
    pub capability: bool,
    pub text: Option<String>,
}

impl AppState {
    pub fn add_attachment(&mut self, attachment: ComposerAttachment) -> Result<bool, &'static str> {
        if self
            .attachments
            .iter()
            .any(|item| item.content_hash == attachment.content_hash)
        {
            return Ok(false);
        }
        if self.attachments.len() >= 8 {
            return Err("最多可添加 8 张图片");
        }
        if self
            .attachments
            .iter()
            .map(|item| item.byte_length)
            .sum::<usize>()
            + attachment.byte_length
            > 16 * 1024 * 1024
        {
            return Err("图片总大小不能超过 16 MiB");
        }
        self.attachments.push(attachment);
        Ok(true)
    }

    pub fn new_attachment(
        &mut self,
        name: String,
        source: String,
        mime_type: String,
        byte_length: usize,
        content_hash: String,
        base64: String,
    ) -> ComposerAttachment {
        self.next_attachment_id = self.next_attachment_id.saturating_add(1);
        ComposerAttachment {
            id: self.next_attachment_id,
            name,
            source,
            mime_type,
            byte_length,
            content_hash,
            base64,
        }
    }

    pub fn editor_generation(&self) -> u64 {
        self.editor_generation
    }

    pub fn extension_editor_revision(&self) -> u64 {
        self.extension_ui.revision
    }

    pub fn begin_custom_editor_submit(
        &mut self,
        response_id: String,
        submit: PendingCustomEditorSubmit,
    ) {
        self.pending_custom_editor_submits
            .insert(response_id, submit);
    }

    pub fn timed_out_custom_editor_submit(&self) -> Option<(String, PendingCustomEditorSubmit)> {
        self.pending_custom_editor_submits
            .iter()
            .find(|(_, submit)| submit.started_at.elapsed() >= WORKSPACE_REQUEST_TIMEOUT)
            .map(|(id, submit)| (id.clone(), submit.clone()))
    }

    pub fn restart_timed_out_custom_editor_submit(
        &mut self,
    ) -> Option<(String, PendingCustomEditorSubmit)> {
        let (id, submit) = self.timed_out_custom_editor_submit()?;
        if let Some(pending) = self.pending_custom_editor_submits.get_mut(&id) {
            pending.started_at = Instant::now();
            pending.retry_count = pending.retry_count.saturating_add(1);
        }
        Some((id, submit))
    }

    pub fn recover_exhausted_custom_editor_submit(&mut self) -> bool {
        let Some((id, submit)) = self.timed_out_custom_editor_submit() else {
            return false;
        };
        if submit.retry_count == 0 {
            return false;
        }
        self.pending_custom_editor_submits.remove(&id);
        self.offer_recovery(RecoveryDraft::from_submit(submit));
        true
    }

    pub fn acknowledge_custom_editor_submit(&mut self, request_id: &str, operation_id: String) {
        let Some(submit) = self.pending_custom_editor_submits.remove(request_id) else {
            return;
        };
        if submit.command == "prompt" {
            self.operation = Some(OperationSnapshot {
                operation_id: operation_id.clone(),
                client_instance_id: submit.client_instance_id.clone(),
                client_request_id: submit.client_request_id.clone(),
                session_path: submit.session_path.clone(),
                operation_type: submit.command.clone(),
                status: "accepted".to_owned(),
                progress: None,
                error: None,
            });
        }
        self.accepted_custom_editor_submits
            .insert(operation_id, RecoveryDraft::from_submit(submit));
    }

    pub fn reject_custom_editor_submit(&mut self, request_id: &str) {
        let Some(submit) = self.pending_custom_editor_submits.remove(request_id) else {
            return;
        };
        self.offer_recovery(RecoveryDraft::from_submit(submit));
    }

    pub fn settle_custom_editor_operation(&mut self, operation_id: &str, status: &str) {
        if status == "failed" {
            if let Some(draft) = self.accepted_custom_editor_submits.remove(operation_id) {
                self.offer_recovery(draft);
            }
        } else if status == "completed" {
            if let Some(draft) = self.accepted_custom_editor_submits.remove(operation_id) {
                self.acknowledge_submitted_attachment_hashes(&draft.submitted_attachment_hashes);
            }
        } else if matches!(status, "aborted" | "interrupted") {
            self.accepted_custom_editor_submits.remove(operation_id);
        }
    }

    fn offer_recovery(&mut self, draft: RecoveryDraft) {
        if self.session_generation != draft.session_generation
            || self.active_session_path() != Some(draft.session_path.as_str())
        {
            return;
        }
        let editor_matches = match (
            draft.editor_component_generation,
            self.active_extension_editor(),
        ) {
            (Some(expected), Some(current)) => current.generation == expected,
            (Some(_), None) => true,
            (None, None) => true,
            (None, Some(_)) => false,
        };
        if editor_matches
            && self.extension_editor_revision() == draft.submit_revision
            && self.editor.is_empty()
        {
            self.editor.replace(&draft.text);
            self.synced_editor_text.clear();
            self.synced_editor_cursor = usize::MAX;
            self.set_toast("提交失败，草稿已恢复");
            return;
        }
        self.recovery_draft = Some(draft);
        self.set_toast("提交失败，按 Ctrl+R 打开恢复草稿");
    }

    pub fn recovery_attachment_counts(&self) -> Option<(usize, usize)> {
        let draft = self.recovery_draft.as_ref()?;
        let missing = draft
            .submitted_attachment_hashes
            .iter()
            .filter(|hash| self.attachment_by_hash(hash).is_none())
            .count();
        Some((draft.submitted_attachment_hashes.len(), missing))
    }

    pub fn append_recovery_draft(&mut self) -> bool {
        let Some(draft) = self.recovery_draft.take() else {
            return false;
        };
        self.editor.insert("\n");
        self.editor.insert(&draft.text);
        self.synced_editor_text.clear();
        self.synced_editor_cursor = usize::MAX;
        true
    }

    pub fn replace_with_recovery_draft(&mut self) -> bool {
        let Some(draft) = self.recovery_draft.take() else {
            return false;
        };
        self.editor.replace(&draft.text);
        self.synced_editor_text.clear();
        self.synced_editor_cursor = usize::MAX;
        true
    }

    pub fn recovery_draft_text(&self) -> Option<&str> {
        self.recovery_draft
            .as_ref()
            .map(|draft| draft.text.as_str())
    }

    pub fn discard_recovery_draft(&mut self) -> bool {
        self.recovery_draft.take().is_some()
    }

    pub(super) fn clear_custom_editor_drafts(&mut self) {
        self.pending_custom_editor_submits.clear();
        self.accepted_custom_editor_submits.clear();
        self.recovery_draft = None;
    }

    pub fn begin_attachment_submit(
        &mut self,
        response_id: String,
        submit: PendingAttachmentSubmit,
    ) {
        self.pending_attachment_submits.insert(response_id, submit);
    }

    pub fn timed_out_attachment_submit(&self) -> Option<(String, PendingAttachmentSubmit)> {
        self.pending_attachment_submits
            .iter()
            .find(|(_, submit)| submit.started_at.elapsed() >= WORKSPACE_REQUEST_TIMEOUT)
            .map(|(id, submit)| (id.clone(), submit.clone()))
    }

    pub fn restart_timed_out_attachment_submit(
        &mut self,
    ) -> Option<(String, PendingAttachmentSubmit)> {
        let (id, submit) = self.timed_out_attachment_submit()?;
        if let Some(pending) = self.pending_attachment_submits.get_mut(&id) {
            pending.started_at = Instant::now();
        }
        Some((id, submit))
    }

    pub fn begin_clipboard_read(&mut self, target: ClipboardReadTarget) -> u64 {
        self.clipboard_read_generation = self.clipboard_read_generation.saturating_add(1);
        let generation = self.clipboard_read_generation;
        self.clipboard_read = Some(ClipboardReadState {
            generation,
            target,
            text: None,
            image: None,
            text_done: false,
            image_done: false,
        });
        generation
    }

    pub fn attachment_by_hash(&self, content_hash: &str) -> Option<&ComposerAttachment> {
        self.attachments
            .iter()
            .find(|attachment| attachment.content_hash == content_hash)
    }

    pub fn remove_attachment(&mut self, index: usize) -> bool {
        if index >= self.attachments.len() {
            return false;
        }
        let attachment = self.attachments.remove(index);
        if self.attachment_preview.as_deref() == Some(attachment.content_hash.as_str()) {
            self.attachment_preview = None;
        }
        true
    }

    pub fn clear_attachments(&mut self) {
        self.attachments.clear();
        self.attachment_preview = None;
    }

    pub fn attachment_summary(&self, compact: bool) -> Option<String> {
        (!self.attachments.is_empty()).then(|| {
            if compact {
                return format!("图片 {}", self.attachments.len());
            }
            let names = self
                .attachments
                .iter()
                .take(2)
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            let more = self.attachments.len().saturating_sub(2);
            format!(
                "图片 {}: {}{}",
                self.attachments.len(),
                names,
                if more > 0 {
                    format!(" +{more}")
                } else {
                    String::new()
                }
            )
        })
    }

    fn acknowledge_submitted_attachment_hashes(&mut self, submitted_hashes: &[String]) {
        self.attachments
            .retain(|attachment| !submitted_hashes.contains(&attachment.content_hash));
        if self
            .attachment_preview
            .as_deref()
            .is_some_and(|hash| self.attachment_by_hash(hash).is_none())
        {
            self.attachment_preview = None;
        }
    }

    fn acknowledge_submitted_attachments(&mut self, submitted: &[ComposerAttachment]) {
        self.attachments.retain(|attachment| {
            !submitted.iter().any(|frozen| {
                frozen.id == attachment.id && frozen.content_hash == attachment.content_hash
            })
        });
        if self
            .attachment_preview
            .as_deref()
            .is_some_and(|hash| self.attachment_by_hash(hash).is_none())
        {
            self.attachment_preview = None;
        }
    }

    pub fn acknowledge_attachment_submit(&mut self, request_id: &str) {
        let Some(submit) = self.pending_attachment_submits.remove(request_id) else {
            return;
        };
        self.acknowledge_submitted_attachments(&submit.attachments);
    }

    pub fn reject_attachment_submit(&mut self, request_id: &str) {
        self.pending_attachment_submits.remove(request_id);
    }
}

pub struct ComposerView<'a> {
    state: &'a AppState,
    widget_budget: usize,
}

impl<'a> ComposerView<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self::with_widget_budget(state, 0)
    }

    pub fn with_widget_budget(state: &'a AppState, widget_budget: usize) -> Self {
        Self {
            state,
            widget_budget,
        }
    }
}

impl Widget for ComposerView<'_> {
    fn render(self, area: Rect, buffer: &mut Buffer) {
        if area.width == 0 || area.height == 0 {
            return;
        }
        let width = usize::from(area.width);
        let (above_lines, below_lines, hidden_lines) =
            self.state.extension_widget_lines(self.widget_budget);
        let mut row = area.y;
        for line in above_lines {
            put_ansi_line(buffer, area.x, row, line, width);
            row = row.saturating_add(1);
        }
        put_line(
            buffer,
            area.x,
            row,
            "─",
            width,
            Style::default().fg(Color::DarkGray),
        );
        row = row.saturating_add(1);
        let reserved = u16::try_from(
            below_lines
                .len()
                .saturating_add(usize::from(hidden_lines > 0)),
        )
        .unwrap_or(u16::MAX)
        .saturating_add(2);
        let visible_lines = usize::from(
            area.y
                .saturating_add(area.height)
                .saturating_sub(row)
                .saturating_sub(reserved),
        )
        .max(1);
        let editor_lines = self
            .state
            .active_extension_editor()
            .map(|component| component.lines.clone())
            .unwrap_or_else(|| {
                self.state
                    .editor
                    .visual_lines_with_cursor(area.width)
                    .into_iter()
                    .skip(self.state.editor.scroll_line())
                    .collect()
            });
        for (line_index, rendered) in editor_lines.iter().enumerate().take(visible_lines) {
            let target_row = row + u16::try_from(line_index).unwrap_or(0);
            if self.state.active_extension_editor().is_some() {
                put_ansi_line(buffer, area.x, target_row, rendered, width);
            } else {
                put_line(
                    buffer,
                    area.x,
                    target_row,
                    rendered,
                    width,
                    Style::default().fg(Color::White),
                );
            }
        }
        row = row.saturating_add(u16::try_from(visible_lines).unwrap_or(u16::MAX));
        let status_y = area.y + area.height.saturating_sub(2);
        for line in below_lines {
            if row >= status_y {
                break;
            }
            put_ansi_line(buffer, area.x, row, line, width);
            row = row.saturating_add(1);
        }
        if hidden_lines > 0 && row < status_y {
            put_line(
                buffer,
                area.x,
                row,
                &format!("… 还有 {hidden_lines} 行小部件内容"),
                width,
                Style::default().fg(Color::DarkGray),
            );
        }
        let attachment_line = self.state.attachment_summary(area.height <= 4);
        let working = if self.state.is_active_operation() && self.state.extension_ui.working_visible
        {
            let frames = &self.state.extension_ui.working_frames;
            let frame = if frames.is_empty() {
                ""
            } else {
                let elapsed = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                &frames[((elapsed / self.state.extension_ui.working_interval_ms.max(16)) as usize)
                    % frames.len()]
            };
            Some(format!(
                "{frame} {}",
                self.state
                    .extension_ui
                    .working_message
                    .as_deref()
                    .unwrap_or("运行中")
            ))
        } else {
            None
        };
        let status_line = attachment_line.or(working).unwrap_or_default();
        if !status_line.is_empty() {
            put_line(
                buffer,
                area.x,
                status_y,
                &status_line,
                width,
                Style::default().fg(Color::Cyan),
            );
        }
        let shortcuts = if self.state.is_active_operation() {
            "Enter 引导  Alt+Enter 后续  Esc 停止  Ctrl+O Tool"
        } else if self.state.recovery_draft.is_some() {
            "Enter 提交  Ctrl+R 打开恢复草稿  Ctrl+F 搜索  Ctrl+O Tool"
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
