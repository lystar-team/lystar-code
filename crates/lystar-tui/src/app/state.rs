use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;

use lystar_protocol::{
    OperationSnapshot, SessionProgress, SessionSnapshot, StartupInput, StartupPrompt,
    TranscriptItem, TranscriptViewItem,
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
    DetailOverlay, ExtensionUiState, GitDiffDescriptor, GitStatusDescriptor, ImagePendingRequest,
    InstructionDescriptor, ListOverlay, LiveCompaction, LiveRetry, ModelDescriptor, OverlayLink,
    OverlayOrigin, OverlayState, PackageDescriptor, PendingAttachmentSubmit, PendingBashSubmit,
    PendingComponentInput, PendingCustomEditorSubmit, PendingRequest, PendingSessionImport,
    PendingTerminalInput, ProjectTrustDescriptor, ProviderDescriptor, ReadonlySessionView,
    RecoveryDraft, RichTextPendingRequest, SearchState, SessionSummary, SessionTreeNode,
    SettingDescriptor, SkillDescriptor, SubagentDescriptor, TranscriptPendingRequest,
    TranscriptRequestKind, TranscriptViewKind, TranscriptWindow, TreeFilter, UpdateDescriptor,
    WorkspaceOverlayGeneration,
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
    pub compaction: Option<LiveCompaction>,
    pub retry: Option<LiveRetry>,
    pub assistant_stream: String,
    pub thinking_stream: String,
    pub startup_batch_id: Option<String>,
    pub startup_prompts: VecDeque<StartupPrompt>,
    pub startup_next_index: usize,
    pub startup_inflight_request_id: Option<String>,
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
    pub compaction: Option<LiveCompaction>,
    pub retry: Option<LiveRetry>,
    pub assistant_stream: String,
    pub thinking_stream: String,
    pub hide_thinking: bool,
    pub reduce_motion: bool,
    pub startup_batch_id: Option<String>,
    pub startup_prompts: VecDeque<StartupPrompt>,
    pub startup_next_index: usize,
    pub startup_inflight_request_id: Option<String>,
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
    pub pending_bash_submit: Option<PendingBashSubmit>,
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
    pub pending_session_import: Option<PendingSessionImport>,
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

    pub fn install_startup_input(&mut self, input: StartupInput) {
        if self.startup_batch_id.as_deref() == Some(input.batch_id.as_str()) {
            return;
        }
        self.startup_batch_id = Some(input.batch_id);
        self.startup_prompts = input.prompts.into();
        self.startup_next_index = 0;
        self.startup_inflight_request_id = None;
    }

    pub fn take_startup_prompt(&mut self) -> Option<(String, StartupPrompt)> {
        if self.startup_inflight_request_id.is_some() {
            return None;
        }
        let prompt = self.startup_prompts.pop_front()?;
        let request_id = format!(
            "startup:{}:{}",
            self.startup_batch_id.as_deref().unwrap_or("cli"),
            self.startup_next_index
        );
        self.startup_next_index = self.startup_next_index.saturating_add(1);
        self.startup_inflight_request_id = Some(request_id.clone());
        Some((request_id, prompt))
    }

    pub fn clear_startup_input(&mut self) {
        self.startup_batch_id = None;
        self.startup_prompts.clear();
        self.startup_next_index = 0;
        self.startup_inflight_request_id = None;
    }

    pub fn reject_startup_response(&mut self, response_id: &str) -> bool {
        if self.startup_inflight_request_id.as_deref() != Some(response_id) {
            return false;
        }
        self.startup_inflight_request_id = None;
        true
    }

    pub fn begin_active_session(&mut self, path: String, cwd: String) -> u64 {
        self.clear_custom_editor_drafts();
        self.pending_session_import = None;
        self.clear_transient();
        self.session_generation = self.session_generation.saturating_add(1);
        self.invalidate_transcript_requests(TranscriptViewKind::Active);
        self.invalidate_rich_text();
        self.invalidate_images();
        self.clear_extension_components();
        self.clear_startup_input();
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
            compaction: self.compaction.clone(),
            retry: self.retry.clone(),
            assistant_stream: self.assistant_stream.clone(),
            thinking_stream: self.thinking_stream.clone(),
            startup_batch_id: self.startup_batch_id.clone(),
            startup_prompts: self.startup_prompts.clone(),
            startup_next_index: self.startup_next_index,
            startup_inflight_request_id: self.startup_inflight_request_id.clone(),
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
        self.compaction = restore.compaction;
        self.retry = restore.retry;
        self.assistant_stream = restore.assistant_stream;
        self.thinking_stream = restore.thinking_stream;
        self.startup_batch_id = restore.startup_batch_id;
        self.startup_prompts = restore.startup_prompts;
        self.startup_next_index = restore.startup_next_index;
        self.startup_inflight_request_id = restore.startup_inflight_request_id;
        self.overlays = restore.overlays;
        self.workspace_overlay_stack = restore.workspace_overlay_stack;
        self.workspace_generations = restore.workspace_generations;
        self.input_focus = restore.input_focus;
        self.focus_before_overlay = restore.focus_before_overlay;
    }

    pub fn clear_active_session(&mut self, reason: impl Into<String>) {
        self.clear_custom_editor_drafts();
        self.pending_session_import = None;
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
        self.pending_session_import = None;
        if matches!(
            self.overlay(),
            Some(OverlayState::Confirm(confirm))
                if confirm.confirm_action.starts_with("session-import-")
        ) {
            self.close_overlay();
        }
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
        if matches!(
            operation.status.as_str(),
            "completed" | "aborted" | "interrupted" | "failed"
        ) && self.startup_inflight_request_id.as_deref()
            == Some(operation.client_request_id.as_str())
        {
            self.startup_inflight_request_id = None;
        }
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
        let bash_progress = match operation.progress.as_ref() {
            Some(SessionProgress::Bash {
                command,
                output,
                truncated: _,
            }) if operation.operation_type == "run_bash" => Some((command.clone(), output.clone())),
            _ => None,
        };
        let pending_bash_matches = self.pending_bash_submit.as_ref().is_some_and(|submit| {
            submit.operation_id.as_deref() == Some(operation.operation_id.as_str())
        });
        self.operation = Some(operation);
        let auth_update = self.operation.as_ref().and_then(|operation| {
            (operation.operation_type == "login_model_provider")
                .then(|| (operation.status.clone(), operation.error.clone()))
        });
        if let Some((status, error)) = auth_update {
            match status.as_str() {
                "accepted" | "running" | "waiting_for_input" => {
                    self.transcript.status = "正在等待认证，按 Esc 取消".to_owned();
                }
                "aborted" | "interrupted" => {
                    self.write_pending = false;
                    self.transcript.status.clear();
                    self.close_overlay();
                    self.set_toast("登录已取消");
                }
                "failed" => {
                    self.transcript.status.clear();
                    if let Some(error) = error {
                        self.set_overlay_error(error);
                    }
                }
                "completed" => self.transcript.status.clear(),
                _ => {}
            }
        }
        if let Some((command, output)) = bash_progress
            && (!terminal || pending_bash_matches)
        {
            let operation = self.operation.as_ref().expect("operation just stored");
            let status = match operation.status.as_str() {
                "completed" => LiveToolStatus::Success,
                "failed" => LiveToolStatus::Error,
                "aborted" | "interrupted" => LiveToolStatus::Cancelled,
                _ => LiveToolStatus::Running,
            };
            self.live_tools.apply_bash_operation(
                operation.operation_id.clone(),
                command,
                output,
                status,
            );
        }
        self.settle_bash_operation();
        let bash_update = self.operation.as_ref().and_then(|operation| {
            (operation.operation_type == "run_bash")
                .then(|| (operation.status.clone(), operation.error.clone()))
        });
        if let Some((status, error)) = bash_update {
            match status.as_str() {
                "accepted" | "running" => {
                    self.transcript.status = "正在运行 Shell，按 Esc 取消".to_owned();
                }
                "aborting" => self.transcript.status = "正在取消 Shell".to_owned(),
                "completed" => self.transcript.status.clear(),
                "aborted" | "interrupted" => self.transcript.status.clear(),
                "failed" => {
                    self.transcript.status.clear();
                    self.set_overlay_error(
                        error.unwrap_or_else(|| "Shell 命令执行失败：未知错误".to_owned()),
                    );
                }
                _ => {}
            }
        }
        let share_update = self.operation.as_ref().and_then(|operation| {
            (operation.operation_type == "share_session").then(|| {
                (
                    operation.status.clone(),
                    operation.error.clone(),
                    operation.result.clone(),
                )
            })
        });
        if let Some((status, error, result)) = share_update {
            match status.as_str() {
                "accepted" | "running" | "waiting_for_input" => {
                    self.transcript.status = "正在创建私密 Gist，按 Ctrl+C 可取消".to_owned();
                }
                "aborting" => self.transcript.status = "正在取消分享".to_owned(),
                "aborted" | "interrupted" => {
                    self.transcript.status.clear();
                    self.set_toast("分享已取消");
                }
                "failed" => {
                    self.transcript.status.clear();
                    self.set_overlay_error(
                        error.unwrap_or_else(|| "分享会话失败：未知错误".to_owned()),
                    );
                }
                "completed" => {
                    self.transcript.status.clear();
                    let urls = result
                        .as_ref()
                        .and_then(serde_json::Value::as_object)
                        .and_then(|result| {
                            Some((
                                result.get("previewUrl")?.as_str()?.to_owned(),
                                result.get("gistUrl")?.as_str()?.to_owned(),
                            ))
                        });
                    if let Some((preview_url, gist_url)) = urls {
                        self.open_overlay(OverlayState::Detail(DetailOverlay {
                            title: "会话已分享".to_owned(),
                            lines: vec![
                                format!("分享地址：{preview_url}"),
                                format!("Gist：{gist_url}"),
                            ],
                            scroll: 0,
                            status: "Ctrl+Y 复制分享地址，Enter 打开，Esc 关闭".to_owned(),
                            link: Some(OverlayLink {
                                line: 0,
                                label: preview_url.clone(),
                                href: preview_url.clone(),
                            }),
                            copy_text: Some(preview_url),
                        }));
                        self.set_toast("会话已分享");
                    } else {
                        self.set_overlay_error("分享任务缺少结果");
                    }
                }
                _ => {}
            }
        }
        match self
            .operation
            .as_ref()
            .map(|operation| operation.status.as_str())
        {
            Some("completed")
                if self
                    .operation
                    .as_ref()
                    .is_some_and(|operation| operation.operation_type == "run_bash") =>
            {
                self.live_tools.settle_active(LiveToolStatus::Success)
            }
            Some("failed") => self.live_tools.settle_active(LiveToolStatus::Error),
            Some("aborted" | "interrupted") => {
                self.live_tools.settle_active(LiveToolStatus::Cancelled)
            }
            _ => {}
        }
    }

    pub fn apply_progress(&mut self, progress: SessionProgress) {
        match progress {
            SessionProgress::AssistantDelta { text } => {
                self.retry = None;
                self.assistant_stream.push_str(&text);
            }
            SessionProgress::ThinkingDelta { text } => {
                self.retry = None;
                self.thinking_stream.push_str(&text);
            }
            SessionProgress::ToolStart {
                tool_call_id,
                name,
                summary,
                diff,
            } => self
                .live_tools
                .start(tool_call_id, name, summary.unwrap_or_default(), diff),
            SessionProgress::ToolUpdate {
                tool_call_id,
                name,
                summary,
                diff,
            } => self.live_tools.update(tool_call_id, name, summary, diff),
            SessionProgress::ToolEnd {
                tool_call_id,
                name,
                status,
                summary,
                diff,
            } => self
                .live_tools
                .finish(tool_call_id, name, &status, summary, diff),
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
            SessionProgress::Compaction {
                status,
                reason,
                error,
            } => self.compaction = Some(LiveCompaction::new(&status, reason, error)),
            SessionProgress::Retry {
                status,
                kind,
                attempt,
                max_attempts,
                delay_ms,
                error,
            } => {
                if kind == "model" && status == "waiting" {
                    self.assistant_stream.clear();
                    self.thinking_stream.clear();
                }
                self.retry = LiveRetry::update(
                    self.retry.take(),
                    &status,
                    kind,
                    attempt,
                    max_attempts,
                    delay_ms,
                    error,
                );
            }
            SessionProgress::Bash { .. } => {}
            SessionProgress::Status { status, .. } => self.transcript.status = status,
            SessionProgress::Usage { usage } => {
                if let Some(elapsed) = usage.elapsed_ms {
                    self.transcript.status = format!("运行 {}ms", elapsed);
                }
            }
        }
    }

    pub fn toggle_tool_expansion(&mut self) {
        if !self.live_tools.toggle_output_expansion() {
            self.transcript.toggle_current_tool();
        }
    }

    pub fn toggle_thinking_visibility(&mut self) {
        self.hide_thinking = !self.hide_thinking;
        self.set_toast(if self.hide_thinking {
            "思考过程：已折叠"
        } else {
            "思考过程：已展开"
        });
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
                TranscriptViewItem::Bash { .. } => {
                    let operation_id = self
                        .pending_bash_submit
                        .as_ref()
                        .and_then(|submit| submit.operation_id.clone())
                        .or_else(|| {
                            self.operation.as_ref().and_then(|operation| {
                                (operation.operation_type == "run_bash")
                                    .then(|| operation.operation_id.clone())
                            })
                        });
                    if let Some(operation_id) = operation_id {
                        self.live_tools.remove(&operation_id);
                    }
                    self.pending_bash_submit = None;
                }
                TranscriptViewItem::Summary { title, .. } if title == "上下文压缩" => {
                    self.compaction = None;
                    self.retry = None;
                }
                TranscriptViewItem::Summary { title, .. } if title == "分支摘要" => {
                    self.retry = None;
                }
                _ => {}
            }
        }
        if committed_assistant {
            self.assistant_stream.clear();
            self.thinking_stream.clear();
            self.retry = None;
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
