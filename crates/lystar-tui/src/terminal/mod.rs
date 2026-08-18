use std::{
    fs::{self, File, OpenOptions},
    io::{self, IsTerminal, Read, Write},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    time::{Duration, Instant},
};

use crossterm::{
    cursor::{Hide, MoveTo, Show},
    event::{
        self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
        Event, KeyCode, KeyEventKind, KeyModifiers, MouseEventKind,
    },
    execute, queue,
    style::Print,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use lystar_protocol::{
    FrameDecoder, ProtocolError, ReadOnlyEvent, ReadOnlyMessage, ReadOnlyResponse, ServerMessage,
    TranscriptRequestContext, TranscriptViewItem, WorkspaceCommand, decode_server_message,
    encode_abort_operation_request, encode_acquire_session_request, encode_client_hello,
    encode_create_session_request, encode_extension_component_cancel_request,
    encode_extension_component_input_request, encode_extension_component_resize_request,
    encode_extension_editor_state_request, encode_extension_terminal_input_request,
    encode_list_sessions_request, encode_queue_request, encode_read_transcript_request,
    encode_release_session_request, encode_search_transcript_request, encode_session_write_request,
    encode_ui_response, encode_workspace_request,
};
use ratatui::{Terminal, TerminalOptions, Viewport, backend::CrosstermBackend};
use signal_hook::{
    consts::signal::{SIGINT, SIGTERM},
    flag,
};
use thiserror::Error;

use crate::{
    app::{
        AppState, ChangesTab, ClipboardDescriptor, ClipboardReadTarget, ComposerAttachment,
        ComposerCompletion, ComposerCompletionItem, ComposerView, ConfirmOverlay, DetailOverlay,
        ExtensionComponentOverlayOptions, ExtensionComponentOverlayView, ExtensionComponentState,
        ExtensionUiState, ExtensionWidget, GitDiffDescriptor, GitFileDescriptor,
        GitStatusDescriptor, InputFocus, InstructionDescriptor, ListOverlay, ModelDescriptor,
        OverlayItem, OverlayLink, OverlayOrigin, OverlayState, PackageDescriptor, PendingIntent,
        PendingSessionImport, PendingTerminalInput, ProjectTrustDescriptor, ProviderDescriptor,
        ReadonlySessionView, SearchHit, SessionRestorePoint, SessionSummary, SessionTreeNode,
        SettingDescriptor, SkillDescriptor, SubagentDescriptor, TextEditorOverlay,
        TranscriptRequestKind, TranscriptView, TranscriptViewKind, TreeFilter, UiRequest,
        UiRequestKind, UpdateDescriptor, VisibleLink, WorkbenchOverlayView, WorkbenchTarget,
        WorkspaceRequest, composer_area_with_widget_budget, extension_component_rect,
        transcript_area, transcript_area_with_widget_budget, transcript_images,
    },
    image::{CachedImage, ImageSidecar, TerminalImageProtocol, current_terminal_image_protocol},
};

const INITIAL_PAGE_LIMIT: u64 = 200;
const PAGE_LIMIT: u64 = 200;
const SEARCH_LIMIT: u64 = 50;
const EXIT_TRANSCRIPT_PAGE_LIMIT: u64 = 200;
const EXTENSION_INPUT_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_EXTENSION_INPUT_BYTES: usize = 64 * 1024;

mod clone;
mod copy;
mod extension;
mod input;
mod lifecycle;
mod name;
mod options;
mod render;
mod requests;
mod responses;
mod runtime;
mod shell;
mod transport;
mod workspace;

pub use options::{ExitOutput, RunOptions, TerminalMode, TuiError};
pub use runtime::{run, run_with_options};
pub use shell::{run_shell, run_shell_with_mode};
pub use transport::handshake_inherited_pipes;

use clone::*;
use copy::*;
use extension::*;
use input::*;
use lifecycle::TerminalGuard;
#[cfg(test)]
use lifecycle::enter_terminal;
use name::*;
#[cfg(test)]
use options::TerminalModeContext;
use options::{SessionFlow, inline_viewport_height, resolve_terminal_mode, terminal_mode_context};
use render::*;
use requests::*;
use responses::*;
use transport::ProtocolPipe;
use workspace::*;

#[cfg(test)]
mod tests;
