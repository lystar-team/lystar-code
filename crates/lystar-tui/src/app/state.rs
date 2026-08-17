use std::collections::{HashMap, HashSet};
use std::time::Duration;

use lystar_protocol::{
    OperationSnapshot, SessionProgress, SessionSnapshot, TranscriptItem, TranscriptViewItem,
};
use sha2::{Digest, Sha256};

use crate::{
    editor::EditorState,
    image::ImageCache,
    rich_text::{RenderedRichText, RichTextCache, RichTextKey},
};

use super::live_tools::{LiveToolStatus, LiveTools};
use super::transcript::rich_text_source;
use super::{
    ChangesTab, ClipboardDescriptor, ClipboardReadState, ComposerAttachment, ComposerCompletion,
    ExtensionUiState, GitDiffDescriptor, GitStatusDescriptor, ImagePendingRequest,
    InstructionDescriptor, ListOverlay, ModelDescriptor, OverlayOrigin, OverlayState,
    PackageDescriptor, PendingAttachmentSubmit, PendingComponentInput, PendingCustomEditorSubmit,
    PendingRequest, PendingTerminalInput, ProjectTrustDescriptor, ProviderDescriptor,
    ReadonlySessionView, RecoveryDraft, RichTextPendingRequest, SearchState, SessionSummary,
    SessionTreeNode, SettingDescriptor, SkillDescriptor, SubagentDescriptor,
    TranscriptPendingRequest, TranscriptRequestKind, TranscriptViewKind, TranscriptWindow,
    TreeFilter, UpdateDescriptor, WorkspaceOverlayGeneration,
};
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
    pub live_tools: LiveTools,
    pub assistant_stream: String,
    pub thinking_stream: String,
    pub overlays: Vec<OverlayState>,
    pub workspace_overlay_stack: Vec<Option<WorkspaceOverlayGeneration>>,
    pub workspace_generations: HashMap<String, u64>,
    pub input_focus: InputFocus,
    pub focus_before_overlay: Option<InputFocus>,
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
    pub live_tools: LiveTools,
    pub assistant_stream: String,
    pub thinking_stream: String,
    pub disconnected: Option<String>,
    pub overlays: Vec<OverlayState>,
    pub input_focus: InputFocus,
    pub(super) focus_before_overlay: Option<InputFocus>,
    pub toast: Option<String>,
    pub overlay_error: Option<String>,
    pub subagents: Vec<SubagentDescriptor>,
    pub subagent_parent_path: Option<String>,
    pub clipboard: Option<ClipboardDescriptor>,
    pub attachments: Vec<ComposerAttachment>,
    pub pending_custom_editor_submits: HashMap<String, PendingCustomEditorSubmit>,
    pub(super) accepted_custom_editor_submits: HashMap<String, RecoveryDraft>,
    pub recovery_draft: Option<RecoveryDraft>,
    pub pending_attachment_submits: HashMap<String, PendingAttachmentSubmit>,
    pub attachment_preview: Option<String>,
    pub composer_completion: Option<ComposerCompletion>,
    pub clipboard_read_generation: u64,
    pub clipboard_read: Option<ClipboardReadState>,
    pub(super) next_attachment_id: u64,
    pub subagent_detail: Option<SubagentDescriptor>,
    pub settings: Vec<SettingDescriptor>,
    pub models: Vec<ModelDescriptor>,
    pub providers: Vec<ProviderDescriptor>,
    pub git_status: Option<GitStatusDescriptor>,
    pub changes_tab: ChangesTab,
    pub change_detail: Option<GitDiffDescriptor>,
    pub change_detail_expanded: bool,
    pub skills: Vec<SkillDescriptor>,
    pub trust: Option<ProjectTrustDescriptor>,
    pub project_instructions: Vec<InstructionDescriptor>,
    pub host_instructions: Vec<InstructionDescriptor>,
    pub packages: Vec<PackageDescriptor>,
    pub pending_package_source: Option<String>,
    pub update: Option<UpdateDescriptor>,
    pub write_pending: bool,
    pub pending_editor_replace: Option<String>,
    pub page_load_pending: bool,
    pub pending_requests: HashMap<String, PendingRequest>,
    pub pending_transcript_requests: HashMap<String, TranscriptPendingRequest>,
    pub rich_text_cache: RichTextCache,
    pub pending_rich_text_requests: HashMap<String, RichTextPendingRequest>,
    pub failed_rich_text: HashSet<RichTextKey>,
    pub rich_text_generation: u64,
    pub image_cache: ImageCache,
    pub pending_image_requests: HashMap<String, ImagePendingRequest>,
    pub failed_images: HashSet<String>,
    pub image_generation: u64,
    pub(super) workspace_overlay_stack: Vec<Option<WorkspaceOverlayGeneration>>,
    pub(super) workspace_generations: HashMap<String, u64>,
    pub active_ui_request: Option<UiRequest>,
    pub(super) responded_ui_requests: HashSet<String>,
    pub extension_ui: ExtensionUiState,
    pub pending_terminal_inputs: HashMap<String, PendingTerminalInput>,
    pub pending_component_inputs: HashMap<String, PendingComponentInput>,
    pub(super) editor_generation: u64,
    pub(super) synced_editor_text: String,
    pub(super) synced_editor_cursor: usize,
    pub(super) composer_width: u16,
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
        self.clear_custom_editor_drafts();
        self.clear_transient();
        self.session_generation = self.session_generation.saturating_add(1);
        self.invalidate_transcript_requests(TranscriptViewKind::Active);
        self.invalidate_rich_text();
        self.invalidate_images();
        self.clear_extension_components();
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
            workspace_overlay_stack: self.workspace_overlay_stack.clone(),
            workspace_generations: self.workspace_generations.clone(),
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
        self.workspace_overlay_stack = restore.workspace_overlay_stack;
        self.workspace_generations = restore.workspace_generations;
        self.input_focus = restore.input_focus;
        self.focus_before_overlay = restore.focus_before_overlay;
    }

    pub fn clear_active_session(&mut self, reason: impl Into<String>) {
        self.clear_custom_editor_drafts();
        self.active_session = None;
        self.lease_id = None;
        self.snapshot = None;
        self.operation = None;
        self.invalidate_transcript_requests(TranscriptViewKind::Active);
        self.invalidate_rich_text();
        self.invalidate_images();
        self.transcript.clear_for_reload(reason);
        self.clear_transient();
        self.clear_extension_components();
    }

    pub fn clear_connection_state(&mut self, reason: impl Into<String>) {
        self.clear_active_lease();
        self.clear_transient();
        self.page_load_pending = false;
        self.transcript.loading_previous = false;
        if let Some(view) = &mut self.readonly_view {
            view.transcript.loading_previous = false;
        }
        self.disconnected = Some(reason.into());
    }

    pub fn clear_extension_components(&mut self) {
        self.extension_ui.components.clear();
        self.pending_component_inputs.clear();
    }

    pub fn has_pending_component_input(
        &self,
        component_id: &str,
        generation: u64,
        data: &str,
    ) -> bool {
        self.pending_component_inputs.values().any(|pending| {
            pending.component_id == component_id
                && pending.generation == generation
                && pending.data == data
        })
    }

    pub fn timed_out_component_inputs(&self, timeout: Duration) -> Vec<String> {
        self.pending_component_inputs
            .iter()
            .filter(|(_, pending)| pending.started_at.elapsed() >= timeout)
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn take_component_input(&mut self, id: &str) -> Option<PendingComponentInput> {
        self.pending_component_inputs.remove(id)
    }

    pub fn clear_active_lease(&mut self) {
        self.lease_id = None;
        if let Some(context) = &mut self.active_session {
            context.lease_id = None;
        }
    }

    pub fn mark_image_failed(&mut self, content_ref: String) {
        self.failed_images.insert(content_ref);
    }

    pub fn begin_image_request(&mut self, id: String, content_ref: String) {
        self.pending_image_requests.insert(
            id,
            ImagePendingRequest {
                content_ref,
                generation: self.image_generation,
            },
        );
    }

    pub fn take_image_request(&mut self, id: &str) -> Option<ImagePendingRequest> {
        self.pending_image_requests.remove(id)
    }

    pub fn invalidate_images(&mut self) {
        self.image_generation = self.image_generation.saturating_add(1);
        self.pending_image_requests.clear();
        self.failed_images.clear();
        self.image_cache.clear();
    }

    pub fn mark_rich_text_failed(&mut self, key: RichTextKey) {
        self.failed_rich_text.insert(key);
    }

    pub fn begin_rich_text_request(&mut self, id: String, key: RichTextKey) {
        self.pending_rich_text_requests.insert(
            id,
            RichTextPendingRequest {
                key,
                generation: self.rich_text_generation,
            },
        );
    }

    pub fn take_rich_text_request(&mut self, id: &str) -> Option<RichTextPendingRequest> {
        self.pending_rich_text_requests.remove(id)
    }

    pub fn invalidate_rich_text(&mut self) {
        self.rich_text_generation = self.rich_text_generation.saturating_add(1);
        self.rich_text_cache.clear();
        self.pending_rich_text_requests.clear();
        self.failed_rich_text.clear();
    }

    pub fn rich_text_for(&self, key: &RichTextKey) -> Option<&RenderedRichText> {
        self.rich_text_cache.get(key)
    }

    pub fn rich_text_key(
        item: &TranscriptItem,
        width: u16,
        is_streaming: bool,
    ) -> Option<(RichTextKey, &'static str, &str)> {
        let (message_type, text) = rich_text_source(item)?;
        let content_hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        Some((
            RichTextKey {
                entry_id: item.entry_id.clone(),
                content_hash,
                width,
                is_streaming,
            },
            message_type,
            text,
        ))
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
        self.clear_extension_components();
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
        self.settle_custom_editor_operation(&operation.operation_id, &operation.status);
        let terminal = matches!(
            operation.status.as_str(),
            "completed" | "aborted" | "interrupted" | "failed"
        );
        let starts_new_operation = !terminal
            && self
                .operation
                .as_ref()
                .is_none_or(|current| current.operation_id != operation.operation_id);
        let current_is_active = self.operation.as_ref().is_some_and(|current| {
            matches!(
                current.status.as_str(),
                "accepted" | "running" | "waiting_for_input" | "aborting"
            )
        });
        if self.operation.as_ref().is_some_and(|current| {
            current.operation_id != operation.operation_id && current_is_active
        }) {
            return;
        }
        if self.operation.as_ref().is_some_and(|current| {
            current.operation_id == operation.operation_id
                && current.status == "aborting"
                && !terminal
        }) {
            return;
        }
        if starts_new_operation {
            self.clear_transient();
        }
        self.operation = Some(operation);
        match self
            .operation
            .as_ref()
            .map(|operation| operation.status.as_str())
        {
            Some("failed") => self.live_tools.settle_active(LiveToolStatus::Error),
            Some("aborted" | "interrupted") => {
                self.live_tools.settle_active(LiveToolStatus::Cancelled)
            }
            _ => {}
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
            } => self
                .live_tools
                .start(tool_call_id, name, summary.unwrap_or_default()),
            SessionProgress::ToolUpdate {
                tool_call_id,
                name,
                summary,
            } => self.live_tools.update(tool_call_id, name, summary),
            SessionProgress::ToolEnd {
                tool_call_id,
                name,
                status,
                summary,
            } => self.live_tools.finish(tool_call_id, name, &status, summary),
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

    pub fn toggle_tool_expansion(&mut self) {
        if !self.live_tools.toggle_bash_expansion() {
            self.transcript.toggle_current_tool();
        }
    }

    pub fn clear_live_after_commit(&mut self, items: &[TranscriptItem]) {
        let mut committed_assistant = false;
        let mut committed_thinking = false;
        for item in items {
            match &item.view {
                TranscriptViewItem::Assistant { .. } => committed_assistant = true,
                TranscriptViewItem::Thinking { .. } => committed_thinking = true,
                TranscriptViewItem::ToolResult { call_id, .. } => {
                    self.live_tools.remove(call_id);
                }
                _ => {}
            }
        }
        if committed_assistant {
            self.assistant_stream.clear();
            self.thinking_stream.clear();
        } else if committed_thinking {
            self.thinking_stream.clear();
        }
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
}
