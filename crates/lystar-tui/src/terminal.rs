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
    B3Command, FrameDecoder, ProtocolError, ReadOnlyEvent, ReadOnlyMessage, ReadOnlyResponse,
    ServerMessage, TranscriptRequestContext, TranscriptViewItem, decode_server_message,
    encode_abort_operation_request, encode_acquire_session_request, encode_b3_request,
    encode_client_hello, encode_create_session_request, encode_extension_component_cancel_request,
    encode_extension_component_input_request, encode_extension_component_resize_request,
    encode_extension_editor_state_request, encode_extension_terminal_input_request,
    encode_list_sessions_request, encode_queue_request, encode_read_transcript_request,
    encode_release_session_request, encode_search_transcript_request, encode_session_write_request,
    encode_ui_response,
};
use ratatui::{Terminal, TerminalOptions, Viewport, backend::CrosstermBackend};
use signal_hook::{
    consts::signal::{SIGINT, SIGTERM},
    flag,
};
use thiserror::Error;

use crate::{
    app::{
        AppState, B3Request, ChangesTab, ClipboardDescriptor, ClipboardReadTarget,
        ComposerAttachment, ComposerCompletion, ComposerCompletionItem, ComposerView,
        ConfirmOverlay, DetailOverlay, ExtensionComponentOverlayOptions,
        ExtensionComponentOverlayView, ExtensionComponentState, ExtensionUiState, ExtensionWidget,
        GitDiffDescriptor, GitFileDescriptor, GitStatusDescriptor, InputFocus,
        InstructionDescriptor, ListOverlay, ModelDescriptor, OverlayItem, OverlayLink,
        OverlayOrigin, OverlayState, PackageDescriptor, PendingIntent, PendingTerminalInput,
        ProjectTrustDescriptor, ProviderDescriptor, ReadonlySessionView, SearchHit,
        SessionRestorePoint, SessionSummary, SessionTreeNode, SettingDescriptor, SkillDescriptor,
        SubagentDescriptor, TextEditorOverlay, TranscriptRequestKind, TranscriptView,
        TranscriptViewKind, TreeFilter, UiRequest, UiRequestKind, UpdateDescriptor, VisibleLink,
        WorkbenchOverlayView, WorkbenchTarget, composer_area_with_widget_budget,
        extension_component_rect, transcript_area, transcript_area_with_widget_budget,
        transcript_images,
    },
    image::{CachedImage, ImageSidecar, TerminalImageProtocol, current_terminal_image_protocol},
};

const INITIAL_PAGE_LIMIT: u64 = 200;
const PAGE_LIMIT: u64 = 200;
const SEARCH_LIMIT: u64 = 50;
const EXIT_TRANSCRIPT_PAGE_LIMIT: u64 = 200;
const EXTENSION_INPUT_TIMEOUT: Duration = Duration::from_millis(100);
const MAX_EXTENSION_INPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalMode {
    Auto,
    Fullscreen,
    Regular,
}

impl TerminalMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "fullscreen" => Some(Self::Fullscreen),
            "regular" => Some(Self::Regular),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Fullscreen => "fullscreen",
            Self::Regular => "regular",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitOutput {
    Transcript,
    ResumeHint,
}

impl ExitOutput {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "transcript" => Some(Self::Transcript),
            "resume-hint" => Some(Self::ResumeHint),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunOptions {
    pub mode: TerminalMode,
    pub exit_output: ExitOutput,
}

impl Default for RunOptions {
    fn default() -> Self {
        Self {
            mode: TerminalMode::Auto,
            exit_output: ExitOutput::Transcript,
        }
    }
}

#[derive(Debug, Clone)]
struct TerminalModeContext {
    stdout_tty: bool,
    stdin_tty: bool,
    term: Option<String>,
    env_mode: Option<TerminalMode>,
}

fn terminal_mode_context() -> TerminalModeContext {
    TerminalModeContext {
        stdout_tty: io::stdout().is_terminal(),
        stdin_tty: io::stdin().is_terminal(),
        term: std::env::var("TERM").ok(),
        env_mode: std::env::var("PI_TUI_MODE")
            .ok()
            .as_deref()
            .and_then(TerminalMode::parse),
    }
}

fn resolve_terminal_mode(requested: TerminalMode, context: TerminalModeContext) -> TerminalMode {
    if requested != TerminalMode::Auto {
        return requested;
    }
    if let Some(mode @ (TerminalMode::Fullscreen | TerminalMode::Regular)) = context.env_mode {
        return mode;
    }
    let alternate_capable = context
        .term
        .as_deref()
        .is_some_and(|term| !term.is_empty() && term != "dumb");
    if context.stdout_tty && context.stdin_tty && alternate_capable {
        TerminalMode::Fullscreen
    } else {
        TerminalMode::Regular
    }
}

fn inline_viewport_height(rows: u16) -> u16 {
    rows.clamp(3, 24)
}

#[derive(Debug, Error)]
pub enum TuiError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error("{mode} 模式无法启用终端原始输入：{message}")]
    TerminalSetup { mode: &'static str, message: String },
    #[error("host closed the protocol pipe before hello")]
    ChildEof,
    #[error("host rejected the Rust frontend: {0}")]
    HelloRejected(String),
    #[error("host protocol response is malformed: {0}")]
    InvalidResponse(String),
}

#[derive(Debug)]
enum SessionTransition {
    InitialAcquiring {
        id: String,
        path: String,
        generation: u64,
    },
    List {
        id: String,
        selected_path: Option<String>,
    },
    Rename {
        id: String,
        index: usize,
        name: String,
    },
    Fork {
        id: String,
        toast: String,
    },
    Readonly {
        id: String,
        path: String,
        replace: bool,
        generation: u64,
    },
    SwitchReleasing {
        id: String,
        target: SessionSummary,
        restore: SessionRestorePoint,
    },
    SwitchAcquiring {
        id: String,
        target: SessionSummary,
        restore: SessionRestorePoint,
    },
    SwitchRollback {
        id: String,
        restore: SessionRestorePoint,
        reason: String,
    },
    CreateStarting {
        id: String,
        restore: SessionRestorePoint,
    },
    CreateReleasingOld {
        id: String,
        path: String,
        lease_id: String,
        snapshot: lystar_protocol::SessionSnapshot,
        restore: SessionRestorePoint,
    },
    CreateCleanup {
        id: String,
        restore: SessionRestorePoint,
        reason: String,
    },
    DeleteReleasing {
        id: String,
        restore: SessionRestorePoint,
        target: Option<SessionSummary>,
    },
    DeleteRemoving {
        id: String,
        restore: SessionRestorePoint,
        target: Option<SessionSummary>,
    },
    DeleteAcquiring {
        id: String,
        target: SessionSummary,
    },
    DeleteRollback {
        id: String,
        restore: SessionRestorePoint,
        reason: String,
    },
    QuitReleasing {
        id: String,
    },
}

type SessionFlow = SessionTransition;

pub struct TerminalGuard {
    raw: bool,
    alternate: bool,
    mouse: bool,
    bracketed_paste: bool,
    cursor_hidden: bool,
}

impl TerminalGuard {
    pub fn enter(mode: TerminalMode) -> Result<Self, io::Error> {
        let mut guard = Self {
            raw: false,
            alternate: false,
            mouse: false,
            bracketed_paste: false,
            cursor_hidden: false,
        };
        enable_raw_mode()?;
        guard.raw = true;

        let setup = (|| -> Result<(), io::Error> {
            let mut stdout = io::stdout();
            if mode == TerminalMode::Fullscreen {
                execute!(stdout, EnterAlternateScreen)?;
                guard.alternate = true;
                execute!(stdout, EnableMouseCapture)?;
                guard.mouse = true;
            }
            execute!(stdout, EnableBracketedPaste)?;
            guard.bracketed_paste = true;
            execute!(stdout, Hide)?;
            guard.cursor_hidden = true;
            Ok(())
        })();
        if let Err(error) = setup {
            guard.restore();
            return Err(error);
        }
        Ok(guard)
    }

    fn restore(&mut self) {
        let mut stdout = io::stdout();
        if self.cursor_hidden {
            let _ = execute!(stdout, Show);
            self.cursor_hidden = false;
        }
        if self.bracketed_paste {
            let _ = execute!(stdout, DisableBracketedPaste);
            self.bracketed_paste = false;
        }
        if self.mouse {
            let _ = execute!(stdout, DisableMouseCapture);
            self.mouse = false;
        }
        if self.alternate {
            let _ = execute!(stdout, LeaveAlternateScreen);
            self.alternate = false;
        }
        if self.raw {
            let _ = disable_raw_mode();
            self.raw = false;
        }
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        self.restore();
    }
}

#[cfg(test)]
fn enter_terminal<Enable, Enter, Restore>(
    enable_raw: Enable,
    enter_screen: Enter,
    restore_raw: Restore,
) -> Result<(), io::Error>
where
    Enable: FnOnce() -> Result<(), io::Error>,
    Enter: FnOnce() -> Result<(), io::Error>,
    Restore: FnOnce() -> Result<(), io::Error>,
{
    enable_raw()?;
    if let Err(error) = enter_screen() {
        let _ = restore_raw();
        return Err(error);
    }
    Ok(())
}

#[cfg(unix)]
struct ProtocolPipe {
    output: std::fs::File,
    inbound: Receiver<Result<ServerMessage, TuiError>>,
}

#[cfg(unix)]
impl ProtocolPipe {
    fn connect(client_instance_id: &str) -> Result<Self, TuiError> {
        use std::{fs::File, os::fd::FromRawFd, thread};

        // fd3/4 仅承载 Host 的 framed protocol，Session 文件始终由 Host 读取。
        let input = unsafe { File::from_raw_fd(3) };
        let mut output = unsafe { File::from_raw_fd(4) };
        output.write_all(&encode_client_hello(client_instance_id)?)?;
        output.flush()?;
        let (sender, inbound) = mpsc::sync_channel(64);
        thread::spawn(move || read_protocol(input, sender));
        let pipe = Self { output, inbound };
        match pipe.inbound.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(message)) => match message.read_only().map_err(TuiError::from)? {
                ReadOnlyMessage::Hello => Ok(pipe),
                ReadOnlyMessage::HelloError { .. } => Err(TuiError::HelloRejected(
                    "host returned hello_error".to_owned(),
                )),
                _ => Err(TuiError::HelloRejected("expected server hello".to_owned())),
            },
            Ok(Err(error)) => Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err(TuiError::HelloRejected("host hello timed out".to_owned()))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(TuiError::ChildEof),
        }
    }

    fn request(&mut self, frame: &[u8]) -> Result<(), TuiError> {
        self.output.write_all(frame)?;
        self.output.flush()?;
        Ok(())
    }
}

#[cfg(unix)]
fn read_protocol(mut input: std::fs::File, sender: SyncSender<Result<ServerMessage, TuiError>>) {
    let mut decoder = FrameDecoder::default();
    let mut buffer = [0_u8; 8192];
    loop {
        match input.read(&mut buffer) {
            Ok(0) => {
                let result = decoder
                    .end()
                    .map_err(TuiError::from)
                    .and(Err(TuiError::ChildEof));
                let _ = sender.send(result);
                return;
            }
            Ok(count) => match decoder.push(&buffer[..count]) {
                Ok(frames) => {
                    for frame in frames {
                        if sender
                            .send(decode_server_message(&frame).map_err(TuiError::from))
                            .is_err()
                        {
                            return;
                        }
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(error.into()));
                    return;
                }
            },
            Err(error) => {
                let _ = sender.send(Err(error.into()));
                return;
            }
        }
    }
}

fn trace(event: &str) {
    if std::env::var_os("PI_RUST_TUI_TRACE").is_some() {
        eprintln!("lystar-rust-tui trace={event} at_ms={}", monotonic_millis());
    }
}

fn trace_id(event: &str, id: &str) {
    if std::env::var_os("PI_RUST_TUI_TRACE").is_some() {
        eprintln!(
            "lystar-rust-tui trace={event} at_ms={} id={id}",
            monotonic_millis()
        );
    }
}

fn trace_component_frame_applied(component_id: &str, revision: u64) {
    if std::env::var_os("PI_RUST_TUI_TRACE").is_some() {
        eprintln!(
            "lystar-rust-tui trace=extension_component_frame_applied componentId={component_id} revision={revision} at_ms={}",
            monotonic_millis()
        );
    }
}

fn monotonic_millis() -> f64 {
    #[cfg(target_os = "linux")]
    {
        #[repr(C)]
        struct Timespec {
            tv_sec: i64,
            tv_nsec: i64,
        }
        unsafe extern "C" {
            fn clock_gettime(clock_id: i32, time: *mut Timespec) -> i32;
        }
        let mut time = Timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: clock_gettime writes exactly one Timespec to the valid local pointer.
        if unsafe { clock_gettime(1, &mut time) } == 0 {
            return time.tv_sec as f64 * 1_000.0 + time.tv_nsec as f64 / 1_000_000.0;
        }
    }
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1_000.0
}

fn trace_cache(app: &AppState) {
    if std::env::var_os("PI_RUST_TUI_TRACE").is_some() {
        let diagnostics = app.transcript.diagnostics();
        eprintln!(
            "lystar-rust-tui cache rounds={} items={} bytes={} preview_bytes={} total_bytes={}",
            diagnostics.cached_rounds,
            diagnostics.cached_items,
            diagnostics.cached_utf8_bytes,
            diagnostics.streaming_preview_utf8_bytes,
            diagnostics.total_utf8_bytes,
        );
    }
}

fn sanitize_terminal_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .collect()
}

fn sanitize_osc8_href(value: &str) -> Option<&str> {
    if value.is_empty()
        || value.chars().any(char::is_control)
        || value.chars().any(char::is_whitespace)
    {
        return None;
    }
    (value.starts_with("https://")
        || value.starts_with("http://")
        || value.starts_with("mailto:")
        || value.starts_with("file://"))
    .then_some(value)
}

fn osc8_link(href: &str, text: &str) -> String {
    let Some(href) = sanitize_osc8_href(href) else {
        return String::new();
    };
    let text = sanitize_terminal_text(text);
    format!("\x1b]8;;{href}\x1b\\{text}\x1b]8;;\x1b\\")
}

fn write_visible_osc8_link(writer: &mut impl Write, region: &VisibleLink) -> Result<(), io::Error> {
    queue!(
        writer,
        MoveTo(region.column, region.row),
        Print(osc8_link(&region.href, &region.label))
    )?;
    writer.flush()
}

fn render_active_osc8_link(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &AppState,
) -> Result<(), io::Error> {
    let area = terminal.size()?;
    let full = ratatui::layout::Rect::new(0, 0, area.width, area.height);
    let Some(region) = WorkbenchOverlayView::new(app)
        .visible_link(full)
        .or_else(|| TranscriptView::new(app).visible_link(transcript_area(app, full)))
    else {
        return Ok(());
    };
    write_visible_osc8_link(terminal.backend_mut().writer_mut(), &region)
}

struct ExitTranscriptTemp {
    directory: PathBuf,
    pages: usize,
}

impl ExitTranscriptTemp {
    fn new() -> Result<Self, TuiError> {
        for attempt in 0..1_024_u16 {
            let directory = std::env::temp_dir().join(format!(
                "lystar-rust-tui-exit-{}-{}-{attempt}",
                std::process::id(),
                monotonic_millis()
            ));
            match fs::create_dir(&directory) {
                Ok(()) => {
                    return Ok(Self {
                        directory,
                        pages: 0,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(TuiError::InvalidResponse(
            "无法创建退出记录临时目录".to_owned(),
        ))
    }

    fn write_page(&mut self, items: &[lystar_protocol::TranscriptItem]) -> Result<(), TuiError> {
        let path = self.directory.join(format!("{:08}.txt", self.pages));
        self.pages = self.pages.saturating_add(1);
        let mut page = File::create(path)?;
        for item in items {
            page.write_all(transcript_plain_text(item).as_bytes())?;
        }
        page.flush()?;
        Ok(())
    }

    fn stream_reverse(&self, output: &mut impl Write) -> Result<(), TuiError> {
        for page in (0..self.pages).rev() {
            let mut input = OpenOptions::new()
                .read(true)
                .open(self.directory.join(format!("{:08}.txt", page)))?;
            io::copy(&mut input, output)?;
        }
        output.flush()?;
        Ok(())
    }
}

impl Drop for ExitTranscriptTemp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn transcript_images_plain(images: Option<&[lystar_protocol::TranscriptImage]>) -> String {
    images
        .unwrap_or_default()
        .iter()
        .map(|image| {
            format!(
                "[图片 {} {}B contentRef:{}{}]",
                image.mime_type,
                image.byte_length,
                image.content_ref,
                image
                    .alt
                    .as_deref()
                    .map_or(String::new(), |alt| format!(" alt:{alt}"))
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn transcript_plain_text(item: &lystar_protocol::TranscriptItem) -> String {
    let header = format!("\n[{} {}]\n", item.timestamp, item.entry_id);
    let body = match &item.view {
        TranscriptViewItem::User { text, images } => {
            format!(
                "用户:\n{text}\n{}",
                transcript_images_plain(images.as_deref())
            )
        }
        TranscriptViewItem::Assistant { text, images } => {
            format!(
                "助手:\n{text}\n{}",
                transcript_images_plain(images.as_deref())
            )
        }
        TranscriptViewItem::Thinking { text } => format!("思考:\n{text}"),
        TranscriptViewItem::Bash { text } => format!("Bash:\n{text}"),
        TranscriptViewItem::Custom { text } => format!("自定义:\n{text}"),
        TranscriptViewItem::Summary { title, text } => format!("摘要 {title}:\n{text}"),
        TranscriptViewItem::System { text } => format!("系统:\n{text}"),
        TranscriptViewItem::ToolCall { calls } => calls
            .iter()
            .map(|call| {
                format!(
                    "Tool 调用 {} {}{}",
                    call.name,
                    call.summary,
                    call.href
                        .as_deref()
                        .map_or(String::new(), |href| format!("\n链接: {href}"))
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        TranscriptViewItem::ToolResult {
            call_id,
            name,
            status,
            summary,
            detail,
            content_ref,
            images,
        } => format!(
            "Tool 结果 {name} ({status}) callId:{call_id}\n摘要: {summary}{}{}{}",
            detail
                .as_deref()
                .map_or(String::new(), |value| format!("\n{value}")),
            content_ref
                .as_deref()
                .map_or(String::new(), |value| format!("\ncontentRef: {value}")),
            if images.as_deref().is_some_and(|value| !value.is_empty()) {
                format!("\n{}", transcript_images_plain(images.as_deref()))
            } else {
                String::new()
            }
        ),
    };
    format!("{header}{body}\n")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn write_resume_hint(
    output: &mut impl Write,
    session_path: &str,
    failure: Option<&str>,
) -> Result<(), TuiError> {
    if let Some(failure) = failure {
        writeln!(output, "{failure}")?;
    }
    writeln!(output, "会话已保存，可使用以下命令恢复：")?;
    writeln!(output, "lc -r {}", shell_quote(session_path))?;
    output.flush()?;
    Ok(())
}

#[cfg(unix)]
fn request_exit_transcript_page(
    pipe: &mut ProtocolPipe,
    session_path: &str,
    request_id: &str,
    cursor: Option<&str>,
    context: Option<&TranscriptRequestContext>,
) -> Result<lystar_protocol::TranscriptPage, TuiError> {
    pipe.request(&encode_read_transcript_request(
        request_id,
        session_path,
        EXIT_TRANSCRIPT_PAGE_LIMIT,
        cursor,
        context,
    )?)?;
    loop {
        match pipe.inbound.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(message)) => match message.read_only()? {
                ReadOnlyMessage::Response(ReadOnlyResponse::TranscriptPage { id, page })
                    if id == request_id =>
                {
                    if !page.complete {
                        return Err(TuiError::InvalidResponse("退出记录页未完整返回".to_owned()));
                    }
                    return Ok(page);
                }
                ReadOnlyMessage::Response(ReadOnlyResponse::Error { id, message })
                    if id == request_id =>
                {
                    return Err(TuiError::InvalidResponse(message));
                }
                _ => {}
            },
            Ok(Err(error)) => return Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(TuiError::InvalidResponse("读取退出记录超时".to_owned()));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(TuiError::ChildEof),
        }
    }
}

#[cfg(unix)]
fn emit_exit_output(
    pipe: &mut ProtocolPipe,
    session_path: &str,
    output: ExitOutput,
) -> Result<(), TuiError> {
    if output == ExitOutput::ResumeHint {
        return write_resume_hint(&mut io::stdout(), session_path, None);
    }
    let mut temporary = ExitTranscriptTemp::new()?;
    let mut cursor: Option<String> = None;
    let mut generation = None;
    let mut revision = None;
    let mut page_number = 0_u64;
    loop {
        page_number = page_number.saturating_add(1);
        let request_id = format!("exit-transcript-{page_number}");
        let context = cursor.as_ref().map(|cursor| TranscriptRequestContext {
            generation: generation.clone(),
            revision,
            cursor: Some(cursor.clone()),
        });
        let page = request_exit_transcript_page(
            pipe,
            session_path,
            &request_id,
            cursor.as_deref(),
            context.as_ref(),
        )?;
        if page.items.len() > EXIT_TRANSCRIPT_PAGE_LIMIT as usize {
            return Err(TuiError::InvalidResponse(
                "退出记录页超过 200 条".to_owned(),
            ));
        }
        temporary.write_page(&page.items)?;
        generation = Some(page.transcript_generation);
        revision = Some(page.transcript_revision);
        cursor = page.previous_cursor;
        if cursor.is_none() {
            break;
        }
    }
    temporary.stream_reverse(&mut io::stdout())
}

#[cfg(unix)]
pub fn handshake_inherited_pipes() -> Result<(), TuiError> {
    let _pipe = ProtocolPipe::connect("lystar-rust-handshake")?;
    Ok(())
}

#[cfg(not(unix))]
pub fn handshake_inherited_pipes() -> Result<(), TuiError> {
    Err(TuiError::HelloRejected(
        "Windows named-pipe transport is not implemented".to_owned(),
    ))
}

#[cfg(unix)]
pub fn run(session_path: &str) -> Result<(), TuiError> {
    run_with_options(session_path, RunOptions::default())
}

#[cfg(unix)]
pub fn run_with_options(session_path: &str, options: RunOptions) -> Result<(), TuiError> {
    let mode = resolve_terminal_mode(options.mode, terminal_mode_context());
    let client_instance_id = std::env::var("PI_RUST_TUI_CLIENT_INSTANCE_ID")
        .unwrap_or_else(|_| format!("lystar-rust-m8-{}", std::process::id()));
    let mut pipe = ProtocolPipe::connect(&client_instance_id)?;
    let result = run_session(session_path, mode, &client_instance_id, &mut pipe);
    if mode == TerminalMode::Fullscreen
        && let Err(error) = emit_exit_output(&mut pipe, session_path, options.exit_output)
    {
        write_resume_hint(
            &mut io::stdout(),
            session_path,
            Some(&format!("读取完整记录失败：{error}")),
        )?;
    }
    result
}

fn clear_terminal_extension_output(
    app: &mut AppState,
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    image_sidecar: &mut ImageSidecar,
) -> Result<(), io::Error> {
    image_sidecar.clear(
        terminal.backend_mut().writer_mut(),
        std::env::var_os("TMUX").is_some(),
    )?;
    write_extension_title(None);
    app.extension_ui = ExtensionUiState::default();
    Ok(())
}

#[cfg(unix)]
fn run_session(
    session_path: &str,
    mode: TerminalMode,
    client_instance_id: &str,
    pipe: &mut ProtocolPipe,
) -> Result<(), TuiError> {
    let shutdown = Arc::new(AtomicBool::new(false));
    flag::register(SIGINT, Arc::clone(&shutdown))?;
    flag::register(SIGTERM, Arc::clone(&shutdown))?;
    let _terminal_guard = TerminalGuard::enter(mode).map_err(|error| TuiError::TerminalSetup {
        mode: mode.name(),
        message: error.to_string(),
    })?;
    let mut request_sequence = 0_u64;
    let mut app = AppState::default();
    let generation = app.begin_active_session(session_path.to_owned(), String::new());
    let acquire_id = request_acquire(
        pipe,
        session_path,
        client_instance_id,
        &mut request_sequence,
    )?;
    let mut session_flow = Some(SessionFlow::InitialAcquiring {
        id: acquire_id,
        path: session_path.to_owned(),
        generation,
    });
    let mut quit_requested = false;
    request_transcript(
        &mut app,
        pipe,
        session_path,
        None,
        true,
        None,
        TranscriptViewKind::Active,
        &mut request_sequence,
    )?;

    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = match mode {
        TerminalMode::Fullscreen => Terminal::new(backend)?,
        TerminalMode::Regular => Terminal::with_options(
            backend,
            TerminalOptions {
                viewport: Viewport::Inline(inline_viewport_height(crossterm::terminal::size()?.1)),
            },
        )?,
        TerminalMode::Auto => unreachable!("terminal mode must be resolved before rendering"),
    };
    let mut image_sidecar = ImageSidecar::new(if mode == TerminalMode::Fullscreen {
        current_terminal_image_protocol()
    } else {
        TerminalImageProtocol::Unknown
    });
    trace("terminal_ready");
    app.mark_page_load_pending();
    let mut dirty = true;
    let mut timeout_notified = false;
    let mut last_component_size: Option<(u16, u16)> = None;
    loop {
        if dirty {
            let area = terminal.size()?;
            let full = ratatui::layout::Rect::new(0, 0, area.width, area.height);
            let widget_budget = app.extension_widget_budget(full.height);
            let composer = composer_area_with_widget_budget(full, widget_budget);
            app.prepare_composer(composer);
            trace("draw_start");
            terminal.draw(|frame| {
                let area = frame.area();
                frame.render_widget(
                    TranscriptView::new(&app),
                    transcript_area_with_widget_budget(area, widget_budget),
                );
                frame.render_widget(
                    ComposerView::with_widget_budget(&app, usize::from(widget_budget)),
                    composer_area_with_widget_budget(area, widget_budget),
                );
                if let Some(component) = app.active_extension_overlay() {
                    let rect = extension_component_rect(&app, component, area);
                    frame.render_widget(
                        ExtensionComponentOverlayView::new(&app, component, area),
                        area,
                    );
                    if let Some((row, column)) = component.cursor
                        && row < rect.height
                        && column < rect.width
                    {
                        let inset = u16::from(
                            component.overlay_options.overlay
                                && rect.width >= 2
                                && rect.height >= 3,
                        );
                        frame.set_cursor_position((
                            rect.x.saturating_add(inset).saturating_add(column),
                            rect.y.saturating_add(inset).saturating_add(row),
                        ));
                    }
                } else if let Some(component) = app.active_extension_editor() {
                    let composer = composer_area_with_widget_budget(area, widget_budget);
                    if let Some((row, column)) = component.cursor
                        && row.saturating_add(1) < composer.height.saturating_sub(2)
                        && column < composer.width
                    {
                        frame.set_cursor_position((
                            composer.x.saturating_add(column),
                            composer.y.saturating_add(1).saturating_add(row),
                        ));
                    }
                } else {
                    frame.render_widget(WorkbenchOverlayView::new(&app), area);
                }
            })?;
            trace("draw_end");
            trace("frame_rendered");
            if app.transcript.cached_rounds() > 0 {
                trace("frame_rendered_nonempty");
            }
            render_active_osc8_link(&mut terminal, &app)?;
            if app
                .active_extension_overlay()
                .and_then(|component| component.cursor)
                .is_some()
                || app
                    .active_extension_editor()
                    .and_then(|component| component.cursor)
                    .is_some()
            {
                execute!(terminal.backend_mut().writer_mut(), Show)?;
            } else {
                execute!(terminal.backend_mut().writer_mut(), Hide)?;
            }
            image_sidecar.draw_after_frame(
                terminal.backend_mut().writer_mut(),
                visible_cached_images(&app),
                std::env::var_os("TMUX").is_some(),
            )?;
            trace_cache(&app);
            dirty = false;
        }
        if shutdown.load(Ordering::Relaxed) {
            clear_terminal_extension_output(&mut app, &mut terminal, &mut image_sidecar)?;
            release_active_session(&app, pipe, &mut request_sequence)?;
            return Ok(());
        }

        let mut state_changed = false;
        let mut handled_message = false;
        loop {
            match pipe.inbound.try_recv() {
                Ok(message) => {
                    if let Err(error) = process_inbound_message(
                        &mut app,
                        message,
                        pipe,
                        session_path,
                        client_instance_id,
                        &mut request_sequence,
                        &mut session_flow,
                        &mut quit_requested,
                    ) {
                        clear_terminal_extension_output(
                            &mut app,
                            &mut terminal,
                            &mut image_sidecar,
                        )?;
                        return Err(error);
                    }
                    handled_message = true;
                    state_changed = true;
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    app.clear_connection_state("Host 连接已断开");
                    clear_terminal_extension_output(&mut app, &mut terminal, &mut image_sidecar)?;
                    return Err(TuiError::ChildEof);
                }
            }
        }
        let size = terminal.size()?;
        if app.extension_ui.components.is_empty() {
            last_component_size = None;
        } else if last_component_size != Some((size.width, size.height)) {
            let active_path = app.active_session_path().unwrap_or(session_path).to_owned();
            request_extension_component_resize(
                &app,
                pipe,
                &active_path,
                client_instance_id,
                &mut request_sequence,
                size.width,
                size.height,
            )?;
            last_component_size = Some((size.width, size.height));
            state_changed = true;
        }
        if event::poll(Duration::ZERO)? {
            match event::read()? {
                Event::Key(key) if key.kind == KeyEventKind::Press => {
                    let overlay_component = app
                        .active_extension_overlay()
                        .map(|component| (component.component_id.clone(), component.generation));
                    let is_overlay_component = overlay_component.is_some();
                    let component = overlay_component.or_else(|| {
                        app.active_extension_editor()
                            .map(|component| (component.component_id.clone(), component.generation))
                    });
                    if let Some((component_id, generation)) = component {
                        let active_path =
                            app.active_session_path().unwrap_or(session_path).to_owned();
                        if is_overlay_component && key.code == KeyCode::Esc {
                            request_extension_component_cancel(
                                &app,
                                pipe,
                                &active_path,
                                client_instance_id,
                                &mut request_sequence,
                                &component_id,
                                generation,
                            )?;
                        } else if let Some(data) = raw_key(key.code, key.modifiers) {
                            request_extension_component_input(
                                &mut app,
                                pipe,
                                &active_path,
                                client_instance_id,
                                &mut request_sequence,
                                &component_id,
                                generation,
                                data,
                            )?;
                        }
                        state_changed = true;
                    } else if app.extension_ui.terminal_input_listener_count > 0
                        && app.input_focus == InputFocus::Composer
                        && let Some(data) = raw_key(key.code, key.modifiers)
                    {
                        let active_path =
                            app.active_session_path().unwrap_or(session_path).to_owned();
                        request_extension_terminal_input(
                            &mut app,
                            pipe,
                            &active_path,
                            client_instance_id,
                            &mut request_sequence,
                            data,
                        )?;
                        state_changed = true;
                    } else if handle_key(
                        &mut app,
                        key.code,
                        key.modifiers,
                        pipe,
                        session_path,
                        client_instance_id,
                        &mut request_sequence,
                        &mut session_flow,
                        &mut quit_requested,
                    )? {
                        clear_terminal_extension_output(
                            &mut app,
                            &mut terminal,
                            &mut image_sidecar,
                        )?;
                        release_active_session(&app, pipe, &mut request_sequence)?;
                        return Ok(());
                    } else {
                        state_changed = true;
                    }
                }
                Event::Paste(text) => {
                    let component = app
                        .active_extension_overlay()
                        .or_else(|| app.active_extension_editor())
                        .map(|component| (component.component_id.clone(), component.generation));
                    if let Some((component_id, generation)) = component {
                        if text.len().saturating_add(12) <= MAX_EXTENSION_INPUT_BYTES {
                            let active_path =
                                app.active_session_path().unwrap_or(session_path).to_owned();
                            request_extension_component_input(
                                &mut app,
                                pipe,
                                &active_path,
                                client_instance_id,
                                &mut request_sequence,
                                &component_id,
                                generation,
                                format!("\x1b[200~{text}\x1b[201~"),
                            )?;
                        }
                    } else if app.extension_ui.terminal_input_listener_count > 0
                        && app.input_focus == InputFocus::Composer
                        && text.len().saturating_add(12) <= MAX_EXTENSION_INPUT_BYTES
                    {
                        let active_path =
                            app.active_session_path().unwrap_or(session_path).to_owned();
                        request_extension_terminal_input(
                            &mut app,
                            pipe,
                            &active_path,
                            client_instance_id,
                            &mut request_sequence,
                            format!("\x1b[200~{text}\x1b[201~"),
                        )?;
                    } else if app.input_focus == InputFocus::Overlay {
                        app.overlay_insert(&text);
                    } else {
                        app.editor.insert(&text);
                    }
                    state_changed = true;
                }
                Event::Mouse(mouse) => {
                    let component = app.active_extension_overlay().and_then(|component| {
                        let area = terminal.size().ok()?;
                        let full = ratatui::layout::Rect::new(0, 0, area.width, area.height);
                        let rect = extension_component_rect(&app, component, full);
                        let inset = u16::from(
                            component.overlay_options.overlay
                                && rect.width >= 2
                                && rect.height >= 3,
                        );
                        let local_row = mouse.row.checked_sub(rect.y.saturating_add(inset))?;
                        let local_column =
                            mouse.column.checked_sub(rect.x.saturating_add(inset))?;
                        app.component_hit(
                            &component.component_id,
                            component.generation,
                            local_row,
                            local_column,
                        )
                        .then(|| (component.component_id.clone(), component.generation))
                    });
                    if let Some((component_id, generation)) = component
                        && let Some(data) = raw_mouse(mouse.kind, mouse.column, mouse.row)
                    {
                        let active_path =
                            app.active_session_path().unwrap_or(session_path).to_owned();
                        request_extension_component_input(
                            &mut app,
                            pipe,
                            &active_path,
                            client_instance_id,
                            &mut request_sequence,
                            &component_id,
                            generation,
                            data,
                        )?;
                        state_changed = true;
                    } else if app.extension_ui.terminal_input_listener_count > 0
                        && app.input_focus == InputFocus::Composer
                        && let Some(data) = raw_mouse(mouse.kind, mouse.column, mouse.row)
                    {
                        let active_path =
                            app.active_session_path().unwrap_or(session_path).to_owned();
                        request_extension_terminal_input(
                            &mut app,
                            pipe,
                            &active_path,
                            client_instance_id,
                            &mut request_sequence,
                            data,
                        )?;
                        state_changed = true;
                    } else {
                        match mouse.kind {
                            MouseEventKind::ScrollUp => {
                                if let Some(view) = readonly_view_mut(&mut app) {
                                    view.transcript.scroll_by(-3);
                                } else {
                                    app.transcript.scroll_by(-3);
                                }
                                state_changed = true;
                            }
                            MouseEventKind::ScrollDown => {
                                if let Some(view) = readonly_view_mut(&mut app) {
                                    view.transcript.scroll_by(3);
                                } else {
                                    app.transcript.scroll_by(3);
                                }
                                state_changed = true;
                            }
                            _ => {}
                        }
                    }
                }
                Event::Resize(_columns, _rows) => {
                    terminal.autoresize()?;
                    app.invalidate_rich_text();
                    app.invalidate_images();
                    last_component_size = None;
                    state_changed = true;
                }
                _ => {}
            }
        } else if !handled_message {
            let pending_work = app.has_pending_work();
            if !pending_work {
                trace("idle_poll");
            }
            match pipe
                .inbound
                .recv_timeout(Duration::from_millis(if pending_work { 2 } else { 16 }))
            {
                Ok(message) => {
                    if let Err(error) = process_inbound_message(
                        &mut app,
                        message,
                        pipe,
                        session_path,
                        client_instance_id,
                        &mut request_sequence,
                        &mut session_flow,
                        &mut quit_requested,
                    ) {
                        clear_terminal_extension_output(
                            &mut app,
                            &mut terminal,
                            &mut image_sidecar,
                        )?;
                        return Err(error);
                    }
                    state_changed = true;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    app.clear_connection_state("Host 连接已断开");
                    clear_terminal_extension_output(&mut app, &mut terminal, &mut image_sidecar)?;
                    return Err(TuiError::ChildEof);
                }
            }
        }
        if !app.pending_terminal_inputs.is_empty() {
            let expired = app
                .pending_terminal_inputs
                .iter()
                .filter(|(_, pending)| pending.started_at.elapsed() >= EXTENSION_INPUT_TIMEOUT)
                .map(|(id, pending)| (id.clone(), pending.data.clone()))
                .collect::<Vec<_>>();
            for (id, data) in expired {
                app.pending_terminal_inputs.remove(&id);
                app.set_toast("终端输入 bridge 超时，已回退本地输入");
                let active_path = app.active_session_path().unwrap_or(session_path).to_owned();
                if apply_extension_raw_input(
                    &mut app,
                    &data,
                    pipe,
                    &active_path,
                    client_instance_id,
                    &mut request_sequence,
                    &mut session_flow,
                    &mut quit_requested,
                )? {
                    quit_requested = true;
                }
                state_changed = true;
            }
        }
        for id in app.timed_out_component_inputs(EXTENSION_INPUT_TIMEOUT) {
            if let Some(pending) = app.take_component_input(&id) {
                if app.active_extension_editor().is_some_and(|component| {
                    component.component_id == pending.component_id
                        && component.generation == pending.generation
                }) {
                    app.set_toast("编辑器输入 bridge 超时，已回退本地输入");
                    let active_path = app.active_session_path().unwrap_or(session_path).to_owned();
                    if apply_extension_raw_input(
                        &mut app,
                        &pending.data,
                        pipe,
                        &active_path,
                        client_instance_id,
                        &mut request_sequence,
                        &mut session_flow,
                        &mut quit_requested,
                    )? {
                        quit_requested = true;
                    }
                } else {
                    app.set_toast("组件输入 bridge 超时，可按 Esc 取消");
                }
                trace_id("component_input_timeout", &pending.component_id);
                state_changed = true;
            }
        }
        let active_path = app.active_session_path().unwrap_or(session_path).to_owned();
        request_extension_editor_state(
            &mut app,
            pipe,
            &active_path,
            client_instance_id,
            &mut request_sequence,
        )?;
        if quit_requested && session_flow.is_none() {
            clear_terminal_extension_output(&mut app, &mut terminal, &mut image_sidecar)?;
            return Ok(());
        }
        if app.timed_out_b3_request().is_some()
            || app.timed_out_custom_editor_submit().is_some()
            || app.timed_out_attachment_submit().is_some()
        {
            if !timeout_notified {
                app.set_timeout_notice();
                state_changed = true;
                timeout_notified = true;
            }
        } else {
            timeout_notified = false;
        }
        if app.transcript.needs_previous_page()
            || app.search.pending_jump.is_some() && !app.transcript.loading_previous
        {
            if let Some(cursor) = app.transcript.take_previous_cursor() {
                let active_path = app.active_session_path().unwrap_or(session_path).to_owned();
                let context = TranscriptRequestContext {
                    generation: app.transcript.generation.clone(),
                    revision: Some(app.transcript.revision),
                    cursor: Some(cursor.clone()),
                };
                app.mark_page_load_pending();
                request_transcript(
                    &mut app,
                    pipe,
                    &active_path,
                    Some(cursor),
                    false,
                    Some(context),
                    TranscriptViewKind::Active,
                    &mut request_sequence,
                )?;
                state_changed = true;
            } else if app.search.pending_jump.is_some() {
                app.search.status = "目标不在当前可分页记录中".to_owned();
                app.search.pending_jump = None;
                state_changed = true;
            }
        }
        if let Some((path, cursor, context)) = app.readonly_view.as_mut().and_then(|view| {
            if view.transcript.needs_previous_page()
                || view.search.pending_jump.is_some() && !view.transcript.loading_previous
            {
                let cursor = view.transcript.take_previous_cursor()?;
                Some((
                    view.path.clone(),
                    cursor.clone(),
                    TranscriptRequestContext {
                        generation: view.transcript.generation.clone(),
                        revision: Some(view.transcript.revision),
                        cursor: Some(cursor),
                    },
                ))
            } else {
                None
            }
        }) {
            request_transcript(
                &mut app,
                pipe,
                &path,
                Some(cursor),
                false,
                Some(context),
                TranscriptViewKind::Readonly,
                &mut request_sequence,
            )?;
            state_changed = true;
        } else if let Some(view) = app.readonly_view.as_mut()
            && view.search.pending_jump.is_some()
            && !view.transcript.loading_previous
        {
            view.search.status = "目标不在当前可分页记录中".to_owned();
            view.search.pending_jump = None;
            state_changed = true;
        }
        if let Some(active_path) = app.active_session_path().map(str::to_owned) {
            let width = terminal.size()?.width.saturating_sub(3).clamp(1, 500);
            if request_visible_rich_text(
                &mut app,
                pipe,
                &active_path,
                width,
                &mut request_sequence,
            )? {
                state_changed = true;
            }
            if request_visible_images(&mut app, pipe, &active_path, &mut request_sequence)? {
                state_changed = true;
            }
        }
        dirty |= state_changed;
    }
}

#[cfg(not(unix))]
pub fn run_with_options(_session_path: &str, _options: RunOptions) -> Result<(), TuiError> {
    Err(TuiError::HelloRejected(
        "Windows named-pipe transport is not implemented".to_owned(),
    ))
}

#[cfg(not(unix))]
pub fn run(_session_path: &str) -> Result<(), TuiError> {
    run_with_options(_session_path, RunOptions::default())
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn process_inbound_message(
    app: &mut AppState,
    message: Result<ServerMessage, TuiError>,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    request_sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
    quit_requested: &mut bool,
) -> Result<(), TuiError> {
    let message = message?;
    if apply_server_message(
        app,
        &message,
        session_path,
        pipe,
        client_instance_id,
        request_sequence,
        session_flow,
        quit_requested,
    )? {
        let active_path = app.active_session_path().unwrap_or(session_path).to_owned();
        app.mark_page_load_pending();
        request_transcript(
            app,
            pipe,
            &active_path,
            None,
            true,
            None,
            TranscriptViewKind::Active,
            request_sequence,
        )?;
    }
    Ok(())
}

#[cfg(unix)]
fn release_active_session(
    app: &AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
) -> Result<(), TuiError> {
    let Some(context) = &app.active_session else {
        return Ok(());
    };
    let Some(lease_id) = context.lease_id.as_deref() else {
        return Ok(());
    };
    *sequence += 1;
    pipe.request(&encode_release_session_request(
        &format!("release-on-exit-{sequence}"),
        &context.path,
        lease_id,
    )?)
}

#[cfg(unix)]
fn request_acquire(
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
) -> Result<String, TuiError> {
    *sequence += 1;
    let id = format!("acquire-{sequence}");
    pipe.request(&encode_acquire_session_request(
        &id,
        session_path,
        client_instance_id,
    )?)?;
    Ok(id)
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn request_transcript(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    cursor: Option<String>,
    replace: bool,
    context: Option<TranscriptRequestContext>,
    view: TranscriptViewKind,
    sequence: &mut u64,
) -> Result<(), TuiError> {
    *sequence += 1;
    trace("read_transcript");
    let id = format!("{}-{sequence}", if replace { "initial" } else { "older" });
    app.begin_transcript_request(
        id.clone(),
        view,
        if replace {
            TranscriptRequestKind::Initial
        } else {
            TranscriptRequestKind::Older
        },
        session_path.to_owned(),
        match view {
            TranscriptViewKind::Active => app.session_generation,
            TranscriptViewKind::Readonly => app
                .readonly_view
                .as_ref()
                .map_or(0, |readonly| readonly.generation),
        },
        context.clone(),
    );
    pipe.request(&encode_read_transcript_request(
        &id,
        session_path,
        if replace {
            INITIAL_PAGE_LIMIT
        } else {
            PAGE_LIMIT
        },
        cursor.as_deref(),
        context.as_ref(),
    )?)
}

#[cfg(unix)]
fn request_search(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    query: &str,
    view: TranscriptViewKind,
    sequence: &mut u64,
) -> Result<(), TuiError> {
    *sequence += 1;
    trace("search_transcript");
    let id = format!("search-{sequence}");
    app.begin_transcript_request(
        id.clone(),
        view,
        TranscriptRequestKind::Search,
        session_path.to_owned(),
        match view {
            TranscriptViewKind::Active => app.session_generation,
            TranscriptViewKind::Readonly => app
                .readonly_view
                .as_ref()
                .map_or(0, |readonly| readonly.generation),
        },
        None,
    );
    pipe.request(&encode_search_transcript_request(
        &id,
        session_path,
        query,
        SEARCH_LIMIT,
    )?)
}

fn request_extension_editor_state(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
) -> Result<(), TuiError> {
    let Some(lease_id) = app.lease_id.clone() else {
        return Ok(());
    };
    let Some((text, cursor, revision)) = app.take_editor_state_update() else {
        return Ok(());
    };
    *sequence += 1;
    pipe.request(&encode_extension_editor_state_request(
        &format!("extension-editor-{sequence}"),
        session_path,
        &lease_id,
        client_instance_id,
        &text,
        cursor,
        revision,
        Some(app.extension_ui.revision),
    )?)
}

#[allow(clippy::too_many_arguments)]
fn request_extension_component_input(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    component_id: &str,
    generation: u64,
    data: String,
) -> Result<bool, TuiError> {
    let Some(lease_id) = app.lease_id.as_deref() else {
        return Ok(false);
    };
    if data.is_empty()
        || data.len() > MAX_EXTENSION_INPUT_BYTES
        || app.has_pending_component_input(component_id, generation, &data)
    {
        return Ok(false);
    }
    *sequence += 1;
    let id = format!("component-input-{sequence}");
    app.pending_component_inputs.insert(
        id.clone(),
        crate::app::PendingComponentInput {
            component_id: component_id.to_owned(),
            generation,
            data: data.clone(),
            started_at: Instant::now(),
        },
    );
    trace_id("component_input_requested", &id);
    pipe.request(&encode_extension_component_input_request(
        &id,
        session_path,
        lease_id,
        client_instance_id,
        component_id,
        generation,
        &data,
    )?)?;
    Ok(true)
}

fn request_extension_component_resize(
    app: &AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    width: u16,
    height: u16,
) -> Result<(), TuiError> {
    let Some(lease_id) = app.lease_id.as_deref() else {
        return Ok(());
    };
    *sequence += 1;
    pipe.request(&encode_extension_component_resize_request(
        &format!("component-resize-{sequence}"),
        session_path,
        lease_id,
        client_instance_id,
        width.clamp(1, 500),
        height.clamp(1, 500),
    )?)
}

fn request_extension_component_cancel(
    app: &AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    component_id: &str,
    generation: u64,
) -> Result<(), TuiError> {
    let Some(lease_id) = app.lease_id.as_deref() else {
        return Ok(());
    };
    *sequence += 1;
    pipe.request(&encode_extension_component_cancel_request(
        &format!("component-cancel-{sequence}"),
        session_path,
        lease_id,
        client_instance_id,
        component_id,
        generation,
    )?)
}

fn request_extension_terminal_input(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    data: String,
) -> Result<(), TuiError> {
    let Some(lease_id) = app.lease_id.as_deref() else {
        return Ok(());
    };
    if data.is_empty() || data.len() > MAX_EXTENSION_INPUT_BYTES {
        return Ok(());
    }
    *sequence += 1;
    let id = format!("extension-input-{sequence}");
    trace_id("extension_input_requested", &id);
    app.pending_terminal_inputs.insert(
        id.clone(),
        PendingTerminalInput {
            data: data.clone(),
            started_at: Instant::now(),
        },
    );
    pipe.request(&encode_extension_terminal_input_request(
        &id,
        session_path,
        lease_id,
        client_instance_id,
        &data,
    )?)
}

fn raw_key(code: KeyCode, modifiers: KeyModifiers) -> Option<String> {
    let value = match code {
        KeyCode::Char(character)
            if modifiers.contains(KeyModifiers::CONTROL) && character.is_ascii() =>
        {
            let upper = character.to_ascii_uppercase() as u8;
            ((upper & 0x1f) as char).to_string()
        }
        KeyCode::Char(character)
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
        {
            character.to_string()
        }
        KeyCode::Enter if modifiers.contains(KeyModifiers::ALT) => "\x1b\r".to_owned(),
        KeyCode::Enter => "\r".to_owned(),
        KeyCode::Tab => "\t".to_owned(),
        KeyCode::Backspace => "\x7f".to_owned(),
        KeyCode::Esc => "\x1b".to_owned(),
        KeyCode::Up => "\x1b[A".to_owned(),
        KeyCode::Down => "\x1b[B".to_owned(),
        KeyCode::Right => "\x1b[C".to_owned(),
        KeyCode::Left => "\x1b[D".to_owned(),
        KeyCode::Home => "\x1b[H".to_owned(),
        KeyCode::End => "\x1b[F".to_owned(),
        KeyCode::PageUp => "\x1b[5~".to_owned(),
        KeyCode::PageDown => "\x1b[6~".to_owned(),
        KeyCode::Delete => "\x1b[3~".to_owned(),
        KeyCode::F(number @ 1..=4) => {
            format!("\x1bO{}", ["P", "Q", "R", "S"][(number - 1) as usize])
        }
        KeyCode::F(number @ 5..=12) => format!(
            "\x1b[{}~",
            [15, 17, 18, 19, 20, 21, 23, 24][(number - 5) as usize]
        ),
        _ => return None,
    };
    Some(value)
}

fn raw_mouse(kind: MouseEventKind, column: u16, row: u16) -> Option<String> {
    let (code, suffix) = match kind {
        MouseEventKind::Down(_) => (0, 'M'),
        MouseEventKind::Up(_) => (3, 'm'),
        MouseEventKind::Drag(_) => (32, 'M'),
        MouseEventKind::Moved => (35, 'M'),
        MouseEventKind::ScrollUp => (64, 'M'),
        MouseEventKind::ScrollDown => (65, 'M'),
        MouseEventKind::ScrollLeft => (66, 'M'),
        MouseEventKind::ScrollRight => (67, 'M'),
    };
    Some(format!(
        "\x1b[<{code};{};{}{suffix}",
        column.saturating_add(1),
        row.saturating_add(1)
    ))
}

fn interrupt_active_operation(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
) -> Result<(), TuiError> {
    let Some(lease_id) = app.lease_id.clone() else {
        return Ok(());
    };
    let Some(operation_id) = app.operation.as_ref().and_then(|operation| {
        matches!(
            operation.status.as_str(),
            "accepted" | "running" | "waiting_for_input"
        )
        .then(|| operation.operation_id.clone())
    }) else {
        return Ok(());
    };
    *sequence += 1;
    pipe.request(&encode_abort_operation_request(
        &format!("abort-{sequence}"),
        &operation_id,
        &lease_id,
    )?)?;
    if let Some(operation) = app.operation.as_mut()
        && operation.operation_id == operation_id
    {
        operation.status = "aborting".to_owned();
    }
    app.transcript.status = "正在停止".to_owned();
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn apply_extension_editor_app_action(
    app: &mut AppState,
    action: &str,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
    quit_requested: &mut bool,
) -> Result<(), TuiError> {
    let active_path = app.active_session_path().unwrap_or(session_path).to_owned();
    match action {
        "app.interrupt" => interrupt_active_operation(app, pipe, sequence)?,
        "app.clear" => app.editor.clear(),
        "app.exit" => *quit_requested = true,
        "app.clipboard.pasteImage" => {
            request_clipboard_both(app, pipe, sequence, ClipboardReadTarget::Insert)?;
        }
        "app.model.cycleForward" | "app.model.cycleBackward" | "app.model.select" => {
            open_workbench(
                app,
                "model",
                pipe,
                &active_path,
                client_instance_id,
                sequence,
                session_flow,
            )?;
        }
        "app.thinking.cycle" | "app.thinking.toggle" => {
            open_workbench(
                app,
                "thinking",
                pipe,
                &active_path,
                client_instance_id,
                sequence,
                session_flow,
            )?;
        }
        "app.tools.expand" => app.transcript.toggle_current_tool(),
        "extension_shortcut" => app.set_toast("扩展快捷键未处理"),
        "app.message.followUp" => {
            submit_custom_editor(
                app,
                pipe,
                &active_path,
                client_instance_id,
                sequence,
                true,
                session_flow,
            )?;
        }
        _ => app.set_toast("自定义编辑器动作已接收"),
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn apply_extension_raw_input(
    app: &mut AppState,
    data: &str,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
    quit_requested: &mut bool,
) -> Result<bool, TuiError> {
    if let Some(text) = data
        .strip_prefix("\x1b[200~")
        .and_then(|value| value.strip_suffix("\x1b[201~"))
    {
        app.editor.insert(text);
        return Ok(false);
    }
    let (code, modifiers) = match data {
        "\r" | "\n" => (KeyCode::Enter, KeyModifiers::NONE),
        "\t" => (KeyCode::Tab, KeyModifiers::NONE),
        "\x7f" => (KeyCode::Backspace, KeyModifiers::NONE),
        "\x1b" => (KeyCode::Esc, KeyModifiers::NONE),
        "\x1b[A" => (KeyCode::Up, KeyModifiers::NONE),
        "\x1b[B" => (KeyCode::Down, KeyModifiers::NONE),
        "\x1b[C" => (KeyCode::Right, KeyModifiers::NONE),
        "\x1b[D" => (KeyCode::Left, KeyModifiers::NONE),
        "\x1b[H" => (KeyCode::Home, KeyModifiers::NONE),
        "\x1b[F" => (KeyCode::End, KeyModifiers::NONE),
        "\x1b[5~" => (KeyCode::PageUp, KeyModifiers::NONE),
        "\x1b[6~" => (KeyCode::PageDown, KeyModifiers::NONE),
        "\x04" => {
            if app.editor.is_empty() {
                return handle_key(
                    app,
                    KeyCode::Char('q'),
                    KeyModifiers::NONE,
                    pipe,
                    session_path,
                    client_instance_id,
                    sequence,
                    session_flow,
                    quit_requested,
                );
            }
            app.editor.delete();
            return Ok(false);
        }
        "\x1b\r" => (KeyCode::Enter, KeyModifiers::ALT),
        value if value.len() == 1 && (1..=26).contains(&value.as_bytes()[0]) => (
            KeyCode::Char((b'a' + value.as_bytes()[0] - 1) as char),
            KeyModifiers::CONTROL,
        ),
        value if value.chars().count() == 1 => {
            let character = value.chars().next().unwrap_or_default();
            if character.is_ascii_control() {
                return Ok(false);
            }
            (KeyCode::Char(character), KeyModifiers::NONE)
        }
        _ => {
            app.editor.insert(data);
            return Ok(false);
        }
    };
    handle_key(
        app,
        code,
        modifiers,
        pipe,
        session_path,
        client_instance_id,
        sequence,
        session_flow,
        quit_requested,
    )
}

#[cfg(unix)]
fn is_readonly_overlay(app: &AppState) -> bool {
    matches!(app.overlay(), Some(OverlayState::Detail(detail)) if detail.title == "会话只读")
}

#[cfg(unix)]
fn readonly_view_mut(app: &mut AppState) -> Option<&mut ReadonlySessionView> {
    is_readonly_overlay(app)
        .then_some(app.readonly_view.as_mut())
        .flatten()
}

#[cfg(unix)]
fn refresh_readonly_overlay(app: &mut AppState) {
    if let Some(view) = app.readonly_view.clone()
        && is_readonly_overlay(app)
    {
        app.replace_overlay(readonly_overlay(&view));
    }
}

#[cfg(unix)]
fn handle_readonly_key(
    app: &mut AppState,
    code: KeyCode,
    modifiers: KeyModifiers,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
) -> Result<bool, TuiError> {
    let mut search_request = None;
    let mut close_view = false;
    if let Some(view) = readonly_view_mut(app) {
        if view.search.open {
            match code {
                KeyCode::Esc => view.search.open = false,
                KeyCode::Enter => {
                    if view.search.query.trim().is_empty() {
                        view.search.status = "请输入搜索内容".to_owned();
                    } else if let Some(entry_id) = view
                        .search
                        .hits
                        .get(view.search.selected)
                        .map(|hit| hit.entry_id.clone())
                    {
                        if view.transcript.jump_to(&entry_id) {
                            view.search.status = "已跳转".to_owned();
                        } else {
                            view.search.pending_jump = Some(entry_id);
                            view.search.status = "正在加载目标记录".to_owned();
                        }
                    } else {
                        search_request = Some((view.path.clone(), view.search.query.clone()));
                    }
                }
                KeyCode::Up => view.search.selected = view.search.selected.saturating_sub(1),
                KeyCode::Down => {
                    view.search.selected =
                        (view.search.selected + 1).min(view.search.hits.len().saturating_sub(1));
                }
                KeyCode::Backspace => {
                    view.search.query.pop();
                    view.search.hits.clear();
                    view.search.selected = 0;
                }
                KeyCode::Char(character) if !modifiers.contains(KeyModifiers::CONTROL) => {
                    view.search.query.push(character);
                    view.search.hits.clear();
                    view.search.selected = 0;
                }
                _ => {}
            }
        } else {
            match code {
                KeyCode::Esc => close_view = true,
                KeyCode::Char('f') if modifiers.contains(KeyModifiers::CONTROL) => {
                    view.search.open = true;
                    view.search.status.clear();
                }
                KeyCode::Char('o') if modifiers.contains(KeyModifiers::CONTROL) => {
                    view.transcript.toggle_current_tool();
                }
                KeyCode::Up => view.transcript.scroll_by(-1),
                KeyCode::Down => view.transcript.scroll_by(1),
                KeyCode::PageUp => view.transcript.scroll_by(-20),
                KeyCode::PageDown => view.transcript.scroll_by(20),
                KeyCode::Home => {
                    view.transcript.current = 0;
                    view.transcript.scroll = 0;
                }
                KeyCode::End => {
                    let last = view.transcript.cached_rounds().saturating_sub(1);
                    view.transcript.current = last;
                    view.transcript.scroll = last;
                }
                _ => {}
            }
        }
    }
    if close_view {
        app.readonly_view = None;
        app.invalidate_transcript_requests(TranscriptViewKind::Readonly);
        app.close_overlay();
        return Ok(false);
    }
    if let Some((path, query)) = search_request {
        request_search(
            app,
            pipe,
            &path,
            &query,
            TranscriptViewKind::Readonly,
            sequence,
        )?;
    }
    refresh_readonly_overlay(app);
    Ok(false)
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn handle_key(
    app: &mut AppState,
    code: KeyCode,
    modifiers: KeyModifiers,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
    quit_requested: &mut bool,
) -> Result<bool, TuiError> {
    let session_path = app.active_session_path().unwrap_or(session_path).to_owned();
    if matches!(code, KeyCode::Char('c')) && modifiers.contains(KeyModifiers::CONTROL) {
        interrupt_active_operation(app, pipe, sequence)?;
        return Ok(false);
    }
    if is_readonly_overlay(app) {
        return handle_readonly_key(app, code, modifiers, pipe, sequence);
    }
    if app.search.open {
        match code {
            KeyCode::Esc => {
                app.close_search();
                trace("search_close");
            }
            KeyCode::Enter => {
                if app.search.query.trim().is_empty() {
                    app.search.status = "请输入搜索内容".to_owned();
                } else if app.select_search_result().is_none() {
                    let query = app.search.query.clone();
                    trace("search_submit");
                    request_search(
                        app,
                        pipe,
                        &session_path,
                        &query,
                        TranscriptViewKind::Active,
                        sequence,
                    )?;
                }
            }
            KeyCode::Up => app.search.selected = app.search.selected.saturating_sub(1),
            KeyCode::Down => {
                app.search.selected =
                    (app.search.selected + 1).min(app.search.hits.len().saturating_sub(1))
            }
            KeyCode::Backspace => {
                app.search.query.pop();
                app.search.hits.clear();
            }
            KeyCode::Char(character) if !modifiers.contains(KeyModifiers::CONTROL) => {
                app.search.query.push(character)
            }
            _ => {}
        }
        return Ok(false);
    }

    if matches!(code, KeyCode::Char('p')) && modifiers.contains(KeyModifiers::CONTROL) {
        app.open_overlay(OverlayState::List(ListOverlay {
            title: "命令面板".to_owned(),
            origin: OverlayOrigin::User,
            items: [
                ("subagents", "Subagent"),
                ("clipboard", "剪贴板"),
                ("changes", "变更"),
                ("skills", "技能"),
                ("trust", "项目信任"),
                ("instructions", "指令"),
                ("packages", "包"),
                ("update", "更新检查"),
                ("sessions", "会话"),
                ("tree", "分支树"),
                ("help", "帮助"),
                ("settings", "设置"),
                ("model", "模型"),
                ("thinking", "思考"),
                ("login", "登录"),
                ("about", "关于"),
                ("doctor", "诊断"),
            ]
            .into_iter()
            .map(|(target, detail)| OverlayItem {
                label: format!("/{target}"),
                detail: detail.to_owned(),
                action: format!("open:{target}"),
            })
            .collect(),
            selected: 0,
            filter: String::new(),
            status: "输入筛选，Enter 打开".to_owned(),
        }));
        return Ok(false);
    }

    if app.input_focus == InputFocus::Overlay {
        return handle_overlay_key(
            app,
            code,
            modifiers,
            pipe,
            &session_path,
            client_instance_id,
            sequence,
            session_flow,
        );
    }

    if matches!(code, KeyCode::Esc) {
        interrupt_active_operation(app, pipe, sequence)?;
        return Ok(false);
    }

    match code {
        KeyCode::Char('q') if app.editor.is_empty() => {
            *quit_requested = true;
            if session_flow.is_some() {
                return Ok(false);
            }
            let Some(lease_id) = app.lease_id.clone() else {
                return Ok(true);
            };
            *sequence += 1;
            let id = format!("quit-release-{sequence}");
            *session_flow = Some(SessionFlow::QuitReleasing { id: id.clone() });
            pipe.request(&encode_release_session_request(
                &id,
                &session_path,
                &lease_id,
            )?)?;
        }
        KeyCode::Char('f') if modifiers.contains(KeyModifiers::CONTROL) => {
            app.open_search();
            trace("search_open");
        }
        KeyCode::Char('V') if modifiers.contains(KeyModifiers::CONTROL) => {
            request_clipboard_both(app, pipe, sequence, ClipboardReadTarget::Insert)?;
        }
        KeyCode::Char('v') if modifiers.contains(KeyModifiers::CONTROL | KeyModifiers::SHIFT) => {
            request_clipboard_both(app, pipe, sequence, ClipboardReadTarget::Insert)?;
        }
        KeyCode::Char('v') if modifiers.contains(KeyModifiers::CONTROL) => {
            request_clipboard_read(app, pipe, sequence, true)?;
        }
        KeyCode::Char('y') if modifiers.contains(KeyModifiers::CONTROL) => {
            if let Some(text) = app.context_copy_text() {
                request_clipboard_write(
                    app,
                    pipe,
                    client_instance_id,
                    sequence,
                    text,
                    "已复制上下文",
                )?;
            } else {
                app.set_overlay_error("当前没有可复制的文本");
            }
        }
        KeyCode::Char('o')
            if modifiers.contains(KeyModifiers::CONTROL)
                && app.transcript.current_tool_is_subagent() =>
        {
            open_workbench(
                app,
                "subagents",
                pipe,
                &session_path,
                client_instance_id,
                sequence,
                session_flow,
            )?;
        }
        KeyCode::Char('o') if modifiers.contains(KeyModifiers::CONTROL) => {
            app.transcript.toggle_current_tool()
        }
        KeyCode::Char('u') if modifiers.contains(KeyModifiers::CONTROL) => app.editor.clear(),
        KeyCode::Char('z') if modifiers.contains(KeyModifiers::CONTROL) => app.editor.undo(),
        KeyCode::Char('r') if modifiers.contains(KeyModifiers::CONTROL) => {
            if app.recovery_draft.is_some() {
                open_custom_editor_recovery(app);
            } else if let Some((id, submit)) = app.restart_timed_out_custom_editor_submit() {
                let images = submit
                    .attachments
                    .iter()
                    .map(|attachment| {
                        serde_json::json!({ "data": attachment.base64, "mimeType": attachment.mime_type })
                    })
                    .collect::<Vec<_>>();
                pipe.request(&encode_queue_request(
                    &id,
                    &submit.command,
                    &submit.session_path,
                    &submit.lease_id,
                    &submit.client_instance_id,
                    &submit.client_request_id,
                    Some(&submit.text),
                    Some(&images),
                )?)?;
                app.set_toast("正在重试提交");
            } else if let Some((id, submit)) = app.restart_timed_out_attachment_submit() {
                let images = submit
                    .attachments
                    .iter()
                    .map(|attachment| {
                        serde_json::json!({ "data": attachment.base64, "mimeType": attachment.mime_type })
                    })
                    .collect::<Vec<_>>();
                pipe.request(&encode_queue_request(
                    &id,
                    &submit.command,
                    &submit.session_path,
                    &submit.lease_id,
                    &submit.client_instance_id,
                    &submit.client_request_id,
                    Some(&submit.text),
                    Some(&images),
                )?)?;
                app.set_toast("正在重试提交");
            } else {
                app.editor.redo();
            }
        }
        KeyCode::Char('j') if modifiers.contains(KeyModifiers::CONTROL) => app.editor.insert("\n"),
        KeyCode::Tab if app.editor.text().starts_with("/attach ") => {
            request_attach_completion(app, pipe, sequence)?;
        }
        KeyCode::Enter if modifiers.contains(KeyModifiers::SHIFT) => app.editor.insert("\n"),
        KeyCode::Enter => submit_editor(
            app,
            pipe,
            &session_path,
            client_instance_id,
            sequence,
            modifiers.contains(KeyModifiers::ALT),
            session_flow,
        )?,
        KeyCode::Backspace => app.editor.backspace(),
        KeyCode::Delete => app.editor.delete(),
        KeyCode::Left => app.editor.move_left(),
        KeyCode::Right => app.editor.move_right(),
        KeyCode::Home => {
            app.editor.move_home();
            if app.editor.is_empty() {
                trace("key_home");
                app.transcript.current = 0;
                app.transcript.scroll = 0;
            }
        }
        KeyCode::End => {
            app.editor.move_end();
            if app.editor.is_empty() {
                trace("key_end");
                let last = app.transcript.cached_rounds().saturating_sub(1);
                app.transcript.current = last;
                app.transcript.scroll = last;
            }
        }
        KeyCode::Up if app.editor.at_first_visual_line_start(app.composer_width()) => {
            app.editor.history_previous();
        }
        KeyCode::Down if app.editor.at_last_visual_line(app.composer_width()) => {
            app.editor.history_next();
        }
        KeyCode::Up => app.editor.move_up(),
        KeyCode::Down => app.editor.move_down(),
        KeyCode::PageUp => {
            trace("key_page_up");
            app.transcript.scroll_by(-20);
        }
        KeyCode::PageDown => app.transcript.scroll_by(20),
        KeyCode::Char(character)
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
        {
            app.editor.insert(&character.to_string())
        }
        _ => {}
    }
    Ok(false)
}

fn builtin_slash_command(text: &str) -> Option<&'static str> {
    match text.trim() {
        "/subagents" => Some("subagents"),
        "/clipboard" => Some("clipboard"),
        "/changes" => Some("changes"),
        "/skills" => Some("skills"),
        "/trust" => Some("trust"),
        "/instructions" => Some("instructions"),
        "/packages" => Some("packages"),
        "/update" => Some("update"),
        "/about" => Some("about"),
        "/doctor" => Some("doctor"),
        "/help" => Some("help"),
        "/sessions" => Some("sessions"),
        "/tree" => Some("tree"),
        "/settings" => Some("settings"),
        "/model" => Some("model"),
        "/thinking" => Some("thinking"),
        "/login" => Some("login"),
        _ => None,
    }
}

#[cfg(unix)]
fn open_readonly_session(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
    path: String,
) -> Result<(), TuiError> {
    let generation = app
        .readonly_view
        .as_ref()
        .map_or(1, |readonly| readonly.generation.saturating_add(1));
    *sequence += 1;
    let id = format!("readonly-initial-{sequence}");
    *session_flow = Some(SessionFlow::Readonly {
        id: id.clone(),
        path: path.clone(),
        replace: true,
        generation,
    });
    app.readonly_view = Some(ReadonlySessionView {
        path: path.clone(),
        generation,
        status: "正在读取".to_owned(),
        ..ReadonlySessionView::default()
    });
    app.open_overlay(OverlayState::Detail(DetailOverlay {
        title: "会话只读".to_owned(),
        lines: vec!["正在读取".to_owned()],
        scroll: 0,
        status: "只读".to_owned(),
        link: None,
        copy_text: None,
    }));
    app.begin_transcript_request(
        id.clone(),
        TranscriptViewKind::Readonly,
        TranscriptRequestKind::Initial,
        path.clone(),
        generation,
        None,
    );
    pipe.request(&encode_read_transcript_request(
        &id,
        &path,
        INITIAL_PAGE_LIMIT,
        None,
        None,
    )?)
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn handle_overlay_key(
    app: &mut AppState,
    code: KeyCode,
    modifiers: KeyModifiers,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
) -> Result<bool, TuiError> {
    if matches!(code, KeyCode::Char('q'))
        && !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
        && app.is_recovery_session_chooser()
    {
        return Ok(true);
    }
    match code {
        KeyCode::Esc => {
            if let Some(request) = app.take_ui_response() {
                pipe.request(&encode_ui_response(&request.id, None, None, Some(true))?)?;
                app.set_toast("已取消输入");
            }
            if matches!(app.overlay(), Some(OverlayState::Detail(detail)) if detail.title == "会话只读")
            {
                app.readonly_view = None;
                app.invalidate_transcript_requests(TranscriptViewKind::Readonly);
            }
            if matches!(app.overlay(), Some(OverlayState::Detail(detail)) if detail.title == "图片预览")
            {
                app.attachment_preview = None;
            }
            app.close_overlay();
        }
        KeyCode::Up => app.move_overlay_selection(-1),
        KeyCode::Down => app.move_overlay_selection(1),
        KeyCode::PageUp => app.overlay_page(-1),
        KeyCode::PageDown => app.overlay_page(1),
        KeyCode::Home => app.overlay_home_end(false),
        KeyCode::End => app.overlay_home_end(true),
        KeyCode::Char('V') if modifiers.contains(KeyModifiers::CONTROL) => {
            request_clipboard_both(app, pipe, sequence, ClipboardReadTarget::Insert)?;
        }
        KeyCode::Char('v') if modifiers.contains(KeyModifiers::CONTROL | KeyModifiers::SHIFT) => {
            request_clipboard_both(app, pipe, sequence, ClipboardReadTarget::Insert)?;
        }
        KeyCode::Char('v') if modifiers.contains(KeyModifiers::CONTROL) => {
            request_clipboard_read(app, pipe, sequence, true)?;
        }
        KeyCode::Char('y') if modifiers.contains(KeyModifiers::CONTROL) => {
            if let Some(text) = app.context_copy_text() {
                request_clipboard_write(
                    app,
                    pipe,
                    client_instance_id,
                    sequence,
                    text,
                    "已复制上下文",
                )?;
            } else {
                app.set_overlay_error("当前没有可复制的文本");
            }
        }
        KeyCode::Char('r')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "Subagent")
                && app.timed_out_b3_request().is_none() =>
        {
            let filter = match app.overlay() {
                Some(OverlayState::List(list)) => list.filter.clone(),
                _ => String::new(),
            };
            let parent = app
                .subagent_parent_path
                .clone()
                .unwrap_or_else(|| session_path.to_owned());
            request_subagents(app, pipe, sequence, parent, None, filter)?;
        }
        KeyCode::Char('a')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "Subagent") =>
        {
            if let Some(index) = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("subagent:"))
                .and_then(|value| value.parse::<usize>().ok())
                && let Some(snapshot) = app.subagents.get(index)
            {
                if !snapshot.controllable || !subagent_running(&snapshot.state) {
                    app.set_overlay_error("当前 Subagent 不能停止");
                } else if app.active_session_path() != Some(snapshot.parent_session_path.as_str()) {
                    app.set_overlay_error("只允许控制当前会话的 Subagent");
                } else {
                    app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                        title: "停止 Subagent".to_owned(),
                        message: format!("确认停止 {}？", snapshot.name),
                        confirm_action: format!("subagent-abort:{index}"),
                        status: String::new(),
                    }));
                }
            }
        }
        KeyCode::Char('c')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "Subagent") =>
        {
            if let Some(index) = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("subagent:"))
                .and_then(|value| value.parse::<usize>().ok())
                && let Some(snapshot) = app.subagents.get(index)
            {
                if subagent_running(&snapshot.state) || snapshot.session_file.is_none() {
                    app.set_overlay_error("运行中的或无持久会话的 Subagent 不能继续");
                } else if app.active_session_path() != Some(snapshot.parent_session_path.as_str()) {
                    app.set_overlay_error("只允许控制当前会话的 Subagent");
                } else {
                    app.open_overlay(OverlayState::TextEditor(TextEditorOverlay {
                        title: format!("继续 {}", snapshot.name),
                        value: String::new(),
                        cursor: 0,
                        save_action: format!("subagent-continue:{index}"),
                        status: "Enter 继续，Shift+Enter 换行，Esc 取消".to_owned(),
                        secret: false,
                    }));
                }
            }
        }
        KeyCode::Char('i')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::Detail(detail)) if detail.title == "剪贴板") =>
        {
            if let Some(text) = app
                .clipboard
                .as_ref()
                .and_then(|clipboard| clipboard.text.as_deref())
            {
                app.editor.insert(text);
                app.set_toast("已插入剪贴板文本");
            } else {
                app.set_overlay_error("剪贴板没有文本");
            }
        }
        KeyCode::Char('w')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::Detail(detail)) if detail.title == "剪贴板") =>
        {
            request_clipboard_write(
                app,
                pipe,
                client_instance_id,
                sequence,
                app.editor.text().to_owned(),
                "已写入剪贴板",
            )?;
        }
        KeyCode::Char('v')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::Detail(detail)) if detail.title == "Subagent 详情") =>
        {
            if let Some(path) = app
                .subagent_detail
                .as_ref()
                .and_then(|snapshot| snapshot.session_file.clone())
            {
                open_readonly_session(app, pipe, sequence, session_flow, path)?;
            } else {
                app.set_overlay_error("Subagent 没有持久 Session");
            }
        }
        KeyCode::Enter if matches!(app.overlay(), Some(OverlayState::Detail(detail)) if detail.title == "Subagent 详情") => {
            if let Some(path) = app
                .subagent_detail
                .as_ref()
                .and_then(|snapshot| snapshot.session_file.clone())
            {
                app.open_workspace_overlay(
                    format!("subagents:{path}"),
                    OverlayState::Detail(DetailOverlay {
                        title: "Subagent".to_owned(),
                        lines: vec!["正在读取嵌套 Subagent".to_owned()],
                        scroll: 0,
                        status: "请稍候".to_owned(),
                        link: None,
                        copy_text: None,
                    }),
                );
                request_subagents(app, pipe, sequence, path, None, String::new())?;
            } else {
                app.set_overlay_error("Subagent 没有持久 Session");
            }
        }
        KeyCode::Tab if matches!(app.overlay(), Some(OverlayState::List(list)) if list.title.starts_with("变更 [")) =>
        {
            app.changes_tab = match app.changes_tab {
                ChangesTab::Staged => ChangesTab::Unstaged,
                ChangesTab::Unstaged => ChangesTab::All,
                ChangesTab::All => ChangesTab::Staged,
            };
            let filter = match app.overlay() {
                Some(OverlayState::List(list)) => list.filter.clone(),
                _ => String::new(),
            };
            app.replace_overlay(changes_overlay(app, None, filter));
        }
        KeyCode::Tab if matches!(app.overlay(), Some(OverlayState::List(list)) if list.title.starts_with("指令 [")) =>
        {
            let filter = match app.overlay() {
                Some(OverlayState::List(list)) => list.filter.clone(),
                _ => String::new(),
            };
            let target = if matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "指令 [项目]")
            {
                WorkbenchTarget::InstructionsHost
            } else {
                WorkbenchTarget::InstructionsProject
            };
            request_workspace_load(app, pipe, sequence, target, None, filter)?;
        }
        KeyCode::Char('o')
            if modifiers.contains(KeyModifiers::CONTROL)
                && matches!(app.overlay(), Some(OverlayState::Detail(detail)) if detail.title == "变更详情") =>
        {
            app.change_detail_expanded = !app.change_detail_expanded;
            app.replace_overlay(change_detail_overlay(app));
        }
        KeyCode::Char('r')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title.starts_with("变更 [")) =>
        {
            let filter = match app.overlay() {
                Some(OverlayState::List(list)) => list.filter.clone(),
                _ => String::new(),
            };
            request_workspace_load(app, pipe, sequence, WorkbenchTarget::Changes, None, filter)?;
        }
        KeyCode::Char('r')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "技能") =>
        {
            let filter = match app.overlay() {
                Some(OverlayState::List(list)) => list.filter.clone(),
                _ => String::new(),
            };
            request_workspace_load(app, pipe, sequence, WorkbenchTarget::Skills, None, filter)?;
        }
        KeyCode::Char('r')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title.starts_with("指令 [")) =>
        {
            let (target, filter) = match app.overlay() {
                Some(OverlayState::List(list)) => (
                    if list.title == "指令 [项目]" {
                        WorkbenchTarget::InstructionsProject
                    } else {
                        WorkbenchTarget::InstructionsHost
                    },
                    list.filter.clone(),
                ),
                _ => (WorkbenchTarget::InstructionsProject, String::new()),
            };
            request_workspace_load(app, pipe, sequence, target, None, filter)?;
        }
        KeyCode::Char('r')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "包") =>
        {
            let filter = match app.overlay() {
                Some(OverlayState::List(list)) => list.filter.clone(),
                _ => String::new(),
            };
            request_workspace_load(app, pipe, sequence, WorkbenchTarget::Packages, None, filter)?;
        }
        KeyCode::Char('r')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::Detail(detail)) if detail.title == "更新检查") =>
        {
            request_workspace_load(
                app,
                pipe,
                sequence,
                WorkbenchTarget::Update,
                None,
                String::new(),
            )?;
        }
        KeyCode::Char('t')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "项目信任") =>
        {
            activate_workbench_action(
                app,
                "trust:toggle",
                pipe,
                session_path,
                client_instance_id,
                sequence,
                session_flow,
            )?;
        }
        KeyCode::Char('i')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "包") =>
        {
            app.open_overlay(OverlayState::TextEditor(TextEditorOverlay {
                title: "安装包来源".to_owned(),
                value: String::new(),
                cursor: 0,
                save_action: "package-install-source".to_owned(),
                status: "Enter 选择作用域，Shift+Enter 换行，Esc 取消".to_owned(),
                secret: false,
            }));
        }
        KeyCode::Char('d')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "图片附件") =>
        {
            if let Some(index) = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("attachment:"))
                .and_then(|value| value.parse::<usize>().ok())
            {
                app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                    title: "删除图片附件".to_owned(),
                    message: "确认删除当前图片附件？".to_owned(),
                    confirm_action: format!("attachment-remove:{index}"),
                    status: String::new(),
                }));
            }
        }
        KeyCode::Char('D')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "图片附件") =>
        {
            if app.attachments.is_empty() {
                app.set_toast("没有可清空的图片附件");
            } else {
                app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                    title: "清空图片附件".to_owned(),
                    message: "确认清空全部图片附件？".to_owned(),
                    confirm_action: "attachment-clear".to_owned(),
                    status: String::new(),
                }));
            }
        }
        KeyCode::Char('d')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "包") =>
        {
            if let Some(index) = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("package:"))
                .and_then(|value| value.parse::<usize>().ok())
            {
                app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                    title: "删除包".to_owned(),
                    message: "确认移除当前包配置？".to_owned(),
                    confirm_action: format!("package-remove:{index}"),
                    status: String::new(),
                }));
            }
        }
        KeyCode::Char('u')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "包") =>
        {
            if let Some(action) = app.current_overlay_action() {
                activate_workbench_action(
                    app,
                    &format!("package-update:{action}"),
                    pipe,
                    session_path,
                    client_instance_id,
                    sequence,
                    session_flow,
                )?;
            }
        }
        KeyCode::Char('U')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "包") =>
        {
            activate_workbench_action(
                app,
                "package-update-all",
                pipe,
                session_path,
                client_instance_id,
                sequence,
                session_flow,
            )?;
        }
        KeyCode::Left => app.overlay_move_left(),
        KeyCode::Right => app.overlay_move_right(),
        KeyCode::Enter if modifiers.contains(KeyModifiers::SHIFT) => app.overlay_insert_newline(),
        KeyCode::Tab => {}
        KeyCode::Char('d') if modifiers == KeyModifiers::CONTROL => {
            set_tree_filter(app, TreeFilter::Default);
        }
        KeyCode::Char('t') if modifiers == KeyModifiers::CONTROL => {
            set_tree_filter(app, TreeFilter::NoTools);
        }
        KeyCode::Char('u') if modifiers == KeyModifiers::CONTROL => {
            set_tree_filter(app, TreeFilter::UserOnly);
        }
        KeyCode::Char('l') if modifiers == KeyModifiers::CONTROL => {
            set_tree_filter(app, TreeFilter::LabeledOnly);
        }
        KeyCode::Char('a') if modifiers == KeyModifiers::CONTROL => {
            set_tree_filter(app, TreeFilter::All);
        }

        KeyCode::Char('r')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && !app
                    .current_overlay_action()
                    .as_deref()
                    .is_some_and(|action| action.starts_with("session:")) =>
        {
            if let Some((id, request)) = app.restart_timed_out_b3_request() {
                pipe.request(&encode_b3_request(&id, request.command, request.payload)?)?;
                app.set_toast("正在重试请求");
            } else {
                app.overlay_insert("r");
            }
        }
        KeyCode::Char('c') if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => {
            if let Some(text) = app.overlay_copy_text() {
                let client_request_id = format!("clipboard:{}", sequence.saturating_add(1));
                app.mark_write_pending();
                request_b3(
                    app,
                    pipe,
                    sequence,
                    B3Command::WriteClipboardText,
                    serde_json::json!({
                        "text": text,
                        "clientInstanceId": client_instance_id,
                        "clientRequestId": client_request_id,
                    })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                    PendingIntent::ClipboardMutation {
                        toast: "设备码已复制".to_owned(),
                    },
                )?;
            } else {
                app.overlay_insert("c");
            }
        }
        KeyCode::Char('n')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "会话") =>
        {
            if app.is_active_operation() || session_flow.is_some() {
                app.set_overlay_error("当前会话正在运行，不能切换");
            } else {
                *sequence += 1;
                let id = format!("session-create-{sequence}");
                *session_flow = Some(SessionFlow::CreateStarting {
                    id: id.clone(),
                    restore: app.restore_point(),
                });
                pipe.request(&encode_create_session_request(
                    &id,
                    session_path,
                    client_instance_id,
                    &format!("create:{sequence}"),
                )?)?;
            }
        }
        KeyCode::Char('n')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "分支树") =>
        {
            app.select_tree_visible(1, true);
        }
        KeyCode::Char('p')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "分支树") =>
        {
            app.select_tree_visible(-1, true);
        }
        KeyCode::Char('v') if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => {
            if let Some(index) = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("session:"))
                .and_then(|value| value.parse::<usize>().ok())
                && let Some(session) = app.sessions.get(index)
            {
                let path = session.path.clone();
                let generation = app
                    .readonly_view
                    .as_ref()
                    .map_or(1, |readonly| readonly.generation.saturating_add(1));
                *sequence += 1;
                let id = format!("readonly-initial-{sequence}");
                *session_flow = Some(SessionFlow::Readonly {
                    id: id.clone(),
                    path: path.clone(),
                    replace: true,
                    generation,
                });
                app.readonly_view = Some(ReadonlySessionView {
                    path: path.clone(),
                    generation,
                    status: "正在读取".to_owned(),
                    ..ReadonlySessionView::default()
                });
                app.open_overlay(OverlayState::Detail(DetailOverlay {
                    title: "会话只读".to_owned(),
                    lines: vec!["正在读取".to_owned()],
                    scroll: 0,
                    status: "只读".to_owned(),
                    link: None,
                    copy_text: None,
                }));
                app.begin_transcript_request(
                    id.clone(),
                    TranscriptViewKind::Readonly,
                    TranscriptRequestKind::Initial,
                    path.clone(),
                    generation,
                    None,
                );
                pipe.request(&encode_read_transcript_request(
                    &id,
                    &path,
                    INITIAL_PAGE_LIMIT,
                    None,
                    None,
                )?)?;
            } else if let Some(index) = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("tree:"))
                .and_then(|value| value.parse::<usize>().ok())
            {
                let path = session_path.to_owned();
                let generation = app
                    .readonly_view
                    .as_ref()
                    .map_or(1, |readonly| readonly.generation.saturating_add(1));
                *sequence += 1;
                let id = format!("readonly-initial-{sequence}");
                *session_flow = Some(SessionFlow::Readonly {
                    id: id.clone(),
                    path: path.clone(),
                    replace: true,
                    generation,
                });
                app.readonly_view = Some(ReadonlySessionView {
                    path: path.clone(),
                    generation,
                    status: format!(
                        "定位 {}",
                        app.tree
                            .get(index)
                            .map(|node| node.id.as_str())
                            .unwrap_or_default()
                    ),
                    ..ReadonlySessionView::default()
                });
                app.open_overlay(OverlayState::Detail(DetailOverlay {
                    title: "会话只读".to_owned(),
                    lines: vec!["正在读取".to_owned()],
                    scroll: 0,
                    status: "只读".to_owned(),
                    link: None,
                    copy_text: None,
                }));
                app.begin_transcript_request(
                    id.clone(),
                    TranscriptViewKind::Readonly,
                    TranscriptRequestKind::Initial,
                    path.clone(),
                    generation,
                    None,
                );
                pipe.request(&encode_read_transcript_request(
                    &id,
                    &path,
                    INITIAL_PAGE_LIMIT,
                    None,
                    None,
                )?)?;
            } else {
                app.overlay_insert("v");
            }
        }
        KeyCode::Char('r')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && app
                    .current_overlay_action()
                    .as_deref()
                    .is_some_and(|action| action.starts_with("session:")) =>
        {
            let index = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("session:"))
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            if let Some(session) = app.sessions.get(index) {
                let value = session
                    .name
                    .clone()
                    .unwrap_or_else(|| session.first_message.clone());
                app.open_overlay(OverlayState::TextEditor(TextEditorOverlay {
                    title: "重命名会话".to_owned(),
                    cursor: value.len(),
                    value,
                    save_action: format!("session-rename:{index}"),
                    status: "Enter 保存，Esc 返回".to_owned(),
                    secret: false,
                }));
            }
        }
        KeyCode::Char('f') if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => {
            if app
                .current_overlay_action()
                .as_deref()
                .is_some_and(|action| action.starts_with("session:"))
            {
                app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                    title: "分叉会话".to_owned(),
                    message: "确认从当前选中记录创建并切换会话？".to_owned(),
                    confirm_action: "session-fork-current".to_owned(),
                    status: String::new(),
                }));
            } else if let Some(index) = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("tree:"))
                .and_then(|value| value.parse::<usize>().ok())
            {
                app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                    title: "分叉会话".to_owned(),
                    message: "确认从分支树选中记录创建并切换会话？".to_owned(),
                    confirm_action: format!("tree-fork:{index}"),
                    status: String::new(),
                }));
            } else {
                app.overlay_insert("f");
            }
        }
        KeyCode::Char('l')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && app
                    .current_overlay_action()
                    .as_deref()
                    .is_some_and(|action| action.starts_with("tree:")) =>
        {
            let index = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("tree:"))
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            if let Some(node) = app.tree.get(index) {
                let value = node.label.clone().unwrap_or_default();
                app.open_overlay(OverlayState::TextEditor(TextEditorOverlay {
                    title: "编辑标签".to_owned(),
                    cursor: value.len(),
                    value,
                    save_action: format!("tree-label:{index}"),
                    status: "留空可清除标签，Enter 保存".to_owned(),
                    secret: false,
                }));
            }
        }
        KeyCode::Char('s')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && app
                    .current_overlay_action()
                    .as_deref()
                    .is_some_and(|action| action.starts_with("tree:")) =>
        {
            let index = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("tree:"))
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                title: "摘要跳转".to_owned(),
                message: "跳转前生成分支摘要？".to_owned(),
                confirm_action: format!("tree-summary:{index}"),
                status: String::new(),
            }));
        }
        KeyCode::Char('d') if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => {
            if let Some(index) = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("session:"))
                .and_then(|value| value.parse::<usize>().ok())
                && app
                    .sessions
                    .get(index)
                    .is_some_and(|session| Some(session.path.as_str()) == app.active_session_path())
            {
                app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                    title: "删除会话".to_owned(),
                    message: "确认删除当前会话？".to_owned(),
                    confirm_action: "session-delete-current".to_owned(),
                    status: String::new(),
                }));
            } else if let Some(index) = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("login-provider:"))
                .and_then(|value| value.parse::<usize>().ok())
                && let Some(provider) = app.providers.get(index)
            {
                app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                    title: "退出登录".to_owned(),
                    message: format!("确认退出 {}？", provider.name),
                    confirm_action: format!("auth-logout:{index}"),
                    status: "d 仅在登录列表可用".to_owned(),
                }));
            } else {
                app.overlay_insert("d");
            }
        }
        KeyCode::Backspace => app.overlay_backspace(),
        KeyCode::Enter => {
            if let Some(action) = app.current_overlay_action() {
                activate_workbench_action(
                    app,
                    &action,
                    pipe,
                    session_path,
                    client_instance_id,
                    sequence,
                    session_flow,
                )?;
            }
        }
        KeyCode::Char(value)
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
        {
            app.overlay_insert(&value.to_string())
        }
        _ => {}
    }
    Ok(false)
}

#[cfg(unix)]
fn set_tree_filter(app: &mut AppState, tree_filter: TreeFilter) {
    let Some(OverlayState::List(list)) = app.overlay() else {
        return;
    };
    if list.title != "分支树" {
        return;
    }
    let filter = list.filter.clone();
    let selected_key = list
        .items
        .get(list.selected)
        .and_then(|item| item.action.strip_prefix("tree:"))
        .and_then(|index| index.parse::<usize>().ok())
        .and_then(|index| app.tree.get(index))
        .map(|node| node.id.clone());
    app.tree_filter = tree_filter;
    app.replace_overlay(tree_overlay(
        &app.tree,
        selected_key.as_deref(),
        filter,
        tree_filter,
    ));
}

#[cfg(unix)]
fn request_b3(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
    command: B3Command,
    payload: serde_json::Map<String, serde_json::Value>,
    intent: PendingIntent,
) -> Result<(), TuiError> {
    *sequence += 1;
    let id = format!("{}:{sequence}", command.wire());
    let request = B3Request { command, payload };
    app.begin_request(id.clone(), request.clone(), intent);
    pipe.request(&encode_b3_request(&id, request.command, request.payload)?)
}

#[cfg(unix)]
fn visible_cached_images(app: &AppState) -> Vec<CachedImage> {
    let mut visible = app
        .attachment_preview
        .as_deref()
        .and_then(|hash| app.attachment_by_hash(hash))
        .map(|attachment| CachedImage {
            content_ref: format!("attachment:{}", attachment.id),
            mime_type: attachment.mime_type.clone(),
            byte_length: attachment.byte_length,
            base64: attachment.base64.clone(),
        })
        .into_iter()
        .collect::<Vec<_>>();
    if !visible.is_empty() {
        return visible;
    }
    visible.extend(
        app.transcript
            .rounds()
            .iter()
            .skip(app.transcript.scroll)
            .take(8)
            .flat_map(|round| round.items.iter())
            .flat_map(transcript_images)
            .filter_map(|image| app.image_cache.get(&image.content_ref).cloned()),
    );
    visible
}

#[cfg(unix)]
fn request_visible_images(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    sequence: &mut u64,
) -> Result<bool, TuiError> {
    let pending = app
        .pending_image_requests
        .values()
        .map(|request| request.content_ref.clone())
        .collect::<Vec<_>>();
    let candidates = app
        .transcript
        .rounds()
        .iter()
        .skip(app.transcript.scroll)
        .take(8)
        .flat_map(|round| round.items.iter())
        .flat_map(transcript_images)
        .filter(|image| {
            !app.image_cache.get(&image.content_ref).is_some()
                && !pending.contains(&image.content_ref)
                && !app.failed_images.contains(&image.content_ref)
        })
        .collect::<Vec<_>>();
    let mut requested = false;
    for image in candidates {
        *sequence += 1;
        let id = format!("read-image-content-{sequence}");
        app.begin_image_request(id.clone(), image.content_ref.clone());
        pipe.request(&encode_b3_request(
            &id,
            B3Command::ReadImageContent,
            serde_json::json!({ "sessionPath": session_path, "contentRef": image.content_ref })
                .as_object()
                .cloned()
                .unwrap_or_default(),
        )?)?;
        requested = true;
    }
    Ok(requested)
}

#[cfg(unix)]
fn request_visible_rich_text(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    width: u16,
    sequence: &mut u64,
) -> Result<bool, TuiError> {
    let is_streaming = app.is_active_operation();
    let pending = app
        .pending_rich_text_requests
        .values()
        .map(|request| request.key.clone())
        .collect::<Vec<_>>();
    let candidates = app
        .transcript
        .rounds()
        .iter()
        .skip(app.transcript.scroll)
        .take(8)
        .filter(|round| !round.is_tool_round())
        .filter_map(|round| {
            let item = round.items.first()?;
            let streaming =
                matches!(&item.view, TranscriptViewItem::Assistant { .. }) && is_streaming;
            let (key, message_type, text) = AppState::rich_text_key(item, width, streaming)?;
            (!app.rich_text_cache.get(&key).is_some()
                && !pending.contains(&key)
                && !app.failed_rich_text.contains(&key))
            .then(|| (key, message_type.to_owned(), text.to_owned()))
        })
        .collect::<Vec<_>>();
    let mut requested = false;
    for (key, message_type, text) in candidates {
        *sequence += 1;
        let id = format!("render-rich-text-{sequence}");
        app.begin_rich_text_request(id.clone(), key);
        pipe.request(&encode_b3_request(
            &id,
            B3Command::RenderRichText,
            serde_json::json!({
                "text": text,
                "width": width,
                "messageType": message_type,
                "isStreaming": is_streaming,
                "sessionPath": session_path,
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
        )?)?;
        requested = true;
    }
    Ok(requested)
}

#[cfg(unix)]
fn request_subagents(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
    parent_session_path: String,
    selected_key: Option<String>,
    filter: String,
) -> Result<(), TuiError> {
    app.subagent_parent_path = Some(parent_session_path.clone());
    app.replace_workspace_overlay(
        format!("subagents:{parent_session_path}"),
        OverlayState::Detail(DetailOverlay {
            title: "Subagent".to_owned(),
            lines: vec!["正在读取 Subagent".to_owned()],
            scroll: 0,
            status: "请稍候".to_owned(),
            link: None,
            copy_text: None,
        }),
    );
    request_b3(
        app,
        pipe,
        sequence,
        B3Command::ListSubagents,
        serde_json::json!({ "sessionPath": parent_session_path })
            .as_object()
            .cloned()
            .unwrap_or_default(),
        PendingIntent::WorkbenchLoad {
            target: WorkbenchTarget::Subagents,
            selected_key,
            filter,
        },
    )
}

#[cfg(unix)]
fn request_clipboard_read(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
    insert: bool,
) -> Result<(), TuiError> {
    request_b3(
        app,
        pipe,
        sequence,
        B3Command::ReadClipboardText,
        serde_json::Map::new(),
        PendingIntent::ClipboardRead { insert },
    )
}

#[cfg(unix)]
fn request_clipboard_both(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
    target: ClipboardReadTarget,
) -> Result<(), TuiError> {
    let generation = app.begin_clipboard_read(target);
    request_b3(
        app,
        pipe,
        sequence,
        B3Command::ReadClipboardText,
        serde_json::Map::new(),
        PendingIntent::ClipboardBothText { generation },
    )?;
    request_b3(
        app,
        pipe,
        sequence,
        B3Command::ReadClipboardImage,
        serde_json::Map::new(),
        PendingIntent::ClipboardBothImage { generation },
    )
}

#[cfg(unix)]
fn request_attach_completion(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
) -> Result<(), TuiError> {
    let text = app.editor.text().to_owned();
    let Some(cwd) = app.active_session_cwd().filter(|cwd| !cwd.is_empty()) else {
        app.set_overlay_error("尚未获取项目目录");
        return Ok(());
    };
    request_b3(
        app,
        pipe,
        sequence,
        B3Command::GetCompletions,
        serde_json::json!({
            "cwd": cwd,
            "sessionPath": app.active_session_path(),
            "text": text,
            "cursor": app.editor.text().encode_utf16().count(),
        })
        .as_object()
        .cloned()
        .unwrap_or_default(),
        PendingIntent::AttachCompletion { text },
    )
}

#[cfg(unix)]
fn utf16_offset_to_byte(value: &str, offset: usize) -> Option<usize> {
    let mut units = 0;
    for (index, character) in value.char_indices() {
        if units == offset {
            return Some(index);
        }
        units = units.saturating_add(character.len_utf16());
        if units > offset {
            return None;
        }
    }
    (units == offset).then_some(value.len())
}

#[cfg(unix)]
fn finish_clipboard_both(app: &mut AppState) {
    let Some(state) = app.clipboard_read.clone() else {
        return;
    };
    if !state.text_done || !state.image_done {
        return;
    }
    let text = state.text.and_then(|clipboard| clipboard.text);
    let image = state.image;
    match state.target {
        ClipboardReadTarget::Overlay => {
            let clipboard = ClipboardDescriptor {
                capability: true,
                text: text.clone(),
            };
            app.clipboard = Some(clipboard.clone());
            app.replace_overlay(clipboard_overlay(&clipboard, image.as_ref()));
        }
        ClipboardReadTarget::Insert => match (text, image) {
            (None, None) => app.set_toast("剪贴板没有可插入内容"),
            (Some(text), None) => {
                app.editor.insert(&text);
                app.set_toast("已插入剪贴板文本");
            }
            (None, Some(image)) => match app.add_attachment(image) {
                Ok(true) => app.set_toast("已添加剪贴板图片"),
                Ok(false) => app.set_toast("图片已在附件中"),
                Err(message) => app.set_overlay_error(message),
            },
            (Some(_), Some(_)) => {
                app.open_overlay(OverlayState::List(ListOverlay {
                    title: "选择剪贴板内容".to_owned(),
                    origin: OverlayOrigin::User,
                    items: vec![
                        OverlayItem {
                            label: "插入文本".to_owned(),
                            detail: "在当前光标位置插入文本".to_owned(),
                            action: "clipboard-select:text".to_owned(),
                        },
                        OverlayItem {
                            label: "添加图片".to_owned(),
                            detail: "添加为图片附件".to_owned(),
                            action: "clipboard-select:image".to_owned(),
                        },
                        OverlayItem {
                            label: "两者".to_owned(),
                            detail: "插入文本并添加图片".to_owned(),
                            action: "clipboard-select:both".to_owned(),
                        },
                    ],
                    selected: 0,
                    filter: String::new(),
                    status: "Enter 选择，Esc 取消".to_owned(),
                }));
            }
        },
    }
}

#[cfg(unix)]
fn attach_overlay(app: &AppState) -> OverlayState {
    OverlayState::List(ListOverlay {
        title: "图片附件".to_owned(),
        origin: OverlayOrigin::User,
        items: app
            .attachments
            .iter()
            .enumerate()
            .map(|(index, attachment)| OverlayItem {
                label: attachment.name.clone(),
                detail: format!(
                    "{}  {}  {} B  #{}",
                    attachment.source,
                    attachment.mime_type,
                    attachment.byte_length,
                    &attachment.content_hash[..attachment.content_hash.len().min(12)]
                ),
                action: format!("attachment:{index}"),
            })
            .collect(),
        selected: 0,
        filter: String::new(),
        status: "Enter 预览  d 删除  D 清空  Esc 返回".to_owned(),
    })
}

#[cfg(unix)]
fn request_clipboard_write(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    client_instance_id: &str,
    sequence: &mut u64,
    text: String,
    toast: &str,
) -> Result<(), TuiError> {
    if text.is_empty() {
        app.set_overlay_error("没有可写入剪贴板的文本");
        return Ok(());
    }
    let client_request_id = format!("clipboard:{}", sequence.saturating_add(1));
    app.mark_write_pending();
    request_b3(
        app,
        pipe,
        sequence,
        B3Command::WriteClipboardText,
        serde_json::json!({
            "text": text,
            "clientInstanceId": client_instance_id,
            "clientRequestId": client_request_id,
        })
        .as_object()
        .cloned()
        .unwrap_or_default(),
        PendingIntent::ClipboardMutation {
            toast: toast.to_owned(),
        },
    )
}

#[cfg(unix)]
fn list_context(app: &AppState, title: &str) -> (String, Option<String>) {
    app.overlays
        .iter()
        .rev()
        .find_map(|overlay| match overlay {
            OverlayState::List(list) if list.title == title => (
                list.filter.clone(),
                list.items
                    .get(list.selected)
                    .map(|item| item.action.clone()),
            )
                .into(),
            _ => None,
        })
        .unwrap_or_default()
}

#[cfg(unix)]
fn request_workspace_load(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
    target: WorkbenchTarget,
    selected_key: Option<String>,
    filter: String,
) -> Result<(), TuiError> {
    let cwd = app
        .active_session_cwd()
        .filter(|cwd| !cwd.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| TuiError::InvalidResponse("尚未获取项目目录".to_owned()))?;
    let (command, payload, title, key) = match target {
        WorkbenchTarget::Changes => (
            B3Command::GetGitStatus,
            serde_json::json!({ "cwd": cwd })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            "变更",
            "changes",
        ),
        WorkbenchTarget::Skills => (
            B3Command::ListSkills,
            serde_json::json!({ "cwd": cwd })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            "技能",
            "skills",
        ),
        WorkbenchTarget::Trust => (
            B3Command::GetProjectTrust,
            serde_json::json!({ "cwd": cwd })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            "项目信任",
            "trust",
        ),
        WorkbenchTarget::InstructionsProject => (
            B3Command::ListProjectInstructions,
            serde_json::json!({ "cwd": cwd })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            "指令 [项目]",
            "instructions:project",
        ),
        WorkbenchTarget::InstructionsHost => (
            B3Command::ListHostInstructions,
            serde_json::Map::new(),
            "指令 [本机]",
            "instructions:host",
        ),
        WorkbenchTarget::Packages => (
            B3Command::ListPackages,
            serde_json::json!({ "cwd": cwd })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            "包",
            "packages",
        ),
        WorkbenchTarget::Update => (
            B3Command::CheckForUpdates,
            serde_json::Map::new(),
            "更新检查",
            "update",
        ),
        _ => return Ok(()),
    };
    app.replace_workspace_overlay(
        key,
        OverlayState::Detail(DetailOverlay {
            title: title.to_owned(),
            lines: vec!["正在读取".to_owned()],
            scroll: 0,
            status: "请稍候".to_owned(),
            link: None,
            copy_text: None,
        }),
    );
    request_b3(
        app,
        pipe,
        sequence,
        command,
        payload,
        PendingIntent::WorkbenchLoad {
            target,
            selected_key,
            filter,
        },
    )
}

fn request_settings(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    sequence: &mut u64,
    selected_key: Option<String>,
    filter: String,
) -> Result<(), TuiError> {
    request_b3(
        app,
        pipe,
        sequence,
        B3Command::ListSettings,
        serde_json::json!({ "sessionPath": session_path })
            .as_object()
            .cloned()
            .unwrap_or_default(),
        PendingIntent::WorkbenchLoad {
            target: WorkbenchTarget::Settings,
            selected_key,
            filter,
        },
    )
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn request_setting_write(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    id: &str,
    value: serde_json::Value,
    filter: String,
) -> Result<(), TuiError> {
    let Some(lease_id) = app.lease_id.clone() else {
        app.set_overlay_error("尚未获取会话租约");
        return Ok(());
    };
    let client_request_id = format!("setting:{id}:{}", sequence.saturating_add(1));
    app.mark_write_pending();
    request_b3(
        app,
        pipe,
        sequence,
        B3Command::SetSetting,
        serde_json::json!({
            "sessionPath": session_path,
            "leaseId": lease_id,
            "clientInstanceId": client_instance_id,
            "clientRequestId": client_request_id,
            "id": id,
            "value": value,
        })
        .as_object()
        .cloned()
        .unwrap_or_default(),
        PendingIntent::SettingMutation {
            selected_key: id.to_owned(),
            filter,
        },
    )
}

#[cfg(unix)]
fn open_workbench(
    app: &mut AppState,
    target: &str,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    _client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
) -> Result<(), TuiError> {
    if target == "sessions" {
        *sequence += 1;
        let id = format!("sessions-list-{sequence}");
        *session_flow = Some(SessionFlow::List {
            id: id.clone(),
            selected_path: app.active_session_path().map(str::to_owned),
        });
        app.open_overlay(OverlayState::Detail(DetailOverlay {
            title: "会话".to_owned(),
            lines: vec!["正在读取会话".to_owned()],
            scroll: 0,
            status: "请稍候".to_owned(),
            link: None,
            copy_text: None,
        }));
        return pipe.request(&encode_list_sessions_request(&id, session_path, None)?);
    }
    if target == "subagents" {
        return request_subagents(
            app,
            pipe,
            sequence,
            session_path.to_owned(),
            None,
            String::new(),
        );
    }
    if target == "clipboard" {
        app.open_workspace_overlay(
            "clipboard",
            OverlayState::Detail(DetailOverlay {
                title: "剪贴板".to_owned(),
                lines: vec!["正在读取剪贴板".to_owned()],
                scroll: 0,
                status: "请稍候".to_owned(),
                link: None,
                copy_text: None,
            }),
        );
        return request_clipboard_both(app, pipe, sequence, ClipboardReadTarget::Overlay);
    }
    if target == "tree" {
        return request_b3(
            app,
            pipe,
            sequence,
            B3Command::GetSessionTree,
            serde_json::json!({ "sessionPath": session_path })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            PendingIntent::WorkbenchLoad {
                target: WorkbenchTarget::Tree,
                selected_key: None,
                filter: String::new(),
            },
        );
    }
    if target == "help" {
        app.open_overlay(OverlayState::Detail(DetailOverlay {
            title: "帮助".to_owned(),
            lines: vec![
                "Ctrl+P 打开命令面板".to_owned(),
                "/subagents Subagent，/clipboard 剪贴板，/sessions 会话，/tree 分支树，/settings 设置，/model 模型，/thinking 思考，/login 登录".to_owned(),
                "Ctrl+Shift+V 读取并插入剪贴板，Ctrl+Y 复制当前上下文".to_owned(),
                "/help 显示此帮助，/about 显示版本与运行目录，/doctor 显示诊断结果".to_owned(),
                "Esc 返回；方向键、PageUp/PageDown、Home/End 可浏览详情".to_owned(),
            ],
            scroll: 0,
            status: "Esc 返回".to_owned(),
            link: None,
            copy_text: None,
        }));
        return Ok(());
    }
    if matches!(
        target,
        "changes" | "skills" | "trust" | "instructions" | "packages" | "update"
    ) {
        let cwd = app
            .active_session_cwd()
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| TuiError::InvalidResponse("尚未获取项目目录".to_owned()))?;
        let (command, payload, workbench_target, title, key) = match target {
            "changes" => (
                B3Command::GetGitStatus,
                serde_json::json!({ "cwd": cwd })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                WorkbenchTarget::Changes,
                "变更",
                "changes",
            ),
            "skills" => (
                B3Command::ListSkills,
                serde_json::json!({ "cwd": cwd })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                WorkbenchTarget::Skills,
                "技能",
                "skills",
            ),
            "trust" => (
                B3Command::GetProjectTrust,
                serde_json::json!({ "cwd": cwd })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                WorkbenchTarget::Trust,
                "项目信任",
                "trust",
            ),
            "instructions" => (
                B3Command::ListProjectInstructions,
                serde_json::json!({ "cwd": cwd })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                WorkbenchTarget::InstructionsProject,
                "指令 [项目]",
                "instructions:project",
            ),
            "packages" => (
                B3Command::ListPackages,
                serde_json::json!({ "cwd": cwd })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                WorkbenchTarget::Packages,
                "包",
                "packages",
            ),
            "update" => (
                B3Command::CheckForUpdates,
                serde_json::Map::new(),
                WorkbenchTarget::Update,
                "更新检查",
                "update",
            ),
            _ => unreachable!(),
        };
        app.open_workspace_overlay(
            key,
            OverlayState::Detail(DetailOverlay {
                title: title.to_owned(),
                lines: vec!["正在读取".to_owned()],
                scroll: 0,
                status: "请稍候".to_owned(),
                link: None,
                copy_text: None,
            }),
        );
        return request_b3(
            app,
            pipe,
            sequence,
            command,
            payload,
            PendingIntent::WorkbenchLoad {
                target: workbench_target,
                selected_key: None,
                filter: String::new(),
            },
        );
    }
    let (command, payload, intent, title) = match target {
        "settings" => (
            B3Command::ListSettings,
            serde_json::json!({ "sessionPath": session_path })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            PendingIntent::WorkbenchLoad {
                target: WorkbenchTarget::Settings,
                selected_key: None,
                filter: String::new(),
            },
            "设置",
        ),
        "model" => (
            B3Command::ListModels,
            serde_json::Map::new(),
            PendingIntent::WorkbenchLoad {
                target: WorkbenchTarget::Model,
                selected_key: None,
                filter: String::new(),
            },
            "模型",
        ),
        "thinking" => (
            B3Command::ListModels,
            serde_json::Map::new(),
            PendingIntent::WorkbenchLoad {
                target: WorkbenchTarget::Thinking,
                selected_key: None,
                filter: String::new(),
            },
            "思考",
        ),
        "login" => (
            B3Command::ListModelProviders,
            serde_json::Map::new(),
            PendingIntent::WorkbenchLoad {
                target: WorkbenchTarget::Login,
                selected_key: None,
                filter: String::new(),
            },
            "登录",
        ),
        "about" => (B3Command::GetAbout, serde_json::Map::new(), PendingIntent::Overlay { target: "关于".to_owned() }, "关于"),
        "doctor" => (
            B3Command::GetDiagnostics,
            serde_json::json!({ "cwd": app.snapshot.as_ref().map(|snapshot| snapshot.cwd.clone()) })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            PendingIntent::Overlay { target: "诊断".to_owned() },
            "诊断",
        ),
        _ => return Ok(()),
    };
    app.open_overlay(OverlayState::Detail(DetailOverlay {
        title: title.to_owned(),
        lines: vec!["正在读取".to_owned()],
        scroll: 0,
        status: "请稍候".to_owned(),
        link: None,
        copy_text: None,
    }));
    request_b3(app, pipe, sequence, command, payload, intent)
}

#[cfg(unix)]
fn activate_workbench_action(
    app: &mut AppState,
    action: &str,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
) -> Result<(), TuiError> {
    if action == "recovery-append" {
        if app.append_recovery_draft() {
            app.close_overlay();
            app.set_toast("已追加恢复草稿");
        }
        return Ok(());
    }
    if action == "recovery-replace-confirm" {
        if app.recovery_draft.is_some() {
            app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                title: "替换恢复草稿".to_owned(),
                message: "确认替换当前输入内容？".to_owned(),
                confirm_action: "recovery-replace".to_owned(),
                status: String::new(),
            }));
        }
        return Ok(());
    }
    if action == "recovery-replace" {
        if app.replace_with_recovery_draft() {
            app.close_overlay();
            app.close_overlay();
            app.set_toast("已替换输入草稿");
        }
        return Ok(());
    }
    if action == "recovery-copy" {
        if let Some(text) = app.recovery_draft_text().map(str::to_owned) {
            request_clipboard_write(
                app,
                pipe,
                client_instance_id,
                sequence,
                text,
                "已复制恢复草稿",
            )?;
        }
        return Ok(());
    }
    if action == "recovery-discard" {
        if app.discard_recovery_draft() {
            app.close_overlay();
            app.set_toast("已丢弃恢复草稿");
        }
        return Ok(());
    }
    if let Some(index) = action
        .strip_prefix("attachment-completion:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(completion) = app.composer_completion.clone() else {
            app.set_overlay_error("补全结果已失效，请重试");
            return Ok(());
        };
        let Some(item) = completion.items.get(index) else {
            app.set_overlay_error("补全项已失效，请重试");
            return Ok(());
        };
        let next = format!(
            "{}{}{}",
            &completion.text[..completion.prefix_start],
            item.value,
            &completion.text[completion.prefix_end..]
        );
        app.editor.replace(&next);
        app.composer_completion = None;
        app.close_overlay();
        if item.kind == "directory" {
            request_attach_completion(app, pipe, sequence)?;
            return Ok(());
        }
        let path = item.value.trim_end_matches('/').to_owned();
        app.editor.clear();
        let cwd = app.active_session_cwd().unwrap_or_default().to_owned();
        return request_b3(
            app,
            pipe,
            sequence,
            B3Command::ReadProjectImage,
            serde_json::json!({ "cwd": cwd, "path": path })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            PendingIntent::ProjectImage {
                source: item.value.clone(),
            },
        );
    }
    if let Some(index) = action
        .strip_prefix("attachment:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(attachment) = app.attachments.get(index) else {
            app.set_overlay_error("附件列表已刷新，请重新选择");
            return Ok(());
        };
        app.attachment_preview = Some(attachment.content_hash.clone());
        app.open_overlay(OverlayState::Detail(DetailOverlay {
            title: "图片预览".to_owned(),
            lines: vec![
                format!("名称: {}", attachment.name),
                format!("来源: {}", attachment.source),
                format!("MIME: {}", attachment.mime_type),
                format!("大小: {} B", attachment.byte_length),
                format!("哈希: {}", attachment.content_hash),
                format!("[图片 {} {}]", attachment.mime_type, attachment.byte_length),
            ],
            scroll: 0,
            status: "Esc 返回".to_owned(),
            link: None,
            copy_text: None,
        }));
        return Ok(());
    }
    if let Some(index) = action
        .strip_prefix("attachment-remove:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        if app.remove_attachment(index) {
            app.close_overlay();
            app.replace_overlay(attach_overlay(app));
            app.set_toast("已删除图片附件");
        } else {
            app.set_overlay_error("附件列表已刷新，请重新选择");
        }
        return Ok(());
    }
    if action == "attachment-clear" {
        app.clear_attachments();
        app.close_overlay();
        app.close_overlay();
        app.set_toast("已清空图片附件");
        return Ok(());
    }
    if let Some(target) = action.strip_prefix("clipboard-select:") {
        let Some(state) = app.clipboard_read.clone() else {
            app.set_overlay_error("剪贴板读取结果已失效");
            return Ok(());
        };
        let text = state.text.and_then(|item| item.text);
        let image = state.image;
        if matches!(target, "text" | "both")
            && let Some(text) = text
        {
            app.editor.insert(&text);
        }
        if matches!(target, "image" | "both")
            && let Some(image) = image
        {
            match app.add_attachment(image) {
                Ok(true) => {}
                Ok(false) => app.set_toast("图片已在附件中"),
                Err(message) => app.set_overlay_error(message),
            }
        }
        app.close_overlay();
        app.set_toast(match target {
            "text" => "已插入剪贴板文本",
            "image" => "已添加剪贴板图片",
            _ => "已插入文本并添加图片",
        });
        return Ok(());
    }
    if let Some(target) = action.strip_prefix("open:") {
        return open_workbench(
            app,
            target,
            pipe,
            session_path,
            client_instance_id,
            sequence,
            session_flow,
        );
    }
    if let Some(index) = action
        .strip_prefix("subagent:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(snapshot) = app.subagents.get(index).cloned() else {
            app.set_overlay_error("Subagent 列表已刷新，请重新选择");
            return Ok(());
        };
        let filter = list_context(app, "Subagent").0;
        return request_b3(
            app,
            pipe,
            sequence,
            B3Command::ReadSubagent,
            serde_json::json!({
                "sessionPath": snapshot.parent_session_path,
                "agentId": snapshot.agent_id,
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::SubagentRead {
                parent_session_path: snapshot.parent_session_path,
                selected_key: format!("subagent:{index}"),
                filter,
            },
        );
    }
    if let Some(index) = action
        .strip_prefix("subagent-abort:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(snapshot) = app.subagents.get(index).cloned() else {
            app.set_overlay_error("Subagent 列表已刷新，请重新选择");
            return Ok(());
        };
        if !snapshot.controllable || !subagent_running(&snapshot.state) {
            app.set_overlay_error("当前 Subagent 不能停止");
            return Ok(());
        }
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(());
        };
        if app.active_session_path() != Some(snapshot.parent_session_path.as_str()) {
            app.set_overlay_error("只允许控制当前会话的 Subagent");
            return Ok(());
        }
        let filter = list_context(app, "Subagent").0;
        app.close_overlay();
        app.mark_write_pending();
        return request_b3(
            app,
            pipe,
            sequence,
            B3Command::AbortSubagent,
            serde_json::json!({
                "sessionPath": snapshot.parent_session_path,
                "leaseId": lease_id,
                "agentId": snapshot.agent_id,
                "clientInstanceId": client_instance_id,
                "clientRequestId": format!("subagent-abort:{}:{}", snapshot.agent_id, sequence.saturating_add(1)),
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::SubagentMutation {
                parent_session_path: snapshot.parent_session_path,
                selected_key: format!("subagent:{index}"),
                filter,
                toast: "已请求停止 Subagent".to_owned(),
            },
        );
    }
    if let Some(index) = action
        .strip_prefix("subagent-continue:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let text = match app.overlay() {
            Some(OverlayState::TextEditor(editor)) => editor.value.trim().to_owned(),
            _ => String::new(),
        };
        let Some(snapshot) = app.subagents.get(index).cloned() else {
            app.set_overlay_error("Subagent 列表已刷新，请重新选择");
            return Ok(());
        };
        if subagent_running(&snapshot.state) || snapshot.session_file.is_none() {
            app.set_overlay_error("运行中的 Subagent 不能继续");
            return Ok(());
        }
        if text.is_empty() {
            app.set_overlay_error("继续内容不能为空");
            return Ok(());
        }
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(());
        };
        if app.active_session_path() != Some(snapshot.parent_session_path.as_str()) {
            app.set_overlay_error("只允许控制当前会话的 Subagent");
            return Ok(());
        }
        let filter = list_context(app, "Subagent").0;
        app.close_overlay();
        app.mark_write_pending();
        return request_b3(
            app,
            pipe,
            sequence,
            B3Command::ContinueSubagent,
            serde_json::json!({
                "sessionPath": snapshot.parent_session_path,
                "leaseId": lease_id,
                "agentId": snapshot.agent_id,
                "text": text,
                "clientInstanceId": client_instance_id,
                "clientRequestId": format!("subagent-continue:{}:{}", snapshot.agent_id, sequence.saturating_add(1)),
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::SubagentMutation {
                parent_session_path: snapshot.parent_session_path,
                selected_key: format!("subagent:{index}"),
                filter,
                toast: "已继续 Subagent".to_owned(),
            },
        );
    }
    if app.write_pending && !action.starts_with("ui:") {
        app.set_overlay_error("正在写入，请稍候");
        return Ok(());
    }
    if action == "tree-replace-editor" {
        if let Some(text) = app.pending_editor_replace.take() {
            app.editor.replace(&text);
            app.clear_overlay_transient();
            app.set_toast("已替换输入草稿");
        }
        return Ok(());
    }
    if action.starts_with("disabled:") {
        app.set_overlay_error(action.trim_start_matches("disabled:"));
        return Ok(());
    }
    if let Some(index) = action
        .strip_prefix("change:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(file) = app
            .git_status
            .as_ref()
            .and_then(|status| status.files.get(index))
            .cloned()
        else {
            app.set_overlay_error("变更列表已刷新，请重新选择");
            return Ok(());
        };
        let cwd = app
            .active_session_cwd()
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| TuiError::InvalidResponse("尚未获取项目目录".to_owned()))?;
        app.open_workspace_overlay(
            "changes:detail",
            OverlayState::Detail(DetailOverlay {
                title: "变更详情".to_owned(),
                lines: vec!["正在读取 Diff".to_owned()],
                scroll: 0,
                status: "请稍候".to_owned(),
                link: None,
                copy_text: None,
            }),
        );
        return request_b3(
            app,
            pipe,
            sequence,
            B3Command::GetGitDiff,
            serde_json::json!({ "cwd": cwd, "path": file.path, "staged": file.staged })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            PendingIntent::ChangeDetail,
        );
    }
    if let Some(index) = action
        .strip_prefix("skill:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(skill) = app.skills.get(index) else {
            app.set_overlay_error("技能列表已刷新，请重新选择");
            return Ok(());
        };
        if !skill.eligible {
            app.set_overlay_error("此 Skill 不支持修改启用状态");
            return Ok(());
        }
        app.open_overlay(OverlayState::List(ListOverlay {
            title: format!("{} 作用域", skill.name),
            origin: OverlayOrigin::User,
            items: ["user", "project"]
                .into_iter()
                .map(|scope| OverlayItem {
                    label: if scope == "user" { "用户" } else { "项目" }.to_owned(),
                    detail: if skill.scope == scope {
                        "当前来源"
                    } else {
                        "写入 override"
                    }
                    .to_owned(),
                    action: format!("skill-toggle:{index}:{scope}"),
                })
                .collect(),
            selected: if skill.scope == "project" { 1 } else { 0 },
            filter: String::new(),
            status: "Enter 切换启用状态，Esc 返回".to_owned(),
        }));
        return Ok(());
    }
    if let Some(value) = action.strip_prefix("skill-toggle:") {
        let Some((index, scope)) = value.rsplit_once(':') else {
            app.set_overlay_error("技能作用域无效");
            return Ok(());
        };
        let Ok(index) = index.parse::<usize>() else {
            app.set_overlay_error("技能作用域无效");
            return Ok(());
        };
        let Some(skill) = app.skills.get(index).cloned() else {
            app.set_overlay_error("技能列表已刷新，请重新选择");
            return Ok(());
        };
        let scope = scope.to_owned();
        if !matches!(scope.as_str(), "user" | "project") {
            app.set_overlay_error("技能作用域无效");
            return Ok(());
        }
        app.close_overlay();
        let filter = list_context(app, "技能").0;
        let cwd = app
            .active_session_cwd()
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| TuiError::InvalidResponse("尚未获取项目目录".to_owned()))?;
        app.mark_write_pending();
        return request_b3(
            app,
            pipe,
            sequence,
            B3Command::SetSkillEnabled,
            serde_json::json!({
                "cwd": cwd,
                "path": skill.path,
                "scope": scope,
                "enabled": !skill.enabled,
                "clientInstanceId": client_instance_id,
                "clientRequestId": format!("skill:{}:{}:{}", index, scope, sequence.saturating_add(1)),
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::SkillMutation {
                selected_key: format!("skill:{index}"),
                filter,
            },
        );
    }
    if action == "trust:toggle" {
        let target = !app
            .trust
            .as_ref()
            .and_then(|trust| trust.trusted)
            .unwrap_or(false);
        let mut message = if target {
            "确认信任此项目？项目级资源将可加载。".to_owned()
        } else {
            "确认取消信任此项目？项目级资源将停止加载。".to_owned()
        };
        if !target
            && (app.is_active_operation()
                || app.trust.as_ref().is_some_and(|trust| trust.resource_risk))
        {
            message.push_str(" 当前有运行任务或项目资源，取消信任会影响后续资源加载。");
        }
        app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
            title: "项目信任".to_owned(),
            message,
            confirm_action: format!("trust-set:{target}"),
            status: String::new(),
        }));
        return Ok(());
    }
    if let Some(target) = action.strip_prefix("trust-set:") {
        let trusted = match target {
            "true" => true,
            "false" => false,
            _ => {
                app.set_overlay_error("信任状态无效");
                return Ok(());
            }
        };
        app.close_overlay();
        let cwd = app
            .active_session_cwd()
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| TuiError::InvalidResponse("尚未获取项目目录".to_owned()))?;
        app.mark_write_pending();
        return request_b3(
            app,
            pipe,
            sequence,
            B3Command::SetProjectTrust,
            serde_json::json!({
                "cwd": cwd,
                "trusted": trusted,
                "clientInstanceId": client_instance_id,
                "clientRequestId": format!("trust:{trusted}:{}", sequence.saturating_add(1)),
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::TrustMutation,
        );
    }
    if let Some(scope) = action.strip_prefix("instruction-conflict-reload:") {
        let target = match scope {
            "project" => WorkbenchTarget::InstructionsProject,
            "host" => WorkbenchTarget::InstructionsHost,
            _ => {
                app.set_overlay_error("指令冲突作用域无效");
                return Ok(());
            }
        };
        app.close_overlay();
        return request_workspace_load(app, pipe, sequence, target, None, String::new());
    }
    if action == "instruction-conflict-discard" {
        app.close_overlay();
        app.set_toast("已放弃保存，未覆盖外部修改");
        return Ok(());
    }
    if let Some(value) = action.strip_prefix("instruction:") {
        let mut values = value.split(':');
        let (Some(scope), Some(index)) = (values.next(), values.next()) else {
            app.set_overlay_error("指令选择无效");
            return Ok(());
        };
        let Ok(index) = index.parse::<usize>() else {
            app.set_overlay_error("指令选择无效");
            return Ok(());
        };
        let instructions = if scope == "project" {
            &app.project_instructions
        } else {
            &app.host_instructions
        };
        let Some(instruction) = instructions.get(index) else {
            app.set_overlay_error("指令列表已刷新，请重新选择");
            return Ok(());
        };
        app.open_overlay(OverlayState::TextEditor(TextEditorOverlay {
            title: format!("编辑 {}", instruction.file_name),
            value: instruction.content.clone().unwrap_or_default(),
            cursor: instruction.content.as_ref().map_or(0, String::len),
            save_action: format!("instruction-save:{scope}:{index}"),
            status: "Enter 保存，Shift+Enter 换行，Esc 取消".to_owned(),
            secret: false,
        }));
        return Ok(());
    }
    if let Some(value) = action.strip_prefix("instruction-save:") {
        let mut values = value.split(':');
        let (Some(scope), Some(index)) = (values.next(), values.next()) else {
            app.set_overlay_error("指令保存无效");
            return Ok(());
        };
        let Ok(index) = index.parse::<usize>() else {
            app.set_overlay_error("指令保存无效");
            return Ok(());
        };
        let content = match app.overlay() {
            Some(OverlayState::TextEditor(editor)) => editor.value.clone(),
            _ => String::new(),
        };
        let instructions = if scope == "project" {
            &app.project_instructions
        } else {
            &app.host_instructions
        };
        let Some(instruction) = instructions.get(index).cloned() else {
            app.set_overlay_error("指令列表已刷新，请重新选择");
            return Ok(());
        };
        app.close_overlay();
        let target = if scope == "project" {
            WorkbenchTarget::InstructionsProject
        } else {
            WorkbenchTarget::InstructionsHost
        };
        let filter = list_context(
            app,
            if scope == "project" {
                "指令 [项目]"
            } else {
                "指令 [本机]"
            },
        )
        .0;
        let cwd = app.active_session_cwd().unwrap_or_default();
        let command = if scope == "project" {
            B3Command::SaveProjectInstruction
        } else {
            B3Command::SaveHostInstruction
        };
        let mut payload = serde_json::json!({
            "fileName": instruction.file_name,
            "content": content,
            "clientInstanceId": client_instance_id,
            "clientRequestId": format!("instruction:{scope}:{}", sequence.saturating_add(1)),
        })
        .as_object()
        .cloned()
        .unwrap_or_default();
        if scope == "project" {
            payload.insert("cwd".to_owned(), serde_json::Value::String(cwd.to_owned()));
        }
        if let Some(hash) = instruction.content_hash {
            payload.insert("expectedHash".to_owned(), serde_json::Value::String(hash));
        }
        app.mark_write_pending();
        return request_b3(
            app,
            pipe,
            sequence,
            command,
            payload,
            PendingIntent::InstructionMutation {
                target,
                selected_key: format!("instruction:{scope}:{index}"),
                filter,
            },
        );
    }
    if action == "package-install-source" {
        let source = match app.overlay() {
            Some(OverlayState::TextEditor(editor)) => editor.value.trim().to_owned(),
            _ => String::new(),
        };
        if source.is_empty() {
            app.set_overlay_error("请输入包来源");
            return Ok(());
        }
        app.pending_package_source = Some(source);
        app.close_overlay();
        app.open_overlay(OverlayState::List(ListOverlay {
            title: "安装包作用域".to_owned(),
            origin: OverlayOrigin::User,
            items: vec![
                OverlayItem {
                    label: "用户".to_owned(),
                    detail: "写入用户配置".to_owned(),
                    action: "package-install:user".to_owned(),
                },
                OverlayItem {
                    label: "项目".to_owned(),
                    detail: "写入项目配置".to_owned(),
                    action: "package-install:project".to_owned(),
                },
            ],
            selected: 0,
            filter: String::new(),
            status: "Enter 安装，Esc 返回".to_owned(),
        }));
        return Ok(());
    }
    if let Some(scope) = action.strip_prefix("package-install:") {
        let Some(source) = app.pending_package_source.take() else {
            app.set_overlay_error("包来源已丢失，请重新输入");
            return Ok(());
        };
        if !matches!(scope, "user" | "project") {
            app.set_overlay_error("包作用域无效");
            return Ok(());
        }
        app.close_overlay();
        let filter = list_context(app, "包").0;
        let cwd = app
            .active_session_cwd()
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| TuiError::InvalidResponse("尚未获取项目目录".to_owned()))?;
        app.mark_write_pending();
        return request_b3(
            app,
            pipe,
            sequence,
            B3Command::InstallPackage,
            serde_json::json!({
                "cwd": cwd, "source": source, "scope": scope,
                "clientInstanceId": client_instance_id,
                "clientRequestId": format!("package-install:{}:{}", scope, sequence.saturating_add(1)),
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::PackageMutation { selected_key: None, filter, toast: "包已安装".to_owned() },
        );
    }
    if let Some(index) = action
        .strip_prefix("package-remove:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(package) = app.packages.get(index).cloned() else {
            app.set_overlay_error("包列表已刷新，请重新选择");
            return Ok(());
        };
        app.close_overlay();
        let filter = list_context(app, "包").0;
        let cwd = app
            .active_session_cwd()
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| TuiError::InvalidResponse("尚未获取项目目录".to_owned()))?;
        app.mark_write_pending();
        return request_b3(
            app,
            pipe,
            sequence,
            B3Command::RemovePackage,
            serde_json::json!({
                "cwd": cwd, "source": package.source, "scope": package.scope,
                "clientInstanceId": client_instance_id,
                "clientRequestId": format!("package-remove:{}", sequence.saturating_add(1)),
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::PackageMutation {
                selected_key: None,
                filter,
                toast: "包已移除".to_owned(),
            },
        );
    }
    if action == "package-update-all" || action.starts_with("package-update:package:") {
        let source = action
            .strip_prefix("package-update:package:")
            .and_then(|value| value.parse::<usize>().ok())
            .and_then(|index| app.packages.get(index))
            .map(|package| package.source.clone());
        let filter = list_context(app, "包").0;
        let cwd = app
            .active_session_cwd()
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| TuiError::InvalidResponse("尚未获取项目目录".to_owned()))?;
        let mut payload = serde_json::json!({
            "cwd": cwd,
            "clientInstanceId": client_instance_id,
            "clientRequestId": format!("package-update:{}", sequence.saturating_add(1)),
        })
        .as_object()
        .cloned()
        .unwrap_or_default();
        if let Some(source) = source {
            payload.insert("source".to_owned(), serde_json::Value::String(source));
        }
        app.mark_write_pending();
        return request_b3(
            app,
            pipe,
            sequence,
            B3Command::UpdatePackages,
            payload,
            PendingIntent::PackageMutation {
                selected_key: None,
                filter,
                toast: "包已更新".to_owned(),
            },
        );
    }
    if let Some(index) = action
        .strip_prefix("session:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(target) = app.sessions.get(index).cloned() else {
            app.set_overlay_error("会话列表已刷新，请重新选择");
            return Ok(());
        };
        if target.path == session_path {
            app.close_overlay();
            return Ok(());
        }
        if app.is_active_operation() || session_flow.is_some() {
            app.set_overlay_error("当前会话正在运行，不能切换");
            return Ok(());
        }
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(());
        };
        let restore = app.restore_point();
        *sequence += 1;
        let id = format!("session-release-{sequence}");
        *session_flow = Some(SessionFlow::SwitchReleasing {
            id: id.clone(),
            target,
            restore,
        });
        return pipe.request(&encode_release_session_request(
            &id,
            session_path,
            &lease_id,
        )?);
    }
    if let Some(index) = action
        .strip_prefix("session-rename:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(session) = app.sessions.get(index) else {
            app.set_overlay_error("会话列表已刷新，请重新选择");
            return Ok(());
        };
        let name = match app.overlay() {
            Some(OverlayState::TextEditor(editor)) => editor.value.clone(),
            _ => String::new(),
        };
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(());
        };
        if session.path != session_path {
            app.set_overlay_error("只能重命名当前会话");
            return Ok(());
        }
        *sequence += 1;
        let id = format!("session-rename-{sequence}");
        *session_flow = Some(SessionFlow::Rename {
            id: id.clone(),
            index,
            name: name.clone(),
        });
        app.close_overlay();
        return pipe.request(&encode_session_write_request(
            &id,
            "rename_session",
            serde_json::json!({
                "sessionPath": session_path, "leaseId": lease_id, "name": name,
                "clientInstanceId": client_instance_id, "clientRequestId": format!("rename:{sequence}"),
            }).as_object().cloned().unwrap_or_default(),
        )?);
    }
    if action == "session-delete-current" {
        if app.is_active_operation() || session_flow.is_some() {
            app.set_overlay_error("当前会话正在运行，不能删除");
            return Ok(());
        }
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(());
        };
        let restore = app.restore_point();
        let target = app
            .sessions
            .iter()
            .find(|session| session.path != session_path)
            .cloned();
        *sequence += 1;
        let id = format!("session-delete-release-{sequence}");
        *session_flow = Some(SessionFlow::DeleteReleasing {
            id: id.clone(),
            restore,
            target,
        });
        return pipe.request(&encode_release_session_request(
            &id,
            session_path,
            &lease_id,
        )?);
    }
    if action == "session-fork-current" {
        let Some(entry_id) = app.transcript.current_entry_id().map(str::to_owned) else {
            app.set_overlay_error("当前没有可分叉的记录");
            return Ok(());
        };
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(());
        };
        *sequence += 1;
        let id = format!("session-fork-{sequence}");
        *session_flow = Some(SessionFlow::Fork {
            id: id.clone(),
            toast: "已创建并切换分叉会话".to_owned(),
        });
        return pipe.request(&encode_session_write_request(
            &id,
            "fork_session",
            serde_json::json!({
                "sessionPath": session_path, "leaseId": lease_id, "entryId": entry_id,
                "clientInstanceId": client_instance_id, "clientRequestId": format!("fork:{sequence}"),
            }).as_object().cloned().unwrap_or_default(),
        )?);
    }
    if let Some(index) = action
        .strip_prefix("tree-fork:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(node) = app.tree.get(index) else {
            app.set_overlay_error("分支树已刷新，请重新选择");
            return Ok(());
        };
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(());
        };
        *sequence += 1;
        let id = format!("tree-fork-{sequence}");
        *session_flow = Some(SessionFlow::Fork {
            id: id.clone(),
            toast: "已创建并切换分叉会话".to_owned(),
        });
        return pipe.request(&encode_session_write_request(
            &id,
            "fork_session",
            serde_json::json!({
                "sessionPath": session_path, "leaseId": lease_id, "entryId": node.id,
                "clientInstanceId": client_instance_id, "clientRequestId": format!("tree-fork:{sequence}"),
            }).as_object().cloned().unwrap_or_default(),
        )?);
    }
    if let Some(index) = action
        .strip_prefix("tree-label:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(node) = app.tree.get(index).cloned() else {
            app.set_overlay_error("分支树已刷新，请重新选择");
            return Ok(());
        };
        let label = match app.overlay() {
            Some(OverlayState::TextEditor(editor)) => editor.value.trim().to_owned(),
            _ => String::new(),
        };
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(());
        };
        let (filter, _) = list_context(app, "分支树");
        app.close_overlay();
        app.mark_write_pending();
        let mut payload = serde_json::json!({
            "sessionPath": session_path, "leaseId": lease_id, "entryId": node.id,
            "clientInstanceId": client_instance_id, "clientRequestId": format!("tree-label:{sequence}"),
        }).as_object().cloned().unwrap_or_default();
        if !label.is_empty() {
            payload.insert("label".to_owned(), serde_json::Value::String(label));
        }
        return request_b3(
            app,
            pipe,
            sequence,
            B3Command::SetEntryLabel,
            payload,
            PendingIntent::TreeMutation {
                selected_key: node.id,
                filter,
            },
        );
    }
    if let Some(index) = action
        .strip_prefix("tree-summary:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(node) = app.tree.get(index).cloned() else {
            app.set_overlay_error("分支树已刷新，请重新选择");
            return Ok(());
        };
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(());
        };
        let (filter, selected_key) = list_context(app, "分支树");
        app.mark_write_pending();
        return request_b3(
            app, pipe, sequence, B3Command::NavigateSessionTree,
            serde_json::json!({
                "sessionPath": session_path, "leaseId": lease_id, "entryId": node.id, "summarize": true,
                "clientInstanceId": client_instance_id, "clientRequestId": format!("tree-summary:{sequence}"),
            }).as_object().cloned().unwrap_or_default(),
            PendingIntent::TreeNavigate {
                selected_key: selected_key.unwrap_or(node.id),
                filter,
            },
        );
    }
    if let Some(index) = action
        .strip_prefix("tree:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(node) = app.tree.get(index).cloned() else {
            app.set_overlay_error("分支树已刷新，请重新选择");
            return Ok(());
        };
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(());
        };
        if app.is_active_operation() {
            app.set_overlay_error("当前会话正在运行，不能切换分支");
            return Ok(());
        }
        let (filter, selected_key) = list_context(app, "分支树");
        app.mark_write_pending();
        return request_b3(
            app,
            pipe,
            sequence,
            B3Command::NavigateSessionTree,
            serde_json::json!({
                "sessionPath": session_path, "leaseId": lease_id, "entryId": node.id,
                "clientInstanceId": client_instance_id, "clientRequestId": format!("tree-navigate:{sequence}"),
            }).as_object().cloned().unwrap_or_default(),
            PendingIntent::TreeNavigate {
                selected_key: selected_key.unwrap_or(node.id),
                filter,
            },
        );
    }
    if let Some(id) = action.strip_prefix("setting-toggle:") {
        let Some(setting) = app.setting(id).cloned() else {
            app.set_overlay_error("设置已刷新，请重新选择");
            return Ok(());
        };
        let Some(value) = setting.value.as_bool() else {
            app.set_overlay_error("设置类型不匹配");
            return Ok(());
        };
        let (filter, _) = list_context(app, "设置");
        return request_setting_write(
            app,
            pipe,
            session_path,
            client_instance_id,
            sequence,
            id,
            serde_json::Value::Bool(!value),
            filter,
        );
    }
    if let Some(id) = action.strip_prefix("setting-enum:") {
        let Some(setting) = app.setting(id).cloned() else {
            app.set_overlay_error("设置已刷新，请重新选择");
            return Ok(());
        };
        if setting.read_only {
            app.set_overlay_error("此设置为只读");
            return Ok(());
        }
        app.open_overlay(OverlayState::List(ListOverlay {
            title: format!("{} 选项", setting.label),
            origin: OverlayOrigin::User,
            items: setting
                .options
                .iter()
                .enumerate()
                .map(|(index, value)| OverlayItem {
                    label: value.clone(),
                    detail: if setting.value.as_str() == Some(value) {
                        "当前".to_owned()
                    } else {
                        String::new()
                    },
                    action: format!("setting-option:{id}:{index}"),
                })
                .collect(),
            selected: setting
                .options
                .iter()
                .position(|value| setting.value.as_str() == Some(value))
                .unwrap_or(0),
            filter: String::new(),
            status: "Enter 保存，Esc 返回".to_owned(),
        }));
        return Ok(());
    }
    if let Some(pair) = action.strip_prefix("setting-option:") {
        let Some((id, index)) = pair.rsplit_once(':') else {
            app.set_overlay_error("设置选项无效");
            return Ok(());
        };
        let Ok(index) = index.parse::<usize>() else {
            app.set_overlay_error("设置选项无效");
            return Ok(());
        };
        let Some(setting) = app.setting(id).cloned() else {
            app.set_overlay_error("设置已刷新，请重新选择");
            return Ok(());
        };
        let Some(value) = setting.options.get(index).cloned() else {
            app.set_overlay_error("设置选项无效");
            return Ok(());
        };
        app.close_overlay();
        let (filter, _) = list_context(app, "设置");
        return request_setting_write(
            app,
            pipe,
            session_path,
            client_instance_id,
            sequence,
            id,
            serde_json::Value::String(value),
            filter,
        );
    }
    if let Some(id) = action.strip_prefix("setting-text:") {
        let Some(setting) = app.setting(id).cloned() else {
            app.set_overlay_error("设置已刷新，请重新选择");
            return Ok(());
        };
        if !matches!(app.overlay(), Some(OverlayState::TextEditor(_))) {
            let value = match &setting.value {
                serde_json::Value::String(value) => value.clone(),
                serde_json::Value::Number(value) => value.to_string(),
                _ => String::new(),
            };
            app.open_overlay(OverlayState::TextEditor(TextEditorOverlay {
                title: setting.label,
                cursor: value.len(),
                value,
                save_action: action.to_owned(),
                status: match (setting.minimum, setting.maximum) {
                    (Some(minimum), Some(maximum)) => {
                        format!("输入范围 {minimum}..{maximum}，Enter 保存，Esc 返回")
                    }
                    _ => "Enter 保存，Esc 返回".to_owned(),
                },
                secret: false,
            }));
            return Ok(());
        }
        let value = match app.overlay() {
            Some(OverlayState::TextEditor(editor)) => editor.value.clone(),
            _ => String::new(),
        };
        let value = if setting.kind == "integer" {
            let Ok(value) = value.parse::<i64>() else {
                app.set_overlay_error("请输入整数");
                return Ok(());
            };
            if setting.minimum.is_some_and(|minimum| value < minimum)
                || setting.maximum.is_some_and(|maximum| value > maximum)
            {
                app.set_overlay_error("输入超出设置范围");
                return Ok(());
            }
            serde_json::Value::from(value)
        } else {
            serde_json::Value::String(value)
        };
        app.close_overlay();
        let (filter, _) = list_context(app, "设置");
        return request_setting_write(
            app,
            pipe,
            session_path,
            client_instance_id,
            sequence,
            id,
            value,
            filter,
        );
    }
    if let Some(index) = action
        .strip_prefix("model:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(model) = app.models.get(index).cloned() else {
            app.set_overlay_error("模型列表已刷新，请重新选择");
            return Ok(());
        };
        if !model.configured {
            app.set_overlay_error("该模型不可用：Provider 未完成认证");
            return Ok(());
        }
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(());
        };
        let client_request_id = format!(
            "model:{}:{}:{}",
            model.provider,
            model.id,
            sequence.saturating_add(1)
        );
        app.mark_write_pending();
        return request_b3(
            app,
            pipe,
            sequence,
            B3Command::SetSessionModel,
            serde_json::json!({
                "sessionPath": session_path,
                "leaseId": lease_id,
                "clientInstanceId": client_instance_id,
                "clientRequestId": client_request_id,
                "model": { "provider": model.provider, "id": model.id },
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::SessionMutation {
                toast: "已切换模型".to_owned(),
                close_overlay: true,
            },
        );
    }
    if let Some(level) = action.strip_prefix("thinking:") {
        let model = match app.model_supports_reasoning() {
            Ok(model) => model,
            Err(reason) => {
                app.set_overlay_error(reason);
                return Ok(());
            }
        };
        if !model
            .supported_thinking_levels
            .iter()
            .any(|candidate| candidate == level)
        {
            app.set_overlay_error("当前模型不支持此思考强度");
            return Ok(());
        }
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(());
        };
        let client_request_id = format!("thinking:{level}:{}", sequence.saturating_add(1));
        app.mark_write_pending();
        return request_b3(
            app,
            pipe,
            sequence,
            B3Command::SetSessionThinking,
            serde_json::json!({
                "sessionPath": session_path,
                "leaseId": lease_id,
                "clientInstanceId": client_instance_id,
                "clientRequestId": client_request_id,
                "level": level,
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::SessionMutation {
                toast: "已更新思考强度".to_owned(),
                close_overlay: true,
            },
        );
    }
    if let Some(index) = action
        .strip_prefix("login-provider:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(provider) = app.providers.get(index).cloned() else {
            app.set_overlay_error("Provider 列表已刷新，请重新选择");
            return Ok(());
        };
        if provider.auth_methods.is_empty() {
            app.set_overlay_error("该 Provider 没有可用认证方式");
            return Ok(());
        }
        app.open_overlay(OverlayState::List(ListOverlay {
            title: format!("{} 登录方式", provider.name),
            origin: OverlayOrigin::User,
            items: provider
                .auth_methods
                .iter()
                .enumerate()
                .map(|(auth_index, method)| OverlayItem {
                    label: if method == "api_key" {
                        "API Key".to_owned()
                    } else {
                        "OAuth".to_owned()
                    },
                    detail: String::new(),
                    action: format!("auth-login:{index}:{auth_index}"),
                })
                .collect(),
            selected: 0,
            filter: String::new(),
            status: "Enter 登录，Esc 返回".to_owned(),
        }));
        return Ok(());
    }
    if let Some(pair) = action.strip_prefix("auth-login:") {
        let Some((provider_index, auth_index)) = pair.split_once(':') else {
            app.set_overlay_error("认证方式无效");
            return Ok(());
        };
        let (Ok(provider_index), Ok(auth_index)) =
            (provider_index.parse::<usize>(), auth_index.parse::<usize>())
        else {
            app.set_overlay_error("认证方式无效");
            return Ok(());
        };
        let Some(provider) = app.providers.get(provider_index).cloned() else {
            app.set_overlay_error("Provider 列表已刷新，请重新选择");
            return Ok(());
        };
        let Some(auth_type) = provider.auth_methods.get(auth_index).cloned() else {
            app.set_overlay_error("认证方式无效");
            return Ok(());
        };
        app.close_overlay();
        let (filter, _) = list_context(app, "登录");
        let client_request_id = format!(
            "login:{}:{}:{}",
            provider.id,
            auth_type,
            sequence.saturating_add(1)
        );
        app.mark_write_pending();
        return request_b3(
            app,
            pipe,
            sequence,
            B3Command::LoginModelProvider,
            serde_json::json!({
                "provider": provider.id,
                "authType": auth_type,
                "clientInstanceId": client_instance_id,
                "clientRequestId": client_request_id,
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::AuthMutation {
                selected_key: Some(provider.id),
                filter,
                toast: "认证已更新".to_owned(),
            },
        );
    }
    if let Some(index) = action
        .strip_prefix("auth-logout:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(provider) = app.providers.get(index).cloned() else {
            app.set_overlay_error("Provider 列表已刷新，请重新选择");
            return Ok(());
        };
        let (filter, _) = list_context(app, "登录");
        let client_request_id = format!("logout:{}:{}", provider.id, sequence.saturating_add(1));
        app.mark_write_pending();
        return request_b3(
            app,
            pipe,
            sequence,
            B3Command::LogoutModelProvider,
            serde_json::json!({
                "provider": provider.id,
                "clientInstanceId": client_instance_id,
                "clientRequestId": client_request_id,
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::AuthMutation {
                selected_key: Some(provider.id),
                filter,
                toast: "已退出登录".to_owned(),
            },
        );
    }
    let Some(request) = app.take_ui_response() else {
        return Ok(());
    };
    let (value, confirmed) = match (request.kind, action) {
        (UiRequestKind::Confirm, "ui:confirm") => (None, Some(true)),
        (UiRequestKind::Input | UiRequestKind::Secret | UiRequestKind::Editor, "ui:input") => {
            let value = match app.overlay() {
                Some(OverlayState::TextEditor(editor)) => {
                    serde_json::Value::String(editor.value.clone())
                }
                _ => serde_json::Value::String(String::new()),
            };
            (Some(value), None)
        }
        (UiRequestKind::Select, action) if action.starts_with("ui:select:") => (
            Some(serde_json::Value::String(
                action.trim_start_matches("ui:select:").to_owned(),
            )),
            None,
        ),
        _ => {
            app.set_overlay_error("输入类型与当前操作不匹配");
            return Ok(());
        }
    };
    pipe.request(&encode_ui_response(&request.id, value, confirmed, None)?)?;
    app.close_overlay();
    app.set_toast("已提交输入");
    Ok(())
}

#[cfg(unix)]
fn open_custom_editor_recovery(app: &mut AppState) {
    let Some((submitted, missing)) = app.recovery_attachment_counts() else {
        return;
    };
    app.open_overlay(OverlayState::List(ListOverlay {
        title: "恢复草稿".to_owned(),
        origin: OverlayOrigin::User,
        items: vec![
            OverlayItem {
                label: "追加".to_owned(),
                detail: "在当前光标后换行追加".to_owned(),
                action: "recovery-append".to_owned(),
            },
            OverlayItem {
                label: "替换".to_owned(),
                detail: "替换当前输入内容".to_owned(),
                action: "recovery-replace-confirm".to_owned(),
            },
            OverlayItem {
                label: "复制".to_owned(),
                detail: "复制到系统剪贴板".to_owned(),
                action: "recovery-copy".to_owned(),
            },
            OverlayItem {
                label: "丢弃".to_owned(),
                detail: "清除内存中的恢复草稿".to_owned(),
                action: "recovery-discard".to_owned(),
            },
        ],
        selected: 0,
        filter: String::new(),
        status: format!("提交时 {submitted} 张，当前缺 {missing} 张。Esc 返回，Enter 选择"),
    }));
}

#[cfg(unix)]
fn attachment_path(text: &str) -> Option<String> {
    let path = text.strip_prefix("/attach ")?.trim();
    if path.is_empty() {
        return None;
    }
    Some(
        path.strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .unwrap_or(path)
            .to_owned(),
    )
}

#[cfg(unix)]
struct SubmitEditorOptions {
    follow_up: bool,
    custom_editor: bool,
}

#[cfg(unix)]
fn submit_editor(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    follow_up: bool,
    session_flow: &mut Option<SessionFlow>,
) -> Result<(), TuiError> {
    submit_editor_with_origin(
        app,
        pipe,
        session_path,
        client_instance_id,
        sequence,
        SubmitEditorOptions {
            follow_up,
            custom_editor: false,
        },
        session_flow,
    )
}

#[cfg(unix)]
fn submit_custom_editor(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    follow_up: bool,
    session_flow: &mut Option<SessionFlow>,
) -> Result<(), TuiError> {
    submit_editor_with_origin(
        app,
        pipe,
        session_path,
        client_instance_id,
        sequence,
        SubmitEditorOptions {
            follow_up,
            custom_editor: true,
        },
        session_flow,
    )
}

#[cfg(unix)]
fn submit_editor_with_origin(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    options: SubmitEditorOptions,
    session_flow: &mut Option<SessionFlow>,
) -> Result<(), TuiError> {
    let Some(lease_id) = app.lease_id.clone() else {
        app.transcript.status = "正在获取会话租约".to_owned();
        return Ok(());
    };
    let Some(text) = app.editor.submit() else {
        return Ok(());
    };
    if let Some(path) = attachment_path(&text) {
        let cwd = app.active_session_cwd().unwrap_or_default().to_owned();
        return request_b3(
            app,
            pipe,
            sequence,
            B3Command::ReadProjectImage,
            serde_json::json!({ "cwd": cwd, "path": path })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            PendingIntent::ProjectImage {
                source: path.to_owned(),
            },
        );
    }
    if text.trim() == "/attachments" {
        app.open_overlay(attach_overlay(app));
        return Ok(());
    }
    if let Some(command) = builtin_slash_command(&text) {
        open_workbench(
            app,
            command,
            pipe,
            session_path,
            client_instance_id,
            sequence,
            session_flow,
        )?;
        return Ok(());
    }
    *sequence += 1;
    let request_id = format!("composer-{sequence}");
    let command = if options.follow_up {
        "follow_up"
    } else if app.is_active_operation() {
        "steer"
    } else {
        "prompt"
    };
    let attachments = app.attachments.clone();
    let images = attachments
        .iter()
        .map(|attachment| serde_json::json!({ "data": attachment.base64, "mimeType": attachment.mime_type }))
        .collect::<Vec<_>>();
    let response_id = format!("command-{sequence}");
    if options.custom_editor {
        app.begin_custom_editor_submit(
            response_id.clone(),
            crate::app::PendingCustomEditorSubmit {
                command: command.to_owned(),
                session_path: session_path.to_owned(),
                session_generation: app.session_generation,
                editor_component_generation: app
                    .active_extension_editor()
                    .map(|editor| editor.generation),
                lease_id: lease_id.clone(),
                client_instance_id: client_instance_id.to_owned(),
                client_request_id: request_id.clone(),
                text: text.clone(),
                submit_revision: app.extension_editor_revision(),
                attachments: attachments.clone(),
                started_at: Instant::now(),
                retry_count: 0,
            },
        );
    } else if !attachments.is_empty() {
        app.begin_attachment_submit(
            response_id.clone(),
            crate::app::PendingAttachmentSubmit {
                command: command.to_owned(),
                session_path: session_path.to_owned(),
                lease_id: lease_id.clone(),
                client_instance_id: client_instance_id.to_owned(),
                client_request_id: request_id.clone(),
                text: text.clone(),
                attachments,
                started_at: Instant::now(),
            },
        );
    }
    pipe.request(&encode_queue_request(
        &response_id,
        command,
        session_path,
        &lease_id,
        client_instance_id,
        &request_id,
        Some(&text),
        Some(&images),
    )?)?;
    app.transcript.status = if command == "prompt" {
        "已提交"
    } else if command == "steer" {
        "已加入引导队列"
    } else {
        "已加入后续队列"
    }
    .to_owned();
    trace(command);
    Ok(())
}

fn component_line(value: &str) -> String {
    // Parser 丢弃未知控制序列；保留原 SGR/OSC8 只供 Ratatui 的同一 parser 重新投影。
    let _ = crate::rich_text::parse_ansi_lines(&[value.to_owned()]);
    value.chars().take(524_288).collect()
}

fn component_dimension_value(value: Option<&serde_json::Value>) -> Option<String> {
    match value? {
        serde_json::Value::Number(number) => Some(number.to_string()),
        serde_json::Value::String(value) => Some(value.clone()),
        _ => None,
    }
}

fn component_overlay_options(
    value: Option<&serde_json::Value>,
) -> ExtensionComponentOverlayOptions {
    let Some(object) = value.and_then(serde_json::Value::as_object) else {
        return ExtensionComponentOverlayOptions::default();
    };
    ExtensionComponentOverlayOptions {
        width: component_dimension_value(object.get("width")),
        max_height: component_dimension_value(object.get("maxHeight")),
        anchor: object
            .get("anchor")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        row: component_dimension_value(object.get("row")),
        column: component_dimension_value(object.get("col")),
        overlay: object
            .get("overlay")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
    }
}

#[allow(clippy::type_complexity)]
fn parse_component_frame(
    component_id: &str,
    value: &serde_json::Value,
) -> Result<
    (
        u64,
        Vec<String>,
        Option<(u16, u16)>,
        Vec<(u16, u16, u16)>,
        Option<(u16, u16)>,
    ),
    TuiError,
> {
    let object = value
        .as_object()
        .ok_or_else(|| TuiError::InvalidResponse("Extension component frame 无效".to_owned()))?;
    if object
        .get("componentId")
        .and_then(serde_json::Value::as_str)
        != Some(component_id)
    {
        return Err(TuiError::InvalidResponse(
            "Extension componentId 不匹配".to_owned(),
        ));
    }
    let revision = object
        .get("revision")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| TuiError::InvalidResponse("Extension component revision 无效".to_owned()))?;
    let width = object
        .get("width")
        .and_then(serde_json::Value::as_u64)
        .filter(|value| (1..=500).contains(value))
        .ok_or_else(|| TuiError::InvalidResponse("Extension component 宽度无效".to_owned()))?;
    let height = object
        .get("height")
        .and_then(serde_json::Value::as_u64)
        .filter(|value| (1..=500).contains(value))
        .ok_or_else(|| TuiError::InvalidResponse("Extension component 高度无效".to_owned()))?;
    let lines = object
        .get("lines")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| TuiError::InvalidResponse("Extension component 行无效".to_owned()))?
        .iter()
        .take(usize::try_from(height).unwrap_or(500))
        .map(|line| {
            line.as_str().map(component_line).ok_or_else(|| {
                TuiError::InvalidResponse("Extension component 行文本无效".to_owned())
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let cursor = object
        .get("cursor")
        .and_then(serde_json::Value::as_object)
        .and_then(|cursor| {
            Some((
                u16::try_from(cursor.get("row")?.as_u64()?).ok()?,
                u16::try_from(cursor.get("column")?.as_u64()?).ok()?,
            ))
        });
    let hit_regions = object
        .get("hitRegions")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| TuiError::InvalidResponse("Extension component 命中区无效".to_owned()))?
        .iter()
        .take(500)
        .filter_map(|region| {
            let region = region.as_object()?;
            let row = u16::try_from(region.get("row")?.as_u64()?).ok()?;
            let column = u16::try_from(region.get("column")?.as_u64()?).ok()?;
            let region_width = u16::try_from(region.get("width")?.as_u64()?).ok()?;
            (row < height as u16 && column < width as u16 && region_width > 0).then_some((
                row,
                column,
                region_width.min(width as u16 - column),
            ))
        })
        .collect();
    let desired_size = object
        .get("desiredSize")
        .and_then(serde_json::Value::as_object)
        .map(|size| {
            let desired_width = size
                .get("width")
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
                .unwrap_or(width as u16);
            let desired_height = size
                .get("height")
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
                .unwrap_or(height as u16);
            (desired_width.clamp(1, 500), desired_height.clamp(1, 500))
        });
    Ok((revision, lines, cursor, hit_regions, desired_size))
}

fn extension_component_state(
    component_id: &str,
    generation: u64,
    placement: &str,
    visible: bool,
    overlay_options: ExtensionComponentOverlayOptions,
    frame: &serde_json::Value,
) -> Result<ExtensionComponentState, TuiError> {
    let (revision, lines, cursor, hit_regions, desired_size) =
        parse_component_frame(component_id, frame)?;
    Ok(ExtensionComponentState {
        component_id: component_id.to_owned(),
        generation,
        revision,
        placement: placement.to_owned(),
        visible,
        lines,
        cursor,
        hit_regions,
        desired_size,
        overlay_options,
    })
}

fn extension_statuses(
    value: &serde_json::Value,
) -> Result<std::collections::BTreeMap<String, String>, TuiError> {
    value
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("Extension UI 缺少状态".to_owned()))?
        .iter()
        .map(|item| {
            Ok((
                item.get("key")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| TuiError::InvalidResponse("Extension 状态键无效".to_owned()))?
                    .to_owned(),
                item.get("text")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| TuiError::InvalidResponse("Extension 状态文本无效".to_owned()))?
                    .to_owned(),
            ))
        })
        .collect()
}

fn extension_widgets(value: &serde_json::Value) -> Result<Vec<ExtensionWidget>, TuiError> {
    value
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("Extension UI 缺少小部件".to_owned()))?
        .iter()
        .map(|item| {
            Ok(ExtensionWidget {
                key: item
                    .get("key")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| TuiError::InvalidResponse("Extension 小部件键无效".to_owned()))?
                    .to_owned(),
                placement: item
                    .get("placement")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        TuiError::InvalidResponse("Extension 小部件位置无效".to_owned())
                    })?
                    .to_owned(),
                lines: item
                    .get("lines")
                    .and_then(serde_json::Value::as_array)
                    .ok_or_else(|| {
                        TuiError::InvalidResponse("Extension 小部件内容无效".to_owned())
                    })?
                    .iter()
                    .map(|line| {
                        line.as_str().map(str::to_owned).ok_or_else(|| {
                            TuiError::InvalidResponse("Extension 小部件行无效".to_owned())
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            })
        })
        .collect()
}

fn extension_state(value: &serde_json::Value) -> Result<ExtensionUiState, TuiError> {
    let object = value
        .as_object()
        .ok_or_else(|| TuiError::InvalidResponse("Extension UI 状态无效".to_owned()))?;
    let statuses = extension_statuses(
        object
            .get("statuses")
            .ok_or_else(|| TuiError::InvalidResponse("Extension UI 缺少状态".to_owned()))?,
    )?;
    let widgets = extension_widgets(
        object
            .get("widgets")
            .ok_or_else(|| TuiError::InvalidResponse("Extension UI 缺少小部件".to_owned()))?,
    )?;
    let indicator = object
        .get("workingIndicator")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| TuiError::InvalidResponse("Extension UI 缺少指示器".to_owned()))?;
    Ok(ExtensionUiState {
        revision: object
            .get("revision")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        statuses,
        widgets,
        working_message: object
            .get("workingMessage")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        working_visible: object
            .get("workingVisible")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
        working_frames: indicator
            .get("frames")
            .and_then(serde_json::Value::as_array)
            .map(|frames| {
                frames
                    .iter()
                    .filter_map(|frame| frame.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
        working_interval_ms: indicator
            .get("intervalMs")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(120)
            .max(16),
        hidden_thinking_label: object
            .get("hiddenThinkingLabel")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        title: object
            .get("title")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        terminal_input_listener_count: object
            .get("terminalInputListenerCount")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        components: std::collections::BTreeMap::new(),
    })
}

fn apply_extension_delta(app: &mut AppState, value: &serde_json::Value) -> Result<(), TuiError> {
    let object = value
        .as_object()
        .ok_or_else(|| TuiError::InvalidResponse("Extension UI 增量无效".to_owned()))?;
    let revision = object
        .get("revision")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if revision < app.extension_ui.revision {
        return Ok(());
    }
    let mut state = app.extension_ui.clone();
    state.revision = revision;
    if let Some(statuses) = object.get("statuses") {
        state.statuses = extension_statuses(statuses)?;
    }
    if let Some(widgets) = object.get("widgets") {
        state.widgets = extension_widgets(widgets)?;
    }
    if let Some(message) = object.get("workingMessage") {
        state.working_message = message.as_str().map(str::to_owned);
    }
    if let Some(visible) = object
        .get("workingVisible")
        .and_then(serde_json::Value::as_bool)
    {
        state.working_visible = visible;
    }
    if let Some(indicator) = object.get("workingIndicator") {
        let parsed = extension_state(&serde_json::json!({
            "revision": revision, "statuses": [], "widgets": [], "workingMessage": state.working_message,
            "workingVisible": state.working_visible, "workingIndicator": indicator,
            "hiddenThinkingLabel": state.hidden_thinking_label, "title": state.title,
            "terminalInputListenerCount": state.terminal_input_listener_count,
        }))?;
        state.working_frames = parsed.working_frames;
        state.working_interval_ms = parsed.working_interval_ms;
    }
    if let Some(label) = object.get("hiddenThinkingLabel") {
        state.hidden_thinking_label = label.as_str().map(str::to_owned);
    }
    if let Some(title) = object.get("title") {
        state.title = title.as_str().map(str::to_owned);
    }
    if let Some(count) = object
        .get("terminalInputListenerCount")
        .and_then(serde_json::Value::as_u64)
    {
        state.terminal_input_listener_count = count;
    }
    app.apply_extension_ui_snapshot(state);
    Ok(())
}

fn extension_title_osc(title: Option<&str>) -> String {
    let sanitized = title.map(sanitize_terminal_text).unwrap_or_default();
    format!("\x1b]0;{sanitized}\x07")
}

fn write_extension_title(title: Option<&str>) {
    let _ = io::stdout().write_all(extension_title_osc(title).as_bytes());
    let _ = io::stdout().flush();
}

#[allow(clippy::too_many_arguments)]
fn queue_operation_id(raw: &serde_json::Value) -> Option<&str> {
    raw.get("result")
        .and_then(|result| {
            result.get("operationId").or_else(|| {
                result
                    .get("operation")
                    .and_then(|operation| operation.get("operationId"))
            })
        })
        .and_then(serde_json::Value::as_str)
}

#[allow(clippy::too_many_arguments)]
fn apply_server_message(
    app: &mut AppState,
    message: &ServerMessage,
    session_path: &str,
    pipe: &mut ProtocolPipe,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
    quit_requested: &mut bool,
) -> Result<bool, TuiError> {
    let raw = message.json().map_err(TuiError::from)?;
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("event") {
        let event = raw.get("event").and_then(serde_json::Value::as_object);
        let active_path = app.active_session_path().unwrap_or(session_path).to_owned();
        if let Some(event) = event
            && event.get("sessionPath").and_then(serde_json::Value::as_str)
                == Some(active_path.as_str())
        {
            match event.get("type").and_then(serde_json::Value::as_str) {
                Some("extension_ui_snapshot") => {
                    let state =
                        extension_state(event.get("state").unwrap_or(&serde_json::Value::Null))?;
                    write_extension_title(state.title.as_deref());
                    app.apply_extension_ui_snapshot(state);
                    return Ok(false);
                }
                Some("extension_ui_delta") => {
                    let title_updated = event
                        .get("delta")
                        .and_then(serde_json::Value::as_object)
                        .is_some_and(|delta| delta.contains_key("title"));
                    apply_extension_delta(
                        app,
                        event.get("delta").unwrap_or(&serde_json::Value::Null),
                    )?;
                    if title_updated {
                        write_extension_title(app.extension_ui.title.as_deref());
                    }
                    return Ok(false);
                }
                Some("extension_component_mount") => {
                    let component_id = event
                        .get("componentId")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse(
                                "Extension component mount 缺少 id".to_owned(),
                            )
                        })?;
                    let generation = event
                        .get("generation")
                        .and_then(serde_json::Value::as_u64)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse(
                                "Extension component mount 缺少 generation".to_owned(),
                            )
                        })?;
                    let placement = event
                        .get("placement")
                        .and_then(serde_json::Value::as_str)
                        .filter(|placement| {
                            matches!(
                                *placement,
                                "widget_above"
                                    | "widget_below"
                                    | "header"
                                    | "footer"
                                    | "custom_overlay"
                                    | "editor"
                            )
                        })
                        .ok_or_else(|| {
                            TuiError::InvalidResponse("Extension component 位置无效".to_owned())
                        })?;
                    let visible = event
                        .get("visible")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false);
                    let component = extension_component_state(
                        component_id,
                        generation,
                        placement,
                        visible,
                        component_overlay_options(event.get("overlayOptions")),
                        event.get("frame").unwrap_or(&serde_json::Value::Null),
                    )?;
                    if app.apply_extension_component_mount(component) {
                        trace_id("component_mount_applied", component_id);
                    }
                    return Ok(false);
                }
                Some("extension_component_frame") => {
                    let component_id = event
                        .get("componentId")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse(
                                "Extension component frame 缺少 id".to_owned(),
                            )
                        })?;
                    let generation = event
                        .get("generation")
                        .and_then(serde_json::Value::as_u64)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse(
                                "Extension component frame 缺少 generation".to_owned(),
                            )
                        })?;
                    let (revision, lines, cursor, hit_regions, desired_size) =
                        parse_component_frame(
                            component_id,
                            event.get("frame").unwrap_or(&serde_json::Value::Null),
                        )?;
                    if app.apply_extension_component_frame(
                        component_id,
                        generation,
                        revision,
                        lines,
                        cursor,
                        hit_regions,
                    ) {
                        if let Some(component) = app.extension_ui.components.get_mut(component_id) {
                            component.desired_size = desired_size;
                        }
                        trace_component_frame_applied(component_id, revision);
                    }
                    return Ok(false);
                }
                Some("extension_component_invalidate") => {
                    let component_id = event
                        .get("componentId")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse(
                                "Extension component invalidate 缺少 id".to_owned(),
                            )
                        })?;
                    let generation = event
                        .get("generation")
                        .and_then(serde_json::Value::as_u64)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse(
                                "Extension component invalidate 缺少 generation".to_owned(),
                            )
                        })?;
                    let visible = event
                        .get("visible")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false);
                    if app.apply_extension_component_visibility(component_id, generation, visible) {
                        trace_id("component_visibility_applied", component_id);
                    }
                    return Ok(false);
                }
                Some("extension_component_unmount") => {
                    let component_id = event
                        .get("componentId")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse(
                                "Extension component unmount 缺少 id".to_owned(),
                            )
                        })?;
                    let generation = event
                        .get("generation")
                        .and_then(serde_json::Value::as_u64)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse(
                                "Extension component unmount 缺少 generation".to_owned(),
                            )
                        })?;
                    if app.remove_extension_component(component_id, generation) {
                        trace_id("component_unmount_applied", component_id);
                    }
                    return Ok(false);
                }
                Some("extension_editor_submit") => {
                    let submit = event
                        .get("submit")
                        .and_then(serde_json::Value::as_object)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse("自定义编辑器提交无效".to_owned())
                        })?;
                    let text = submit
                        .get("text")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse("自定义编辑器提交缺少文本".to_owned())
                        })?;
                    let revision = submit
                        .get("revision")
                        .and_then(serde_json::Value::as_u64)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse("自定义编辑器提交缺少修订".to_owned())
                        })?;
                    if app.apply_extension_editor_action("set", text, revision) {
                        submit_custom_editor(
                            app,
                            pipe,
                            &active_path,
                            client_instance_id,
                            sequence,
                            false,
                            session_flow,
                        )?;
                    }
                    return Ok(false);
                }
                Some("extension_editor_app_action") => {
                    let action = event
                        .get("action")
                        .and_then(serde_json::Value::as_object)
                        .ok_or_else(|| {
                            TuiError::InvalidResponse("自定义编辑器动作无效".to_owned())
                        })?;
                    let name = action
                        .get("action")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    apply_extension_editor_app_action(
                        app,
                        name,
                        pipe,
                        session_path,
                        client_instance_id,
                        sequence,
                        session_flow,
                        quit_requested,
                    )?;
                    return Ok(false);
                }
                Some("extension_editor_action") => {
                    let action = event
                        .get("action")
                        .and_then(serde_json::Value::as_object)
                        .ok_or_else(|| TuiError::InvalidResponse("编辑器动作无效".to_owned()))?;
                    let kind = action
                        .get("action")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    let text = action
                        .get("text")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    let revision = action
                        .get("revision")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0);
                    app.apply_extension_editor_action(kind, text, revision);
                    return Ok(false);
                }
                _ => {}
            }
        }
    }
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("response")
        && let Some(id) = raw.get("id").and_then(serde_json::Value::as_str)
        && let Some(pending) = app.take_component_input(id)
    {
        let invalid_lease = raw
            .get("error")
            .and_then(|error| error.get("code"))
            .and_then(serde_json::Value::as_str)
            == Some("invalid_session_lease");
        if raw.get("ok").and_then(serde_json::Value::as_bool) != Some(true)
            || raw
                .get("result")
                .and_then(|result| result.get("accepted"))
                .and_then(serde_json::Value::as_bool)
                != Some(true)
        {
            if invalid_lease {
                app.clear_active_lease();
                app.clear_extension_components();
                app.set_toast("组件输入租约已失效，已清除待处理输入");
            } else {
                app.set_toast("组件输入被 Host 拒绝，可按 Esc 取消");
            }
        } else {
            trace_id("component_input_accepted", &pending.component_id);
            if let Some(action) = raw
                .get("result")
                .and_then(|result| result.get("appAction"))
                .and_then(serde_json::Value::as_str)
            {
                apply_extension_editor_app_action(
                    app,
                    action,
                    pipe,
                    session_path,
                    client_instance_id,
                    sequence,
                    session_flow,
                    quit_requested,
                )?;
            }
        }
        return Ok(false);
    }
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("response")
        && let Some(id) = raw.get("id").and_then(serde_json::Value::as_str)
        && id.starts_with("component-cancel-")
        && raw.get("ok").and_then(serde_json::Value::as_bool) != Some(true)
    {
        app.set_toast("组件取消失败，可重试或退出");
        return Ok(false);
    }
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("response")
        && let Some(id) = raw.get("id").and_then(serde_json::Value::as_str)
        && let Some(pending) = app.pending_terminal_inputs.remove(id)
    {
        let invalid_lease = raw
            .get("error")
            .and_then(|error| error.get("code"))
            .and_then(serde_json::Value::as_str)
            == Some("invalid_session_lease");
        if raw.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
            if invalid_lease {
                app.clear_active_lease();
                app.clear_extension_components();
                app.set_toast("终端输入租约已失效，未执行回退输入");
            } else {
                app.set_toast("终端输入被 Host 拒绝");
            }
            return Ok(false);
        }
        trace_id("extension_input_applied", id);
        let consume = raw
            .get("result")
            .and_then(|result| result.get("consume"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        if !consume {
            let data = raw
                .get("result")
                .and_then(|result| result.get("data"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or(&pending.data);
            if apply_extension_raw_input(
                app,
                data,
                pipe,
                session_path,
                client_instance_id,
                sequence,
                session_flow,
                quit_requested,
            )? {
                *quit_requested = true;
            }
        }
        return Ok(false);
    }
    let page_response_id = (raw.get("type").and_then(serde_json::Value::as_str)
        == Some("response"))
    .then(|| raw.get("id").and_then(serde_json::Value::as_str))
    .flatten()
    .filter(|id| id.starts_with("initial-") || id.starts_with("older-"))
    .map(str::to_owned);
    if let Some(id) = &page_response_id {
        trace_id("host_response_received", id);
    }
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("response")
        && let Some(id) = raw.get("id").and_then(serde_json::Value::as_str)
        && app.pending_custom_editor_submits.contains_key(id)
    {
        if raw.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
            if let Some(operation_id) = queue_operation_id(&raw) {
                app.acknowledge_custom_editor_submit(id, operation_id.to_owned());
            } else {
                app.reject_custom_editor_submit(id);
            }
        } else {
            app.reject_custom_editor_submit(id);
            return Ok(false);
        }
    }
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("response")
        && let Some(id) = raw.get("id").and_then(serde_json::Value::as_str)
        && app.pending_attachment_submits.contains_key(id)
    {
        if raw.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
            app.acknowledge_attachment_submit(id);
        } else {
            app.reject_attachment_submit(id);
        }
        return Ok(false);
    }
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("event")
        && raw
            .get("event")
            .and_then(|value| value.get("type"))
            .and_then(serde_json::Value::as_str)
            == Some("ui_request")
    {
        let event = raw
            .get("event")
            .and_then(serde_json::Value::as_object)
            .ok_or_else(|| TuiError::InvalidResponse("ui_request 缺少事件内容".to_owned()))?;
        let id = event
            .get("id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| TuiError::InvalidResponse("ui_request 缺少 id".to_owned()))?;
        let payload = event
            .get("payload")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let title = event
            .get("title")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("需要输入");
        let kind = match event.get("kind").and_then(serde_json::Value::as_str) {
            Some("select") => UiRequestKind::Select,
            Some("confirm") => UiRequestKind::Confirm,
            Some("input") => UiRequestKind::Input,
            Some("secret") => UiRequestKind::Secret,
            Some("editor") => UiRequestKind::Editor,
            Some("notify") => {
                if app.mark_ui_responded(id) {
                    app.open_overlay(OverlayState::Detail(ui_notify_detail(title, &payload)));
                    trace("ui_notify");
                }
                return Ok(false);
            }
            Some(kind) => {
                let message = format!("不支持的输入类型: {kind}");
                app.set_overlay_error(message.clone());
                app.transcript.status = message;
                if app.cancel_unknown_ui_request(id) {
                    pipe.request(&encode_ui_response(id, None, None, Some(true))?)?;
                }
                return Ok(false);
            }
            None => {
                app.set_overlay_error("输入请求缺少类型");
                app.transcript.status = "输入请求缺少类型".to_owned();
                if app.cancel_unknown_ui_request(id) {
                    pipe.request(&encode_ui_response(id, None, None, Some(true))?)?;
                }
                return Ok(false);
            }
        };
        if !app.register_ui_request(UiRequest {
            id: id.to_owned(),
            kind,
        }) {
            return Ok(false);
        }
        match kind {
            UiRequestKind::Select => app.open_overlay(OverlayState::List(ListOverlay {
                title: title.to_owned(),
                origin: OverlayOrigin::User,
                items: ui_select_items(&payload),
                selected: 0,
                filter: String::new(),
                status: "方向键选择，Enter 提交，Esc 取消".to_owned(),
            })),
            UiRequestKind::Confirm => app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                title: title.to_owned(),
                message: payload
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("确认继续此操作？")
                    .to_owned(),
                confirm_action: "ui:confirm".to_owned(),
                status: String::new(),
            })),
            UiRequestKind::Input | UiRequestKind::Secret | UiRequestKind::Editor => {
                let value = payload
                    .get("value")
                    .or_else(|| payload.get("prefill"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                app.open_overlay(OverlayState::TextEditor(TextEditorOverlay {
                    title: title.to_owned(),
                    cursor: value.len(),
                    value,
                    save_action: "ui:input".to_owned(),
                    status: "Enter 提交，Esc 取消".to_owned(),
                    secret: kind == UiRequestKind::Secret,
                }));
            }
        }
        return Ok(false);
    }
    if let Some(outcome) = apply_session_flow(
        app,
        &raw,
        pipe,
        client_instance_id,
        sequence,
        session_flow,
        quit_requested,
    )? {
        return Ok(outcome);
    }
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("response")
        && let Some(id) = raw.get("id").and_then(serde_json::Value::as_str)
        && let Some(pending) = app.take_image_request(id)
    {
        if pending.generation != app.image_generation {
            return Ok(false);
        }
        if raw.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
            app.mark_image_failed(pending.content_ref);
            app.transcript.status = "图片读取失败，已保留占位".to_owned();
            return Ok(false);
        }
        let result = message.validated_b3_result_value(B3Command::ReadImageContent)?;
        let object = result
            .as_object()
            .ok_or_else(|| TuiError::InvalidResponse("图片响应无效".to_owned()))?;
        let content_ref = object
            .get("contentRef")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| TuiError::InvalidResponse("图片响应缺少引用".to_owned()))?;
        let mime_type = object
            .get("mimeType")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| TuiError::InvalidResponse("图片响应缺少 MIME".to_owned()))?;
        let byte_length = object
            .get("byteLength")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| TuiError::InvalidResponse("图片响应缺少长度".to_owned()))?;
        let data = object
            .get("data")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| TuiError::InvalidResponse("图片响应缺少数据".to_owned()))?;
        if content_ref != pending.content_ref
            || !mime_type.starts_with("image/")
            || byte_length > 4 * 1024 * 1024
        {
            app.mark_image_failed(pending.content_ref);
            app.transcript.status = "图片数据无效，已保留占位".to_owned();
            return Ok(false);
        }
        app.image_cache.insert(CachedImage {
            content_ref: content_ref.to_owned(),
            mime_type: mime_type.to_owned(),
            byte_length: usize::try_from(byte_length).unwrap_or(usize::MAX),
            base64: data.to_owned(),
        });
        return Ok(false);
    }
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("response")
        && let Some(id) = raw.get("id").and_then(serde_json::Value::as_str)
        && let Some(pending) = app.take_rich_text_request(id)
    {
        if pending.generation != app.rich_text_generation {
            return Ok(false);
        }
        if raw.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
            app.mark_rich_text_failed(pending.key);
            app.transcript.status = "富文本渲染失败，已保留纯文本".to_owned();
            return Ok(false);
        }
        let result = message.validated_b3_result_value(B3Command::RenderRichText)?;
        let object = result
            .as_object()
            .ok_or_else(|| TuiError::InvalidResponse("富文本响应无效".to_owned()))?;
        let content_hash = object
            .get("contentHash")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| TuiError::InvalidResponse("富文本响应缺少内容哈希".to_owned()))?;
        if content_hash != pending.key.content_hash {
            app.mark_rich_text_failed(pending.key);
            return Ok(false);
        }
        let lines = object
            .get("lines")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| TuiError::InvalidResponse("富文本响应缺少行".to_owned()))?
            .iter()
            .map(|line| {
                line.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| TuiError::InvalidResponse("富文本行无效".to_owned()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        app.rich_text_cache
            .insert(pending.key, crate::rich_text::parse_ansi_lines(&lines));
        return Ok(false);
    }
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("response")
        && let Some(id) = raw.get("id").and_then(serde_json::Value::as_str)
        && let Some(pending) = app.take_pending(id)
    {
        if !app.pending_workspace_is_current(&pending) {
            return Ok(false);
        }
        if raw.get("ok").and_then(serde_json::Value::as_bool) == Some(false) {
            if matches!(&pending.intent, PendingIntent::TreeNavigate { .. }) {
                app.pending_editor_replace = None;
            }
            if let PendingIntent::InstructionMutation { target, .. } = &pending.intent
                && raw
                    .get("error")
                    .and_then(|value| value.get("code"))
                    .and_then(serde_json::Value::as_str)
                    == Some("instruction_conflict")
            {
                let scope = if *target == WorkbenchTarget::InstructionsProject {
                    "project"
                } else {
                    "host"
                };
                app.open_overlay(OverlayState::List(ListOverlay {
                    title: "指令冲突".to_owned(),
                    origin: OverlayOrigin::User,
                    items: vec![
                        OverlayItem {
                            label: "重新加载".to_owned(),
                            detail: "读取外部修改后的内容，不覆盖现有文件".to_owned(),
                            action: format!("instruction-conflict-reload:{scope}"),
                        },
                        OverlayItem {
                            label: "放弃保存".to_owned(),
                            detail: "保留磁盘上的外部版本".to_owned(),
                            action: "instruction-conflict-discard".to_owned(),
                        },
                    ],
                    selected: 0,
                    filter: String::new(),
                    status: "Enter 选择，Esc 返回".to_owned(),
                }));
            }
            app.set_overlay_error(
                raw.get("error")
                    .and_then(|value| value.get("message"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("工作台请求失败"),
            );
            return Ok(false);
        }
        let result = message.validated_b3_result_value(pending.request.command)?;
        match pending.intent {
            PendingIntent::Overlay { target } => apply_workbench_result(app, target, result),
            PendingIntent::ChangeDetail => {
                app.change_detail = Some(parse_git_diff(&result)?);
                app.change_detail_expanded = false;
                app.replace_overlay(change_detail_overlay(app));
            }
            PendingIntent::SkillMutation {
                selected_key,
                filter,
            } => {
                app.skills = parse_skills(&result)?;
                app.replace_overlay(skills_overlay(&app.skills, Some(&selected_key), filter));
                app.set_toast("技能启用状态已更新");
            }
            PendingIntent::TrustMutation => {
                app.trust = Some(parse_trust(&result)?);
                app.replace_overlay(trust_overlay(app));
                app.set_toast("项目信任已更新");
            }
            PendingIntent::InstructionMutation {
                target,
                selected_key,
                filter,
            } => {
                let instructions = parse_instructions(&result)?;
                if target == WorkbenchTarget::InstructionsProject {
                    app.project_instructions = instructions;
                    app.replace_overlay(instructions_overlay(
                        &app.project_instructions,
                        "项目",
                        Some(&selected_key),
                        filter,
                    ));
                } else {
                    app.host_instructions = instructions;
                    app.replace_overlay(instructions_overlay(
                        &app.host_instructions,
                        "本机",
                        Some(&selected_key),
                        filter,
                    ));
                }
                app.set_toast("指令已保存");
            }
            PendingIntent::PackageMutation {
                selected_key,
                filter,
                toast,
            } => {
                let message = result
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(&toast)
                    .to_owned();
                app.set_toast(message);
                request_workspace_load(
                    app,
                    pipe,
                    sequence,
                    WorkbenchTarget::Packages,
                    selected_key,
                    filter,
                )?;
            }
            PendingIntent::WorkbenchLoad {
                target,
                selected_key,
                filter,
            } => apply_workbench_load(app, target, selected_key, filter, result)?,
            PendingIntent::SubagentRead {
                parent_session_path,
                selected_key: _,
                filter: _,
            } => {
                let object = result
                    .as_object()
                    .ok_or_else(|| TuiError::InvalidResponse("Subagent 详情响应无效".to_owned()))?;
                let committed = object
                    .get("transcript")
                    .map(|value| parse_subagent(value, &parent_session_path))
                    .transpose()?;
                let live = object
                    .get("live")
                    .map(|value| parse_subagent(value, &parent_session_path))
                    .transpose()?;
                let snapshot = match (committed, live) {
                    (Some(committed), Some(live)) => {
                        crate::app::merge_subagents([committed], [live])
                            .into_iter()
                            .next()
                    }
                    (Some(snapshot), None) | (None, Some(snapshot)) => Some(snapshot),
                    (None, None) => None,
                }
                .ok_or_else(|| TuiError::InvalidResponse("Subagent 不存在或已过期".to_owned()))?;
                app.subagent_detail = Some(snapshot.clone());
                app.open_overlay(subagent_detail_overlay(&snapshot));
            }
            PendingIntent::SubagentMutation {
                parent_session_path,
                selected_key,
                filter,
                toast,
            } => {
                app.set_toast(
                    result
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or(&toast),
                );
                request_subagents(
                    app,
                    pipe,
                    sequence,
                    parent_session_path,
                    Some(selected_key),
                    filter,
                )?;
            }
            PendingIntent::ClipboardRead { insert } => {
                let clipboard = parse_clipboard(&result)?;
                if !clipboard.capability {
                    app.set_overlay_error("Host 不支持文本剪贴板");
                } else if insert {
                    if let Some(text) = clipboard.text.as_deref() {
                        app.editor.insert(text);
                        app.set_toast("已插入剪贴板文本");
                    } else {
                        app.set_toast("剪贴板没有文本");
                    }
                } else {
                    app.clipboard = Some(clipboard.clone());
                    app.replace_overlay(clipboard_overlay(&clipboard, None));
                }
            }
            PendingIntent::ClipboardBothText { generation } => {
                let clipboard = parse_clipboard(&result)?;
                if let Some(state) = app.clipboard_read.as_mut()
                    && state.generation == generation
                {
                    state.text = clipboard.capability.then_some(clipboard);
                    state.text_done = true;
                }
                finish_clipboard_both(app);
            }
            PendingIntent::ClipboardBothImage { generation } => {
                let object = result
                    .as_object()
                    .ok_or_else(|| TuiError::InvalidResponse("剪贴板图片响应无效".to_owned()))?;
                let image =
                    if object
                        .get("capability")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false)
                        && object
                            .get("available")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false)
                    {
                        Some(app.new_attachment(
                            "clipboard-image".to_owned(),
                            "clipboard".to_owned(),
                            required_string(object, "mimeType")?,
                            usize::try_from(required_u64(object, "byteLength")?).map_err(|_| {
                                TuiError::InvalidResponse("图片大小无效".to_owned())
                            })?,
                            required_string(object, "contentHash")?,
                            required_string(object, "data")?,
                        ))
                    } else {
                        None
                    };
                if let Some(state) = app.clipboard_read.as_mut()
                    && state.generation == generation
                {
                    state.image = image;
                    state.image_done = true;
                }
                finish_clipboard_both(app);
            }
            PendingIntent::AttachCompletion { text } => {
                let object = result
                    .as_object()
                    .ok_or_else(|| TuiError::InvalidResponse("补全响应无效".to_owned()))?;
                let prefix_start = usize::try_from(required_u64(object, "prefixStart")?)
                    .ok()
                    .and_then(|offset| utf16_offset_to_byte(&text, offset))
                    .ok_or_else(|| TuiError::InvalidResponse("补全起始位置无效".to_owned()))?;
                let prefix_end = usize::try_from(required_u64(object, "prefixEnd")?)
                    .ok()
                    .and_then(|offset| utf16_offset_to_byte(&text, offset))
                    .ok_or_else(|| TuiError::InvalidResponse("补全结束位置无效".to_owned()))?;
                let items = object
                    .get("items")
                    .and_then(serde_json::Value::as_array)
                    .ok_or_else(|| TuiError::InvalidResponse("补全响应缺少候选".to_owned()))?
                    .iter()
                    .filter_map(|item| {
                        let object = item.as_object()?;
                        let kind = object.get("kind")?.as_str()?;
                        if !matches!(kind, "file" | "directory") {
                            return None;
                        }
                        Some(ComposerCompletionItem {
                            value: object.get("value")?.as_str()?.to_owned(),
                            label: object.get("label")?.as_str()?.to_owned(),
                            description: object
                                .get("description")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_owned),
                            kind: kind.to_owned(),
                        })
                    })
                    .collect::<Vec<_>>();
                if items.is_empty() {
                    app.set_toast("没有匹配的项目图片文件");
                } else {
                    app.composer_completion = Some(ComposerCompletion {
                        text,
                        prefix_start,
                        prefix_end,
                        items: items.clone(),
                    });
                    app.open_overlay(OverlayState::List(ListOverlay {
                        title: "添加图片".to_owned(),
                        origin: OverlayOrigin::User,
                        items: items
                            .iter()
                            .enumerate()
                            .map(|(index, item)| OverlayItem {
                                label: item.label.clone(),
                                detail: format!(
                                    "{}{}",
                                    if item.kind == "directory" {
                                        "目录  "
                                    } else {
                                        "文件  "
                                    },
                                    item.description.clone().unwrap_or_default()
                                ),
                                action: format!("attachment-completion:{index}"),
                            })
                            .collect(),
                        selected: 0,
                        filter: String::new(),
                        status: "Enter 选择，目录会继续补全，Esc 返回".to_owned(),
                    }));
                }
            }
            PendingIntent::ProjectImage { source } => {
                let object = result
                    .as_object()
                    .ok_or_else(|| TuiError::InvalidResponse("图片响应无效".to_owned()))?;
                let mime_type = required_string(object, "mimeType")?;
                let base64 = required_string(object, "base64")?;
                let byte_length = usize::try_from(required_u64(object, "byteLength")?)
                    .map_err(|_| TuiError::InvalidResponse("图片大小无效".to_owned()))?;
                let content_hash = required_string(object, "contentHash")?;
                let name = std::path::Path::new(&source)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or(&source)
                    .to_owned();
                let attachment =
                    app.new_attachment(name, source, mime_type, byte_length, content_hash, base64);
                match app.add_attachment(attachment) {
                    Ok(true) => app.set_toast("已添加图片附件"),
                    Ok(false) => app.set_toast("图片已在附件中"),
                    Err(message) => app.set_overlay_error(message),
                }
            }
            PendingIntent::ClipboardImage => {
                let object = result
                    .as_object()
                    .ok_or_else(|| TuiError::InvalidResponse("剪贴板图片响应无效".to_owned()))?;
                if !object
                    .get("available")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
                {
                    app.set_toast("剪贴板中没有图片");
                    return Ok(false);
                }
                let mime_type = required_string(object, "mimeType")?;
                let base64 = required_string(object, "data")?;
                let byte_length = usize::try_from(required_u64(object, "byteLength")?)
                    .map_err(|_| TuiError::InvalidResponse("图片大小无效".to_owned()))?;
                let content_hash = required_string(object, "contentHash")?;
                let attachment = app.new_attachment(
                    "clipboard-image".to_owned(),
                    "clipboard".to_owned(),
                    mime_type,
                    byte_length,
                    content_hash,
                    base64,
                );
                match app.add_attachment(attachment) {
                    Ok(true) => app.set_toast("已添加剪贴板图片"),
                    Ok(false) => app.set_toast("图片已在附件中"),
                    Err(message) => app.set_overlay_error(message),
                }
            }
            PendingIntent::ClipboardMutation { toast } => {
                if result
                    .get("capability")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
                {
                    app.set_toast(toast);
                } else {
                    app.set_overlay_error("Host 不支持剪贴板写入");
                }
            }
            PendingIntent::SettingMutation {
                selected_key,
                filter,
            } => {
                app.invalidate_rich_text();
                if result
                    .get("requiresRestart")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
                {
                    app.set_toast("设置已保存，重启后生效");
                } else {
                    app.set_toast("设置已保存");
                }
                request_settings(
                    app,
                    pipe,
                    session_path,
                    sequence,
                    Some(selected_key),
                    filter,
                )?;
            }
            PendingIntent::SessionMutation {
                toast,
                close_overlay,
            } => {
                let snapshot = serde_json::from_value(result).map_err(|error| {
                    TuiError::InvalidResponse(format!("会话状态响应无效: {error}"))
                })?;
                app.apply_snapshot(snapshot);
                if close_overlay {
                    app.close_overlay();
                }
                app.set_toast(toast);
            }
            PendingIntent::TreeMutation {
                selected_key,
                filter,
            } => {
                request_b3(
                    app,
                    pipe,
                    sequence,
                    B3Command::GetSessionTree,
                    serde_json::json!({ "sessionPath": session_path })
                        .as_object()
                        .cloned()
                        .unwrap_or_default(),
                    PendingIntent::WorkbenchLoad {
                        target: WorkbenchTarget::Tree,
                        selected_key: Some(selected_key),
                        filter,
                    },
                )?;
            }
            PendingIntent::TreeNavigate {
                selected_key: _,
                filter: _,
            } => {
                if result
                    .get("cancelled")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
                {
                    app.pending_editor_replace = None;
                    app.close_overlay();
                    app.set_toast("已取消分支切换");
                    return Ok(false);
                }
                if let Some(text) = result.get("editorText").and_then(serde_json::Value::as_str) {
                    if app.editor.is_empty() {
                        app.editor.replace(text);
                    } else {
                        app.pending_editor_replace = Some(text.to_owned());
                        app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                            title: "替换输入草稿".to_owned(),
                            message: "分支带回了新的输入内容，确认替换当前草稿？".to_owned(),
                            confirm_action: "tree-replace-editor".to_owned(),
                            status: String::new(),
                        }));
                        return Ok(false);
                    }
                }
                app.clear_overlay_transient();
                app.set_toast("已切换分支");
                return Ok(true);
            }
            PendingIntent::AuthMutation {
                selected_key,
                filter,
                toast,
            } => {
                app.models = parse_models(&result)?;
                app.set_toast(toast);
                request_b3(
                    app,
                    pipe,
                    sequence,
                    B3Command::ListModelProviders,
                    serde_json::Map::new(),
                    PendingIntent::WorkbenchLoad {
                        target: WorkbenchTarget::Login,
                        selected_key,
                        filter,
                    },
                )?;
            }
        }
        return Ok(false);
    }
    let read_only = if let Some(id) = &page_response_id {
        trace_id("page_decode_start", id);
        let decoded = message.read_only().map_err(TuiError::from)?;
        trace_id("page_decode_end", id);
        decoded
    } else {
        message.read_only().map_err(TuiError::from)?
    };
    match read_only {
        ReadOnlyMessage::Response(response) => apply_response(app, &response),
        ReadOnlyMessage::Event(event) => {
            let active_path = app.active_session_path().unwrap_or(session_path).to_owned();
            apply_event(app, &event, &active_path)
        }
        ReadOnlyMessage::Hello | ReadOnlyMessage::HelloError { .. } => Ok(false),
    }
}

fn apply_session_flow(
    app: &mut AppState,
    raw: &serde_json::Value,
    pipe: &mut ProtocolPipe,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
    quit_requested: &mut bool,
) -> Result<Option<bool>, TuiError> {
    let Some(id) = raw.get("id").and_then(serde_json::Value::as_str) else {
        return Ok(None);
    };
    let Some(flow) = session_flow.take() else {
        return Ok(None);
    };
    let expected = match &flow {
        SessionFlow::InitialAcquiring { id, .. }
        | SessionFlow::List { id, .. }
        | SessionFlow::Rename { id, .. }
        | SessionFlow::Fork { id, .. }
        | SessionFlow::Readonly { id, .. }
        | SessionFlow::SwitchReleasing { id, .. }
        | SessionFlow::SwitchAcquiring { id, .. }
        | SessionFlow::SwitchRollback { id, .. }
        | SessionFlow::CreateStarting { id, .. }
        | SessionFlow::CreateReleasingOld { id, .. }
        | SessionFlow::CreateCleanup { id, .. }
        | SessionFlow::DeleteReleasing { id, .. }
        | SessionFlow::DeleteRemoving { id, .. }
        | SessionFlow::DeleteAcquiring { id, .. }
        | SessionFlow::DeleteRollback { id, .. }
        | SessionFlow::QuitReleasing { id, .. } => id,
    };
    if id != expected {
        *session_flow = Some(flow);
        return Ok(None);
    }
    let success = raw.get("ok").and_then(serde_json::Value::as_bool) == Some(true);
    let error = raw
        .get("error")
        .and_then(|value| value.get("message"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("会话操作失败")
        .to_owned();
    let result = raw
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    match flow {
        SessionFlow::InitialAcquiring {
            path, generation, ..
        } => {
            if !success {
                app.clear_active_lease();
                app.set_overlay_error(error);
                return Ok(Some(false));
            }
            if app.active_session_path() != Some(path.as_str())
                || app.session_generation != generation
            {
                return Ok(Some(false));
            }
            let (lease_id, snapshot) = parse_lease_snapshot(&result)?;
            if *quit_requested {
                *sequence += 1;
                let id = format!("quit-release-{sequence}");
                *session_flow = Some(SessionFlow::QuitReleasing { id: id.clone() });
                pipe.request(&encode_release_session_request(
                    &id,
                    &snapshot.path,
                    &lease_id,
                )?)?;
                return Ok(Some(false));
            }
            app.apply_active_lease(lease_id, snapshot);
            app.transcript.status = "已获取会话租约".to_owned();
            Ok(Some(false))
        }
        SessionFlow::List { selected_path, .. } => {
            if !success {
                app.set_overlay_error(error);
                return Ok(Some(false));
            }
            app.sessions = parse_sessions(&result)?;
            app.replace_overlay(session_overlay(
                &app.sessions,
                selected_path.as_deref(),
                OverlayOrigin::User,
            ));
            Ok(Some(false))
        }
        SessionFlow::Rename { index, name, .. } => {
            if !success {
                app.set_overlay_error(error);
                return Ok(Some(false));
            }
            if let Some(session) = app.sessions.get_mut(index) {
                session.name = (!name.trim().is_empty()).then_some(name);
            }
            app.replace_overlay(session_overlay(
                &app.sessions,
                app.active_session_path(),
                OverlayOrigin::User,
            ));
            app.set_toast("已重命名会话");
            Ok(Some(false))
        }
        SessionFlow::Fork { toast, .. } => {
            if !success {
                app.set_overlay_error(error);
                return Ok(Some(false));
            }
            let (lease_id, snapshot) = parse_lease_snapshot(&result)?;
            app.commit_session_switch(snapshot.path.clone(), lease_id, snapshot);
            app.set_toast(toast);
            Ok(Some(true))
        }
        SessionFlow::Readonly {
            path,
            replace,
            generation,
            ..
        } => {
            if !success {
                app.set_overlay_error(error);
                return Ok(Some(false));
            }
            let Some(pending) = app.take_transcript_request(id) else {
                return Ok(Some(false));
            };
            if pending.view != TranscriptViewKind::Readonly
                || pending.generation != generation
                || pending.session_path != path
            {
                return Ok(Some(false));
            }
            let page: lystar_protocol::TranscriptPage = serde_json::from_value(result)
                .map_err(|error| TuiError::InvalidResponse(format!("只读记录响应无效: {error}")))?;
            let view_snapshot = {
                let view = app
                    .readonly_view
                    .get_or_insert_with(|| ReadonlySessionView {
                        path: path.clone(),
                        ..ReadonlySessionView::default()
                    });
                if view.path != path || view.generation != generation {
                    return Ok(Some(false));
                }
                if replace {
                    view.transcript.replace_page(
                        page.items,
                        page.transcript_generation,
                        page.transcript_revision,
                        page.previous_cursor,
                    );
                } else {
                    view.transcript
                        .prepend_page(page.items, page.previous_cursor);
                }
                view.status = format!("{} 轮", view.transcript.cached_rounds());
                view.clone()
            };
            app.replace_overlay(readonly_overlay(&view_snapshot));
            Ok(Some(false))
        }
        SessionFlow::SwitchReleasing {
            target, restore, ..
        } => {
            if !success {
                app.set_overlay_error(error);
                return Ok(Some(false));
            }
            app.clear_active_lease();
            *sequence += 1;
            let id = format!("session-acquire-{sequence}");
            *session_flow = Some(SessionFlow::SwitchAcquiring {
                id: id.clone(),
                target: target.clone(),
                restore,
            });
            pipe.request(&encode_acquire_session_request(
                &id,
                &target.path,
                client_instance_id,
            )?)?;
            Ok(Some(false))
        }
        SessionFlow::SwitchAcquiring {
            target, restore, ..
        } => {
            if success {
                let (lease_id, snapshot) = parse_lease_snapshot(&result)?;
                if *quit_requested {
                    *sequence += 1;
                    let id = format!("quit-release-{sequence}");
                    *session_flow = Some(SessionFlow::QuitReleasing { id: id.clone() });
                    pipe.request(&encode_release_session_request(
                        &id,
                        &snapshot.path,
                        &lease_id,
                    )?)?;
                    return Ok(Some(false));
                }
                app.commit_session_switch(target.path, lease_id, snapshot);
                app.set_toast("已切换会话");
                return Ok(Some(true));
            }
            let mut restore_for_reacquire = restore.clone();
            let old_path = restore_for_reacquire
                .context
                .as_ref()
                .map(|context| context.path.clone())
                .ok_or_else(|| TuiError::InvalidResponse("切换缺少原会话".to_owned()))?;
            if let Some(context) = &mut restore_for_reacquire.context {
                context.lease_id = None;
            }
            restore_for_reacquire.lease_id = None;
            app.restore_session(restore_for_reacquire);
            *sequence += 1;
            let id = format!("session-rollback-{sequence}");
            *session_flow = Some(SessionFlow::SwitchRollback {
                id: id.clone(),
                restore,
                reason: error,
            });
            pipe.request(&encode_acquire_session_request(
                &id,
                &old_path,
                client_instance_id,
            )?)?;
            Ok(Some(false))
        }
        SessionFlow::SwitchRollback {
            restore, reason, ..
        } => {
            if success {
                let (lease_id, snapshot) = parse_lease_snapshot(&result)?;
                app.restore_session(restore);
                app.apply_active_lease(lease_id, snapshot);
                app.set_overlay_error(format!("切换失败，已恢复原会话: {reason}"));
            } else {
                app.clear_active_session("切换失败且原会话恢复失败");
                app.replace_overlay(session_overlay(
                    &app.sessions,
                    None,
                    OverlayOrigin::RecoverySession,
                ));
                app.set_overlay_error(format!("切换失败且原会话恢复失败: {error}"));
            }
            Ok(Some(false))
        }
        SessionFlow::CreateStarting { restore, .. } => {
            if !success {
                app.set_overlay_error(error);
                return Ok(Some(false));
            }
            let (lease_id, snapshot) = parse_lease_snapshot(&result)?;
            let old = restore
                .context
                .as_ref()
                .and_then(|context| context.lease_id.clone());
            let old_path = restore.context.as_ref().map(|context| context.path.clone());
            if let (Some(old_lease), Some(old_path)) = (old, old_path) {
                *sequence += 1;
                let id = format!("session-create-release-{sequence}");
                *session_flow = Some(SessionFlow::CreateReleasingOld {
                    id: id.clone(),
                    path: snapshot.path.clone(),
                    lease_id,
                    snapshot,
                    restore,
                });
                pipe.request(&encode_release_session_request(&id, &old_path, &old_lease)?)?;
                Ok(Some(false))
            } else {
                app.commit_session_switch(snapshot.path.clone(), lease_id, snapshot);
                app.set_toast("已新建会话");
                Ok(Some(true))
            }
        }
        SessionFlow::CreateReleasingOld {
            path,
            lease_id,
            snapshot,
            restore,
            ..
        } => {
            if success {
                app.clear_active_lease();
                app.commit_session_switch(path, lease_id, snapshot);
                app.set_toast("已新建会话");
                return Ok(Some(true));
            }
            *sequence += 1;
            let id = format!("session-create-cleanup-{sequence}");
            *session_flow = Some(SessionFlow::CreateCleanup {
                id: id.clone(),
                restore,
                reason: error,
            });
            pipe.request(&encode_release_session_request(
                &id,
                &snapshot.path,
                &lease_id,
            )?)?;
            Ok(Some(false))
        }
        SessionFlow::CreateCleanup {
            restore, reason, ..
        } => {
            app.restore_session(restore);
            app.set_overlay_error(format!("新建会话后无法释放原会话: {reason}"));
            Ok(Some(false))
        }
        SessionFlow::DeleteReleasing {
            restore, target, ..
        } => {
            if !success {
                app.set_overlay_error(error);
                return Ok(Some(false));
            }
            app.clear_active_lease();
            let path = restore
                .context
                .as_ref()
                .map(|context| context.path.clone())
                .ok_or_else(|| TuiError::InvalidResponse("删除缺少会话路径".to_owned()))?;
            let cwd = restore
                .context
                .as_ref()
                .map(|context| context.cwd.clone())
                .unwrap_or_default();
            *sequence += 1;
            let id = format!("session-delete-{sequence}");
            *session_flow = Some(SessionFlow::DeleteRemoving {
                id: id.clone(),
                restore,
                target,
            });
            pipe.request(&encode_session_write_request(
                &id,
                "delete_session",
                serde_json::json!({
                    "cwd": cwd, "sessionPath": path,
                    "clientInstanceId": client_instance_id,
                    "clientRequestId": format!("delete:{sequence}"),
                })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            )?)?;
            Ok(Some(false))
        }
        SessionFlow::DeleteRemoving {
            restore, target, ..
        } => {
            if !success {
                let path = restore
                    .context
                    .as_ref()
                    .map(|context| context.path.clone())
                    .unwrap_or_default();
                *sequence += 1;
                let id = format!("session-delete-rollback-{sequence}");
                *session_flow = Some(SessionFlow::DeleteRollback {
                    id: id.clone(),
                    restore,
                    reason: error,
                });
                pipe.request(&encode_acquire_session_request(
                    &id,
                    &path,
                    client_instance_id,
                )?)?;
                return Ok(Some(false));
            }
            let Some(target) = target else {
                app.clear_active_session("当前会话已删除");
                app.clear_overlay_transient();
                return Ok(Some(false));
            };
            *sequence += 1;
            let id = format!("session-delete-acquire-{sequence}");
            *session_flow = Some(SessionFlow::DeleteAcquiring {
                id: id.clone(),
                target: target.clone(),
            });
            pipe.request(&encode_acquire_session_request(
                &id,
                &target.path,
                client_instance_id,
            )?)?;
            Ok(Some(false))
        }
        SessionFlow::DeleteAcquiring { target, .. } => {
            if !success {
                app.clear_active_session("当前会话已删除，无法切换目标会话");
                app.replace_overlay(session_overlay(
                    &app.sessions,
                    None,
                    OverlayOrigin::RecoverySession,
                ));
                app.set_overlay_error(format!("当前会话已删除，无法切换目标会话: {error}"));
                return Ok(Some(false));
            }
            let (lease_id, snapshot) = parse_lease_snapshot(&result)?;
            app.commit_session_switch(target.path, lease_id, snapshot);
            app.set_toast("已删除会话并切换");
            Ok(Some(true))
        }
        SessionFlow::DeleteRollback {
            restore, reason, ..
        } => {
            if success {
                let (lease_id, snapshot) = parse_lease_snapshot(&result)?;
                app.restore_session(restore);
                app.apply_active_lease(lease_id, snapshot);
                app.set_overlay_error(format!("删除失败，已恢复原会话: {reason}"));
            } else {
                app.clear_active_session("删除失败且原会话恢复失败");
                app.replace_overlay(session_overlay(
                    &app.sessions,
                    None,
                    OverlayOrigin::RecoverySession,
                ));
                app.set_overlay_error(format!("删除失败且原会话恢复失败: {error}"));
            }
            Ok(Some(false))
        }
        SessionFlow::QuitReleasing { .. } => {
            if !success {
                app.set_overlay_error(format!("退出时释放会话失败: {error}"));
            }
            app.clear_active_lease();
            *quit_requested = true;
            Ok(Some(false))
        }
    }
}

fn parse_lease_snapshot(
    result: &serde_json::Value,
) -> Result<(String, lystar_protocol::SessionSnapshot), TuiError> {
    let lease_id = result
        .get("lease")
        .and_then(|lease| lease.get("leaseId"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| TuiError::InvalidResponse("会话响应缺少 leaseId".to_owned()))?;
    let snapshot = serde_json::from_value(
        result
            .get("snapshot")
            .cloned()
            .ok_or_else(|| TuiError::InvalidResponse("会话响应缺少 snapshot".to_owned()))?,
    )
    .map_err(|error| TuiError::InvalidResponse(format!("会话状态响应无效: {error}")))?;
    Ok((lease_id, snapshot))
}

fn ui_notify_detail(title: &str, payload: &serde_json::Value) -> DetailOverlay {
    const FIELD_LIMIT: usize = 512;
    const LINE_LIMIT: usize = 12;
    let bounded = |value: &str| {
        if value.len() <= FIELD_LIMIT {
            return value.to_owned();
        }
        let mut output = String::new();
        for character in value.chars() {
            if output.len() + character.len_utf8() > FIELD_LIMIT.saturating_sub(3) {
                break;
            }
            output.push(character);
        }
        format!("{output}...")
    };
    let value = |key: &str| {
        payload
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(bounded)
    };
    let method = payload
        .get("method")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let mut lines = Vec::new();
    let mut link = None;
    let mut copy_text = None;
    match method {
        "auth_url" => {
            if let Some(instructions) = value("instructions") {
                lines.push(instructions);
            }
            if let Some(url) = value("url") {
                let line = format!("认证链接: {url}");
                link = Some(OverlayLink {
                    line: lines.len(),
                    label: url.clone(),
                    href: url,
                });
                lines.push(line);
            }
        }
        "auth_device_code" => {
            if let Some(code) = value("userCode") {
                lines.push(format!("设备码: {code}"));
                copy_text = Some(code);
            }
            if let Some(url) = value("verificationUri") {
                let line = format!("验证地址: {url}");
                link = Some(OverlayLink {
                    line: lines.len(),
                    label: url.clone(),
                    href: url,
                });
                lines.push(line);
            }
            for key in ["intervalSeconds", "expiresInSeconds"] {
                if let Some(number) = payload.get(key).and_then(serde_json::Value::as_u64) {
                    lines.push(format!("{key}: {number}"));
                }
            }
        }
        "auth_progress" | "auth_info" => {
            if let Some(message) = value("message") {
                lines.push(message);
            }
        }
        _ => {
            for key in ["message", "text", "status", "key"] {
                if let Some(message) = value(key) {
                    lines.push(format!("{key}: {message}"));
                }
            }
        }
    }
    if lines.is_empty() {
        lines.push("认证状态已更新".to_owned());
    }
    lines.truncate(LINE_LIMIT);
    DetailOverlay {
        title: title.to_owned(),
        lines,
        scroll: 0,
        status: if copy_text.is_some() {
            "c 复制设备码，Esc 返回".to_owned()
        } else {
            "Esc 返回".to_owned()
        },
        link,
        copy_text,
    }
}

fn apply_workbench_result(app: &mut AppState, title: String, result: serde_json::Value) {
    app.replace_overlay(OverlayState::Detail(DetailOverlay {
        title,
        lines: pretty_json_lines(&result),
        scroll: 0,
        status: "Esc 返回".to_owned(),
        link: None,
        copy_text: None,
    }));
}

fn apply_workbench_load(
    app: &mut AppState,
    target: WorkbenchTarget,
    selected_key: Option<String>,
    filter: String,
    result: serde_json::Value,
) -> Result<(), TuiError> {
    match target {
        WorkbenchTarget::Changes => {
            app.git_status = Some(parse_git_status(&result)?);
            app.replace_overlay(changes_overlay(app, selected_key.as_deref(), filter));
        }
        WorkbenchTarget::Skills => {
            app.skills = parse_skills(&result)?;
            app.replace_overlay(skills_overlay(&app.skills, selected_key.as_deref(), filter));
        }
        WorkbenchTarget::Trust => {
            app.trust = Some(parse_trust(&result)?);
            app.replace_overlay(trust_overlay(app));
        }
        WorkbenchTarget::InstructionsProject => {
            app.project_instructions = parse_instructions(&result)?;
            app.replace_overlay(instructions_overlay(
                &app.project_instructions,
                "项目",
                selected_key.as_deref(),
                filter,
            ));
        }
        WorkbenchTarget::InstructionsHost => {
            app.host_instructions = parse_instructions(&result)?;
            app.replace_overlay(instructions_overlay(
                &app.host_instructions,
                "本机",
                selected_key.as_deref(),
                filter,
            ));
        }
        WorkbenchTarget::Packages => {
            app.packages = parse_packages(&result)?;
            app.replace_overlay(packages_overlay(
                &app.packages,
                selected_key.as_deref(),
                filter,
            ));
        }
        WorkbenchTarget::Update => {
            app.update = Some(parse_update(&result)?);
            app.replace_overlay(update_overlay(app));
        }
        WorkbenchTarget::Subagents => {
            let parent_session_path = app.subagent_parent_path.clone().unwrap_or_default();
            app.subagents = parse_subagents(&result, &parent_session_path)?;
            app.replace_overlay(subagents_overlay(
                &app.subagents,
                selected_key.as_deref(),
                filter,
                app.active_session_path(),
            ));
        }
        WorkbenchTarget::Clipboard => {
            return Err(TuiError::InvalidResponse("剪贴板响应路由错误".to_owned()));
        }
        WorkbenchTarget::Settings => {
            app.settings = parse_settings(&result)?;
            app.replace_overlay(settings_overlay(
                &app.settings,
                selected_key.as_deref(),
                filter,
            ));
        }
        WorkbenchTarget::Model => {
            app.models = parse_models(&result)?;
            app.replace_overlay(model_overlay(app, selected_key.as_deref(), filter));
        }
        WorkbenchTarget::Thinking => {
            app.models = parse_models(&result)?;
            app.replace_overlay(thinking_overlay(app));
        }
        WorkbenchTarget::Login => {
            app.providers = parse_providers(&result)?;
            app.replace_overlay(login_overlay(
                &app.providers,
                selected_key.as_deref(),
                filter,
            ));
        }
        WorkbenchTarget::Tree => {
            app.tree = parse_tree(&result)?;
            app.replace_overlay(tree_overlay(
                &app.tree,
                selected_key.as_deref(),
                filter,
                app.tree_filter,
            ));
        }
        WorkbenchTarget::Sessions => {
            return Err(TuiError::InvalidResponse(
                "会话工作台响应路由错误".to_owned(),
            ));
        }
    }
    Ok(())
}

fn changes_tab_label(tab: ChangesTab) -> &'static str {
    match tab {
        ChangesTab::Staged => "已暂存",
        ChangesTab::Unstaged => "未暂存",
        ChangesTab::All => "全部",
    }
}

fn changes_overlay(app: &AppState, selected_key: Option<&str>, filter: String) -> OverlayState {
    let status = app.git_status.as_ref();
    let items = status
        .map(|status| {
            status
                .files
                .iter()
                .enumerate()
                .filter(|(_, file)| match app.changes_tab {
                    ChangesTab::Staged => file.staged,
                    ChangesTab::Unstaged => file.unstaged || file.untracked || file.conflicted,
                    ChangesTab::All => true,
                })
                .map(|(index, file)| {
                    let mut flags = format!(
                        "index:{} worktree:{}",
                        file.index_status, file.worktree_status
                    );
                    if file.conflicted {
                        flags.push_str(" 冲突");
                    } else if file.untracked {
                        flags.push_str(" 未跟踪");
                    }
                    OverlayItem {
                        label: file.path.clone(),
                        detail: flags,
                        action: format!("change:{index}"),
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let selected = selected_key
        .and_then(|key| items.iter().position(|item| item.action == key))
        .unwrap_or(0);
    let detail = status.map_or_else(
        || "正在读取".to_owned(),
        |status| {
            format!(
                "{}  upstream:{}  ahead:{} behind:{}",
                status.branch.as_deref().unwrap_or("detached"),
                status.upstream.as_deref().unwrap_or("无"),
                status.ahead,
                status.behind
            )
        },
    );
    OverlayState::List(ListOverlay {
        title: format!("变更 [{}]", changes_tab_label(app.changes_tab)),
        origin: OverlayOrigin::User,
        items,
        selected,
        filter,
        status: format!("{detail}  Tab 切换  Enter 查看  r 刷新"),
    })
}

fn change_detail_overlay(app: &AppState) -> OverlayState {
    let diff = app.change_detail.as_ref().expect("change detail exists");
    let mut lines = vec![format!(
        "{}  {}  +{} -{}",
        diff.path.as_deref().unwrap_or("全部变更"),
        if diff.staged {
            "已暂存"
        } else {
            "未暂存"
        },
        diff.additions,
        diff.deletions
    )];
    if app.change_detail_expanded {
        lines.extend(diff.diff.lines().map(str::to_owned));
    } else if !diff.diff.is_empty() {
        lines.push("Diff 已摘要，按 Ctrl+O 展开".to_owned());
    }
    OverlayState::Detail(DetailOverlay {
        title: "变更详情".to_owned(),
        lines,
        scroll: 0,
        status: if app.change_detail_expanded {
            "Ctrl+O 摘要  Esc 返回".to_owned()
        } else {
            "Ctrl+O 展开  Esc 返回".to_owned()
        },
        link: None,
        copy_text: None,
    })
}

fn skills_overlay(
    skills: &[SkillDescriptor],
    selected_key: Option<&str>,
    filter: String,
) -> OverlayState {
    let items = skills
        .iter()
        .enumerate()
        .map(|(index, skill)| OverlayItem {
            label: skill.name.clone(),
            detail: format!(
                "{}  {}  {}  {}",
                skill.source,
                skill.scope,
                if skill.enabled {
                    "已启用"
                } else {
                    "已禁用"
                },
                skill.description
            ),
            action: if skill.eligible {
                format!("skill:{index}")
            } else {
                "disabled:临时 Skill 不支持修改启用状态".to_owned()
            },
        })
        .collect::<Vec<_>>();
    let selected = selected_key
        .and_then(|key| items.iter().position(|item| item.action == key))
        .unwrap_or(0);
    OverlayState::List(ListOverlay {
        title: "技能".to_owned(),
        origin: OverlayOrigin::User,
        items,
        selected,
        filter,
        status: "Enter 选择作用域并切换，输入筛选，r 刷新".to_owned(),
    })
}

fn trust_overlay(app: &AppState) -> OverlayState {
    let trust = app.trust.as_ref();
    let trusted = trust.and_then(|value| value.trusted);
    let state = match trusted {
        Some(true) => "已信任",
        Some(false) => "不信任",
        None => "未选择",
    };
    let detail = trust.map_or_else(
        || "正在读取".to_owned(),
        |value| {
            format!(
                "{}  风险:{}  {}",
                value.cwd,
                if value.resource_risk { "有" } else { "无" },
                value.reason
            )
        },
    );
    OverlayState::List(ListOverlay {
        title: "项目信任".to_owned(),
        origin: OverlayOrigin::User,
        items: vec![OverlayItem {
            label: state.to_owned(),
            detail,
            action: "trust:toggle".to_owned(),
        }],
        selected: 0,
        filter: String::new(),
        status: "t 或 Enter 切换，需确认".to_owned(),
    })
}

fn instructions_overlay(
    instructions: &[InstructionDescriptor],
    scope: &str,
    selected_key: Option<&str>,
    filter: String,
) -> OverlayState {
    let scope_key = if scope == "项目" { "project" } else { "host" };
    let items = instructions
        .iter()
        .enumerate()
        .map(|(index, instruction)| OverlayItem {
            label: instruction.file_name.clone(),
            detail: format!(
                "{} {} {} {}",
                if instruction.exists {
                    "存在"
                } else {
                    "不存在"
                },
                if instruction.active {
                    "生效"
                } else {
                    "未生效"
                },
                if instruction.editable {
                    "可编辑"
                } else {
                    "只读"
                },
                instruction.path
            ),
            action: if instruction.editable {
                format!("instruction:{scope_key}:{index}")
            } else {
                "disabled:此指令文件不允许编辑".to_owned()
            },
        })
        .collect::<Vec<_>>();
    let selected = selected_key
        .and_then(|key| items.iter().position(|item| item.action == key))
        .unwrap_or(0);
    OverlayState::List(ListOverlay {
        title: format!("指令 [{scope}]"),
        origin: OverlayOrigin::User,
        items,
        selected,
        filter,
        status: "Tab 切换项目/本机，Enter 完整编辑，r 刷新".to_owned(),
    })
}

fn packages_overlay(
    packages: &[PackageDescriptor],
    selected_key: Option<&str>,
    filter: String,
) -> OverlayState {
    let items = packages
        .iter()
        .enumerate()
        .map(|(index, package)| OverlayItem {
            label: package.source.clone(),
            detail: format!(
                "{}  {}  {}",
                package.scope,
                package.installed_path.as_deref().unwrap_or("未解析"),
                if package.filtered {
                    "已过滤"
                } else {
                    "已配置"
                }
            ),
            action: format!("package:{index}"),
        })
        .collect::<Vec<_>>();
    let selected = selected_key
        .and_then(|key| items.iter().position(|item| item.action == key))
        .unwrap_or(0);
    OverlayState::List(ListOverlay {
        title: "包".to_owned(),
        origin: OverlayOrigin::User,
        items,
        selected,
        filter,
        status: "i 安装  d 删除  u 更新当前  U 更新全部  r 刷新".to_owned(),
    })
}

fn subagent_running(state: &str) -> bool {
    matches!(state, "queued" | "running" | "waiting")
}

fn subagents_overlay(
    snapshots: &[SubagentDescriptor],
    selected_key: Option<&str>,
    filter: String,
    active_session_path: Option<&str>,
) -> OverlayState {
    let items = snapshots
        .iter()
        .enumerate()
        .map(|(index, snapshot)| {
            let mut detail = format!(
                "run:{}  {}  {}  {}ms",
                snapshot.run_id, snapshot.source, snapshot.state, snapshot.elapsed_ms
            );
            if let Some(action) = &snapshot.current_action {
                detail.push_str(&format!("  {action}"));
            }
            OverlayItem {
                label: snapshot.name.clone(),
                detail,
                action: format!("subagent:{index}"),
            }
        })
        .collect::<Vec<_>>();
    let selected = selected_key
        .and_then(|key| items.iter().position(|item| item.action == key))
        .unwrap_or(0);
    let controllable = snapshots.iter().any(|snapshot| {
        snapshot.parent_session_path == active_session_path.unwrap_or_default()
            && snapshot.controllable
            && (subagent_running(&snapshot.state) || snapshot.session_file.is_some())
    });
    OverlayState::List(ListOverlay {
        title: "Subagent".to_owned(),
        origin: OverlayOrigin::User,
        items,
        selected,
        filter,
        status: if controllable {
            "Enter 详情  a 停止运行项  c 继续已结束项  r 刷新".to_owned()
        } else {
            "Enter 详情  r 刷新".to_owned()
        },
    })
}

fn subagent_detail_overlay(snapshot: &SubagentDescriptor) -> OverlayState {
    let mut lines = vec![
        format!("runId: {}", snapshot.run_id),
        format!("agentId: {}", snapshot.agent_id),
        format!("名称: {}", snapshot.name),
        format!("来源: {}", snapshot.source),
        format!("状态: {}", snapshot.state),
        format!("任务: {}", bounded_text(&snapshot.task, 4096)),
        format!("更新时间: {}", snapshot.updated_at),
        format!("耗时: {}ms", snapshot.elapsed_ms),
    ];
    if let Some(action) = &snapshot.current_action {
        lines.push(format!("当前 Tool: {}", bounded_text(action, 4096)));
    }
    if let Some(cwd) = &snapshot.session_cwd {
        lines.push(format!("session cwd: {cwd}"));
    }
    if let Some(path) = &snapshot.session_file {
        lines.push(format!("session path: {path}"));
    } else {
        lines.push("未提供持久 Session，显示状态摘要".to_owned());
    }
    OverlayState::Detail(DetailOverlay {
        title: "Subagent 详情".to_owned(),
        lines,
        scroll: 0,
        status: if snapshot.session_file.is_some() {
            "Enter 查看嵌套 Subagent  v 只读记录  Esc 返回".to_owned()
        } else {
            "Esc 返回".to_owned()
        },
        link: None,
        copy_text: None,
    })
}

fn clipboard_preview(text: &str) -> String {
    bounded_text(text, 1024).replace('\n', "\\n")
}

fn clipboard_overlay(
    clipboard: &ClipboardDescriptor,
    image: Option<&ComposerAttachment>,
) -> OverlayState {
    let mut lines = vec![format!(
        "文本剪贴板: {}",
        if clipboard.capability {
            "支持"
        } else {
            "不支持"
        }
    )];
    lines.push(match image {
        Some(image) => format!(
            "图片剪贴板: {} {} B #{}",
            image.mime_type,
            image.byte_length,
            &image.content_hash[..image.content_hash.len().min(12)]
        ),
        None => "图片剪贴板: 没有图片".to_owned(),
    });
    lines.push(match &clipboard.text {
        Some(text) => format!("预览: {}", clipboard_preview(text)),
        None => "预览: 空或 Host 未返回文本".to_owned(),
    });
    OverlayState::Detail(DetailOverlay {
        title: "剪贴板".to_owned(),
        lines,
        scroll: 0,
        status: "i 插入输入框  w 写入输入框  c 复制预览  Esc 返回".to_owned(),
        link: None,
        copy_text: clipboard.text.clone(),
    })
}

fn update_overlay(app: &AppState) -> OverlayState {
    let update = app.update.as_ref().expect("update exists");
    let mut lines = vec![format!("当前: {}", update.current_version)];
    lines.push(format!(
        "最新: {}  状态: {}",
        update.latest_version.as_deref().unwrap_or("未知"),
        update.status
    ));
    if let Some(url) = &update.url {
        lines.push(format!("地址: {url}"));
    }
    if let Some(note) = &update.note {
        lines.push(format!("说明: {}", bounded_text(note, 1024)));
    }
    lines.push(format!("仅检查版本: {}", update.install_blocked_reason));
    OverlayState::Detail(DetailOverlay {
        title: "更新检查".to_owned(),
        lines,
        scroll: 0,
        status: "r 重新检查  Esc 返回".to_owned(),
        link: None,
        copy_text: None,
    })
}

fn bounded_text(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_owned();
    }
    let mut output = String::new();
    for character in value.chars() {
        if output.len() + character.len_utf8() > max.saturating_sub(3) {
            break;
        }
        output.push(character);
    }
    format!("{output}...")
}

fn settings_overlay(
    settings: &[SettingDescriptor],
    selected_key: Option<&str>,
    filter: String,
) -> OverlayState {
    let items = settings
        .iter()
        .map(|setting| {
            let scope = if setting.scope == "global" {
                "全局"
            } else {
                "项目"
            };
            let mut detail = format!("{}  {}", setting.display_value, scope);
            if setting.restart_required {
                detail.push_str("  重启后生效");
            }
            if setting.read_only {
                detail.push_str("  只读");
            }
            let action = if setting.read_only {
                "disabled:此设置为只读".to_owned()
            } else {
                match setting.kind.as_str() {
                    "boolean" => format!("setting-toggle:{}", setting.id),
                    "enum" => format!("setting-enum:{}", setting.id),
                    "integer" | "string" => format!("setting-text:{}", setting.id),
                    _ => "disabled:不支持的设置类型".to_owned(),
                }
            };
            OverlayItem {
                label: setting.label.clone(),
                detail,
                action,
            }
        })
        .collect::<Vec<_>>();
    let selected = selected_key
        .and_then(|id| settings.iter().position(|setting| setting.id == id))
        .unwrap_or(0);
    OverlayState::List(ListOverlay {
        title: "设置".to_owned(),
        origin: OverlayOrigin::User,
        items,
        selected,
        filter,
        status: "Enter 修改，输入筛选，Esc 返回".to_owned(),
    })
}

fn model_overlay(app: &AppState, selected_key: Option<&str>, filter: String) -> OverlayState {
    let current = app
        .snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.model.as_ref());
    let items = app
        .models
        .iter()
        .enumerate()
        .map(|(index, model)| {
            let current_marker = current.is_some_and(|selected| {
                selected.provider == model.provider && selected.id == model.id
            });
            let detail = format!(
                "{}/{}  输入:{}  上下文:{}  推理:{}  {}{}",
                model.provider,
                model.id,
                model.input.join("+"),
                model.context_window,
                if model.reasoning {
                    "支持"
                } else {
                    "不支持"
                },
                if model.configured {
                    "已认证"
                } else {
                    "未认证"
                },
                if current_marker { "  当前" } else { "" },
            );
            OverlayItem {
                label: model.name.clone(),
                detail,
                action: if model.configured {
                    format!("model:{index}")
                } else {
                    "disabled:该模型不可用，Provider 未完成认证".to_owned()
                },
            }
        })
        .collect::<Vec<_>>();
    let selected = selected_key
        .and_then(|key| {
            app.models
                .iter()
                .position(|model| format!("{}/{}", model.provider, model.id) == key)
        })
        .or_else(|| {
            current.and_then(|selected| {
                app.models.iter().position(|model| {
                    model.provider == selected.provider && model.id == selected.id
                })
            })
        })
        .unwrap_or(0);
    OverlayState::List(ListOverlay {
        title: "模型".to_owned(),
        origin: OverlayOrigin::User,
        items,
        selected,
        filter,
        status: "Enter 切换模型，输入筛选，Esc 返回".to_owned(),
    })
}

fn thinking_level_label(level: &str) -> &'static str {
    match level {
        "off" => "关闭",
        "minimal" => "最少",
        "low" => "低",
        "medium" => "中",
        "high" => "高",
        "xhigh" => "极高",
        "max" => "最大",
        _ => "未知",
    }
}

fn thinking_overlay(app: &AppState) -> OverlayState {
    const LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    let current = app
        .snapshot
        .as_ref()
        .map(|snapshot| snapshot.thinking_level.as_str())
        .unwrap_or("off");
    match app.model_supports_reasoning() {
        Ok(model) => OverlayState::List(ListOverlay {
            title: "思考".to_owned(),
            origin: OverlayOrigin::User,
            items: LEVELS
                .into_iter()
                .map(|level| OverlayItem {
                    label: thinking_level_label(level).to_owned(),
                    detail: if level == current {
                        "当前".to_owned()
                    } else {
                        String::new()
                    },
                    action: if model
                        .supported_thinking_levels
                        .iter()
                        .any(|candidate| candidate == level)
                    {
                        format!("thinking:{level}")
                    } else {
                        "disabled:当前模型不支持此思考强度".to_owned()
                    },
                })
                .collect(),
            selected: LEVELS
                .iter()
                .position(|level| *level == current)
                .unwrap_or(0),
            filter: String::new(),
            status: "Enter 保存，Esc 返回".to_owned(),
        }),
        Err(reason) => OverlayState::List(ListOverlay {
            title: "思考".to_owned(),
            origin: OverlayOrigin::User,
            items: vec![OverlayItem {
                label: "当前模型不可用".to_owned(),
                detail: reason.clone(),
                action: format!("disabled:{reason}"),
            }],
            selected: 0,
            filter: String::new(),
            status: "Esc 返回".to_owned(),
        }),
    }
}

fn login_overlay(
    providers: &[ProviderDescriptor],
    selected_key: Option<&str>,
    filter: String,
) -> OverlayState {
    let items = providers
        .iter()
        .enumerate()
        .map(|(index, provider)| OverlayItem {
            label: provider.name.clone(),
            detail: format!(
                "{}  认证:{}  模型:{}{}",
                provider.id,
                if provider.configured {
                    "已配置"
                } else {
                    "未配置"
                },
                provider.model_count,
                if provider.auth_methods.is_empty() {
                    "  无认证方式".to_owned()
                } else {
                    format!("  {}", provider.auth_methods.join("/"))
                },
            ),
            action: if provider.auth_methods.is_empty() {
                "disabled:该 Provider 没有可用认证方式".to_owned()
            } else {
                format!("login-provider:{index}")
            },
        })
        .collect::<Vec<_>>();
    let selected = selected_key
        .and_then(|id| providers.iter().position(|provider| provider.id == id))
        .unwrap_or(0);
    OverlayState::List(ListOverlay {
        title: "登录".to_owned(),
        origin: OverlayOrigin::User,
        items,
        selected,
        filter,
        status: "Enter 选择认证方式，d 退出登录，Esc 返回".to_owned(),
    })
}

fn session_overlay(
    sessions: &[SessionSummary],
    selected_path: Option<&str>,
    origin: OverlayOrigin,
) -> OverlayState {
    let selected = selected_path
        .and_then(|path| sessions.iter().position(|session| session.path == path))
        .unwrap_or(0);
    OverlayState::List(ListOverlay {
        title: "会话".to_owned(),
        origin,
        items: sessions
            .iter()
            .enumerate()
            .map(|(index, session)| OverlayItem {
                label: session
                    .name
                    .clone()
                    .unwrap_or_else(|| session.first_message.clone()),
                detail: format!(
                    "{}  {}  {}",
                    session.path, session.activity, session.updated_at
                ),
                action: format!("session:{index}"),
            })
            .collect(),
        selected,
        filter: String::new(),
        status: "n 新建  Enter 切换  v 只读  r 重命名  d 删除  f 分叉".to_owned(),
    })
}

fn tree_overlay(
    nodes: &[SessionTreeNode],
    selected_key: Option<&str>,
    filter: String,
    tree_filter: TreeFilter,
) -> OverlayState {
    let visible = nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| match tree_filter {
            TreeFilter::Default | TreeFilter::All => true,
            TreeFilter::NoTools => node.kind != "tool",
            TreeFilter::UserOnly => node.kind == "user",
            TreeFilter::LabeledOnly => node.label.is_some(),
        })
        .collect::<Vec<_>>();
    let selected = selected_key
        .and_then(|id| visible.iter().position(|(_, node)| node.id == id))
        .or_else(|| visible.iter().position(|(_, node)| node.is_leaf))
        .unwrap_or(0);
    let mode = match tree_filter {
        TreeFilter::Default => "default",
        TreeFilter::NoTools => "no-tools",
        TreeFilter::UserOnly => "user-only",
        TreeFilter::LabeledOnly => "labeled-only",
        TreeFilter::All => "all",
    };
    OverlayState::List(ListOverlay {
        title: "分支树".to_owned(),
        origin: OverlayOrigin::User,
        items: visible
            .into_iter()
            .map(|(index, node)| OverlayItem {
                label: format!(
                    "{}{} {}",
                    "  ".repeat(node.depth),
                    if node.is_leaf { "*" } else { "-" },
                    node.label.as_deref().unwrap_or(&node.kind)
                ),
                detail: format!("{}  {}", node.timestamp, node.preview),
                action: format!("tree:{index}"),
            })
            .collect(),
        selected,
        filter,
        status: format!(
            "[{mode}] Ctrl+D 默认 Ctrl+T 无工具 Ctrl+U 用户 Ctrl+L 标签 Ctrl+A 全部  Enter 跳转 s 摘要 l 标签 f 分叉"
        ),
    })
}

fn parse_sessions(value: &serde_json::Value) -> Result<Vec<SessionSummary>, TuiError> {
    value
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("会话响应不是列表".to_owned()))?
        .iter()
        .map(|entry| {
            let object = entry
                .as_object()
                .ok_or_else(|| TuiError::InvalidResponse("会话条目无效".to_owned()))?;
            Ok(SessionSummary {
                path: required_string(object, "path")?,
                id: required_string(object, "id")?,
                cwd: required_string(object, "cwd")?,
                name: object
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                updated_at: object
                    .get("updatedAt")
                    .and_then(serde_json::Value::as_u64)
                    .ok_or_else(|| TuiError::InvalidResponse("会话缺少 updatedAt".to_owned()))?,
                first_message: required_string(object, "firstMessage")?,
                activity: required_string(object, "activity")?,
            })
        })
        .collect()
}

fn parse_git_status(value: &serde_json::Value) -> Result<GitStatusDescriptor, TuiError> {
    let object = value
        .as_object()
        .ok_or_else(|| TuiError::InvalidResponse("变更响应无效".to_owned()))?;
    let files = object
        .get("files")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| TuiError::InvalidResponse("变更响应缺少 files".to_owned()))?
        .iter()
        .map(|entry| {
            let entry = entry
                .as_object()
                .ok_or_else(|| TuiError::InvalidResponse("变更条目无效".to_owned()))?;
            Ok::<GitFileDescriptor, TuiError>(GitFileDescriptor {
                path: required_string(entry, "path")?,
                original_path: entry
                    .get("originalPath")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                index_status: required_string(entry, "indexStatus")?,
                worktree_status: required_string(entry, "worktreeStatus")?,
                staged: required_bool(entry, "staged")?,
                unstaged: required_bool(entry, "unstaged")?,
                untracked: required_bool(entry, "untracked")?,
                conflicted: required_bool(entry, "conflicted")?,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(GitStatusDescriptor {
        root: required_string(object, "root")?,
        branch: object
            .get("branch")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        upstream: object
            .get("upstream")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        ahead: required_u64(object, "ahead")?,
        behind: required_u64(object, "behind")?,
        files,
    })
}

fn parse_git_diff(value: &serde_json::Value) -> Result<GitDiffDescriptor, TuiError> {
    let object = value
        .as_object()
        .ok_or_else(|| TuiError::InvalidResponse("Diff 响应无效".to_owned()))?;
    Ok(GitDiffDescriptor {
        path: object
            .get("path")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        staged: required_bool(object, "staged")?,
        diff: required_string(object, "diff")?,
        additions: required_u64(object, "additions")?,
        deletions: required_u64(object, "deletions")?,
    })
}

fn parse_skills(value: &serde_json::Value) -> Result<Vec<SkillDescriptor>, TuiError> {
    value
        .get("skills")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| TuiError::InvalidResponse("技能响应缺少 skills".to_owned()))?
        .iter()
        .map(|entry| {
            let entry = entry
                .as_object()
                .ok_or_else(|| TuiError::InvalidResponse("技能条目无效".to_owned()))?;
            Ok(SkillDescriptor {
                name: required_string(entry, "name")?,
                description: required_string(entry, "description")?,
                path: required_string(entry, "path")?,
                source: required_string(entry, "source")?,
                scope: required_string(entry, "scope")?,
                enabled: required_bool(entry, "enabled")?,
                eligible: required_bool(entry, "eligible")?,
            })
        })
        .collect()
}

fn parse_instructions(value: &serde_json::Value) -> Result<Vec<InstructionDescriptor>, TuiError> {
    value
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("指令响应不是列表".to_owned()))?
        .iter()
        .map(|entry| {
            let entry = entry
                .as_object()
                .ok_or_else(|| TuiError::InvalidResponse("指令条目无效".to_owned()))?;
            Ok(InstructionDescriptor {
                path: required_string(entry, "path")?,
                file_name: required_string(entry, "fileName")?,
                exists: required_bool(entry, "exists")?,
                active: required_bool(entry, "active")?,
                editable: required_bool(entry, "editable")?,
                content: entry
                    .get("content")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                content_hash: entry
                    .get("contentHash")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
            })
        })
        .collect()
}

fn parse_trust(value: &serde_json::Value) -> Result<ProjectTrustDescriptor, TuiError> {
    let object = value
        .as_object()
        .ok_or_else(|| TuiError::InvalidResponse("信任响应无效".to_owned()))?;
    Ok(ProjectTrustDescriptor {
        cwd: required_string(object, "cwd")?,
        trusted: match object.get("trusted") {
            Some(serde_json::Value::Bool(value)) => Some(*value),
            Some(serde_json::Value::Null) => None,
            _ => return Err(TuiError::InvalidResponse("信任状态无效".to_owned())),
        },
        reason: required_string(object, "reason")?,
        resource_risk: required_bool(object, "resourceRisk")?,
    })
}

fn parse_packages(value: &serde_json::Value) -> Result<Vec<PackageDescriptor>, TuiError> {
    value
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("包响应不是列表".to_owned()))?
        .iter()
        .map(|entry| {
            let entry = entry
                .as_object()
                .ok_or_else(|| TuiError::InvalidResponse("包条目无效".to_owned()))?;
            Ok(PackageDescriptor {
                source: required_string(entry, "source")?,
                scope: required_string(entry, "scope")?,
                filtered: required_bool(entry, "filtered")?,
                installed_path: entry
                    .get("installedPath")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
            })
        })
        .collect()
}

fn parse_update(value: &serde_json::Value) -> Result<UpdateDescriptor, TuiError> {
    let object = value
        .as_object()
        .ok_or_else(|| TuiError::InvalidResponse("更新响应无效".to_owned()))?;
    Ok(UpdateDescriptor {
        current_version: required_string(object, "currentVersion")?,
        latest_version: object
            .get("latestVersion")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        status: required_string(object, "status")?,
        url: object
            .get("url")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        note: object
            .get("note")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        install_blocked_reason: required_string(object, "installBlockedReason")?,
    })
}

fn parse_tree(value: &serde_json::Value) -> Result<Vec<SessionTreeNode>, TuiError> {
    value
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("分支树响应不是列表".to_owned()))?
        .iter()
        .map(|entry| {
            let object = entry
                .as_object()
                .ok_or_else(|| TuiError::InvalidResponse("分支树条目无效".to_owned()))?;
            Ok(SessionTreeNode {
                id: required_string(object, "id")?,
                parent_id: object
                    .get("parentId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                kind: required_string(object, "kind")?,
                label: object
                    .get("label")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                timestamp: required_string(object, "timestamp")?,
                preview: required_string(object, "preview")?,
                is_leaf: object
                    .get("isLeaf")
                    .and_then(serde_json::Value::as_bool)
                    .ok_or_else(|| TuiError::InvalidResponse("分支树缺少 isLeaf".to_owned()))?,
                depth: usize::try_from(
                    object
                        .get("depth")
                        .and_then(serde_json::Value::as_u64)
                        .ok_or_else(|| TuiError::InvalidResponse("分支树缺少 depth".to_owned()))?,
                )
                .map_err(|_| TuiError::InvalidResponse("分支树 depth 无效".to_owned()))?,
            })
        })
        .collect()
}

fn readonly_overlay(view: &ReadonlySessionView) -> OverlayState {
    let mut lines = vec![format!("只读  {}", view.path)];
    if view.search.open {
        lines.push(format!("搜索: {}", view.search.query));
        lines.push(view.search.status.clone());
    }
    lines.extend(view.transcript.rounds().iter().flat_map(|round| {
        let mut lines = vec![round.summary()];
        if round.expanded {
            lines.extend(round.detail_lines());
        }
        lines
    }));
    OverlayState::Detail(DetailOverlay {
        title: "会话只读".to_owned(),
        lines,
        scroll: 0,
        status: if view.search.open {
            "Enter 搜索或跳转  Esc 关闭搜索".to_owned()
        } else {
            format!("只读  {}  Ctrl+F 搜索  Esc 返回", view.status)
        },
        link: None,
        copy_text: None,
    })
}

fn parse_settings(value: &serde_json::Value) -> Result<Vec<SettingDescriptor>, TuiError> {
    value
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("设置响应不是列表".to_owned()))?
        .iter()
        .map(|entry| {
            let object = entry
                .as_object()
                .ok_or_else(|| TuiError::InvalidResponse("设置条目无效".to_owned()))?;
            Ok(SettingDescriptor {
                id: required_string(object, "id")?,
                label: required_string(object, "label")?,
                description: object
                    .get("description")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                kind: required_string(object, "kind")?,
                value: object
                    .get("value")
                    .cloned()
                    .ok_or_else(|| TuiError::InvalidResponse("设置缺少 value".to_owned()))?,
                display_value: required_string(object, "displayValue")?,
                options: object
                    .get("options")
                    .and_then(serde_json::Value::as_array)
                    .map(|options| {
                        options
                            .iter()
                            .filter_map(serde_json::Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default(),
                minimum: object.get("minimum").and_then(serde_json::Value::as_i64),
                maximum: object.get("maximum").and_then(serde_json::Value::as_i64),
                scope: required_string(object, "scope")?,
                read_only: object
                    .get("readOnly")
                    .and_then(serde_json::Value::as_bool)
                    .ok_or_else(|| TuiError::InvalidResponse("设置缺少 readOnly".to_owned()))?,
                restart_required: object
                    .get("restartRequired")
                    .and_then(serde_json::Value::as_bool)
                    .ok_or_else(|| {
                        TuiError::InvalidResponse("设置缺少 restartRequired".to_owned())
                    })?,
            })
        })
        .collect()
}

fn parse_models(value: &serde_json::Value) -> Result<Vec<ModelDescriptor>, TuiError> {
    value
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("模型响应不是列表".to_owned()))?
        .iter()
        .map(|entry| {
            let object = entry
                .as_object()
                .ok_or_else(|| TuiError::InvalidResponse("模型条目无效".to_owned()))?;
            Ok(ModelDescriptor {
                provider: required_string(object, "provider")?,
                id: required_string(object, "id")?,
                name: required_string(object, "name")?,
                reasoning: object
                    .get("reasoning")
                    .and_then(serde_json::Value::as_bool)
                    .ok_or_else(|| TuiError::InvalidResponse("模型缺少 reasoning".to_owned()))?,
                input: required_string_array(object, "input")?,
                context_window: object
                    .get("contextWindow")
                    .and_then(serde_json::Value::as_u64)
                    .ok_or_else(|| {
                        TuiError::InvalidResponse("模型缺少 contextWindow".to_owned())
                    })?,
                configured: object
                    .get("authenticated")
                    .and_then(serde_json::Value::as_bool)
                    .ok_or_else(|| {
                        TuiError::InvalidResponse("模型缺少 authenticated".to_owned())
                    })?,
                supported_thinking_levels: required_string_array(
                    object,
                    "supportedThinkingLevels",
                )?,
            })
        })
        .collect()
}

fn parse_providers(value: &serde_json::Value) -> Result<Vec<ProviderDescriptor>, TuiError> {
    value
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("Provider 响应不是列表".to_owned()))?
        .iter()
        .map(|entry| {
            let object = entry
                .as_object()
                .ok_or_else(|| TuiError::InvalidResponse("Provider 条目无效".to_owned()))?;
            Ok(ProviderDescriptor {
                id: required_string(object, "id")?,
                name: required_string(object, "name")?,
                configured: object
                    .get("authenticated")
                    .and_then(serde_json::Value::as_bool)
                    .ok_or_else(|| {
                        TuiError::InvalidResponse("Provider 缺少 authenticated".to_owned())
                    })?,
                auth_methods: required_string_array(object, "authMethods")?,
                auth_source: object
                    .get("authSource")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                model_count: object
                    .get("modelCount")
                    .and_then(serde_json::Value::as_u64)
                    .ok_or_else(|| {
                        TuiError::InvalidResponse("Provider 缺少 modelCount".to_owned())
                    })?,
            })
        })
        .collect()
}

fn parse_subagents(
    value: &serde_json::Value,
    parent_session_path: &str,
) -> Result<Vec<SubagentDescriptor>, TuiError> {
    let snapshots = value
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("Subagent 响应不是列表".to_owned()))?
        .iter()
        .map(|entry| parse_subagent(entry, parent_session_path))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(snapshots)
}

fn parse_subagent(
    value: &serde_json::Value,
    parent_session_path: &str,
) -> Result<SubagentDescriptor, TuiError> {
    let object = value
        .as_object()
        .ok_or_else(|| TuiError::InvalidResponse("Subagent 条目无效".to_owned()))?;
    let session = object.get("session").and_then(serde_json::Value::as_object);
    Ok(SubagentDescriptor {
        parent_session_path: parent_session_path.to_owned(),
        run_id: required_string(object, "runId")?,
        agent_id: required_string(object, "agentId")?,
        name: required_string(object, "agent")?,
        source: required_string(object, "agentSource")?,
        task: required_string(object, "task")?,
        state: required_string(object, "state")?,
        current_action: object
            .get("currentAction")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        started_at: required_u64(object, "startedAt")?,
        updated_at: required_u64(object, "updatedAt")?,
        elapsed_ms: required_u64(object, "elapsedMs")?,
        controllable: required_bool(object, "controllable")?,
        session_file: session
            .and_then(|value| value.get("sessionFile"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        session_cwd: session
            .and_then(|value| value.get("cwd"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
    })
}

fn parse_clipboard(value: &serde_json::Value) -> Result<ClipboardDescriptor, TuiError> {
    let object = value
        .as_object()
        .ok_or_else(|| TuiError::InvalidResponse("剪贴板响应无效".to_owned()))?;
    Ok(ClipboardDescriptor {
        capability: required_bool(object, "capability")?,
        text: object
            .get("text")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
    })
}

fn required_string(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<String, TuiError> {
    object
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| TuiError::InvalidResponse(format!("响应缺少 {key}")))
}

fn required_bool(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<bool, TuiError> {
    object
        .get(key)
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| TuiError::InvalidResponse(format!("响应缺少 {key}")))
}

fn required_u64(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<u64, TuiError> {
    object
        .get(key)
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| TuiError::InvalidResponse(format!("响应缺少 {key}")))
}

fn required_string_array(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<Vec<String>, TuiError> {
    object
        .get(key)
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|value| {
                    value.as_str().map(str::to_owned).ok_or_else(|| {
                        TuiError::InvalidResponse(format!("响应 {key} 包含非字符串"))
                    })
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .ok_or_else(|| TuiError::InvalidResponse(format!("响应缺少 {key}")))?
}

fn ui_select_items(payload: &serde_json::Value) -> Vec<OverlayItem> {
    let options = payload
        .get("options")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let items = options
        .into_iter()
        .filter_map(|option| {
            let value = option
                .get("value")
                .and_then(serde_json::Value::as_str)
                .or_else(|| option.get("id").and_then(serde_json::Value::as_str))
                .or_else(|| option.as_str())?;
            let label = option
                .get("label")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(value);
            let detail = option
                .get("description")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            Some(OverlayItem {
                label: label.to_owned(),
                detail: detail.to_owned(),
                action: format!("ui:select:{value}"),
            })
        })
        .collect::<Vec<_>>();
    if items.is_empty() {
        vec![OverlayItem {
            label: "无可选项".to_owned(),
            detail: String::new(),
            action: "ui:select:".to_owned(),
        }]
    } else {
        items
    }
}

fn pretty_json_lines(value: &serde_json::Value) -> Vec<String> {
    serde_json::to_string_pretty(value)
        .unwrap_or_else(|_| "无法格式化结果".to_owned())
        .lines()
        .map(str::to_owned)
        .collect()
}

fn apply_response(app: &mut AppState, response: &ReadOnlyResponse) -> Result<bool, TuiError> {
    match response {
        ReadOnlyResponse::Error { id, message } => {
            let Some(pending) = app.take_transcript_request(id) else {
                return Ok(false);
            };
            match pending.view {
                TranscriptViewKind::Active
                    if pending.generation == app.session_generation
                        && app.active_session_path() == Some(pending.session_path.as_str()) =>
                {
                    app.clear_page_load_pending();
                    app.transcript.status = message.clone();
                    app.transcript.loading_previous = false;
                }
                TranscriptViewKind::Readonly => {
                    if let Some(view) = app.readonly_view.as_mut()
                        && view.path == pending.session_path
                        && view.generation == pending.generation
                    {
                        view.status = message.clone();
                        view.transcript.status = message.clone();
                        view.transcript.loading_previous = false;
                        refresh_readonly_overlay(app);
                    }
                }
                _ => {}
            }
        }
        ReadOnlyResponse::TranscriptPage { id, page } => {
            let Some(pending) = app.take_transcript_request(id) else {
                return Ok(false);
            };
            if !matches!(
                pending.kind,
                TranscriptRequestKind::Initial | TranscriptRequestKind::Older
            ) {
                return Ok(false);
            }
            match pending.view {
                TranscriptViewKind::Active
                    if pending.generation == app.session_generation
                        && app.active_session_path() == Some(pending.session_path.as_str()) =>
                {
                    trace_id("page_apply_start", id);
                    if !page.complete {
                        app.clear_for_reload("记录页未完整返回，正在重新读取");
                        trace("reload_requested");
                        trace_id("page_apply_end", id);
                        return Ok(true);
                    }
                    if pending.kind == TranscriptRequestKind::Initial {
                        app.clear_page_load_pending();
                        app.transcript.replace_page(
                            page.items.clone(),
                            page.transcript_generation.clone(),
                            page.transcript_revision,
                            page.previous_cursor.clone(),
                        );
                    } else if app.transcript.accepts_previous_page(
                        &page.transcript_generation,
                        page.transcript_revision,
                        pending
                            .context
                            .as_ref()
                            .and_then(|value| value.generation.as_deref()),
                        pending.context.as_ref().and_then(|value| value.revision),
                    ) {
                        app.clear_page_load_pending();
                        app.transcript
                            .prepend_page(page.items.clone(), page.previous_cursor.clone());
                        app.resolve_pending_jump();
                    } else {
                        app.clear_for_reload("更早记录已过期，正在重新读取");
                        trace("reload_requested");
                        trace_id("page_apply_end", id);
                        return Ok(true);
                    }
                    trace_id("page_apply_end", id);
                    trace("page_applied");
                }
                TranscriptViewKind::Readonly => {
                    trace_id("page_apply_start", id);
                    let Some(view) = app.readonly_view.as_mut() else {
                        return Ok(false);
                    };
                    if view.path != pending.session_path || view.generation != pending.generation {
                        return Ok(false);
                    }
                    if !page.complete {
                        view.transcript.clear_for_reload("记录页未完整返回");
                    } else if pending.kind == TranscriptRequestKind::Initial {
                        view.transcript.replace_page(
                            page.items.clone(),
                            page.transcript_generation.clone(),
                            page.transcript_revision,
                            page.previous_cursor.clone(),
                        );
                    } else if view.transcript.accepts_previous_page(
                        &page.transcript_generation,
                        page.transcript_revision,
                        pending
                            .context
                            .as_ref()
                            .and_then(|value| value.generation.as_deref()),
                        pending.context.as_ref().and_then(|value| value.revision),
                    ) {
                        view.transcript
                            .prepend_page(page.items.clone(), page.previous_cursor.clone());
                        if let Some(entry_id) = view.search.pending_jump.clone()
                            && view.transcript.jump_to(&entry_id)
                        {
                            view.search.pending_jump = None;
                            view.search.status = "已跳转".to_owned();
                        }
                    } else {
                        view.transcript.clear_for_reload("更早记录已过期");
                    }
                    view.status = format!("{} 轮", view.transcript.cached_rounds());
                    refresh_readonly_overlay(app);
                    trace_id("page_apply_end", id);
                    trace("page_applied");
                }
                _ => {}
            }
        }
        ReadOnlyResponse::SearchResult { id, result } => {
            let Some(pending) = app.take_transcript_request(id) else {
                return Ok(false);
            };
            if pending.kind != TranscriptRequestKind::Search {
                return Ok(false);
            }
            let hits = result
                .hits
                .iter()
                .map(|hit| SearchHit {
                    entry_id: hit.entry_id.clone(),
                    kind: hit.kind.clone(),
                    timestamp: hit.timestamp.clone(),
                    snippet: hit.snippet.clone(),
                })
                .collect();
            match pending.view {
                TranscriptViewKind::Active
                    if pending.generation == app.session_generation
                        && app.active_session_path() == Some(pending.session_path.as_str()) =>
                {
                    app.set_search_results(hits);
                    trace("search_applied");
                }
                TranscriptViewKind::Readonly => {
                    if let Some(view) = app.readonly_view.as_mut()
                        && view.path == pending.session_path
                        && view.generation == pending.generation
                    {
                        view.search.selected = 0;
                        view.search.hits = hits;
                        view.search.status = format!("{} 个结果", view.search.hits.len());
                        refresh_readonly_overlay(app);
                        trace("search_applied");
                    }
                }
                _ => {}
            }
        }
        ReadOnlyResponse::Operation {
            operation,
            duplicate,
            ..
        } => {
            app.apply_operation(operation.clone());
            if *duplicate {
                app.transcript.status = "已确认已有请求".to_owned();
            }
        }
        ReadOnlyResponse::SessionLease { .. } | ReadOnlyResponse::Other { .. } => {}
    }
    Ok(false)
}

fn apply_event(
    app: &mut AppState,
    event: &ReadOnlyEvent,
    session_path: &str,
) -> Result<bool, TuiError> {
    match event {
        ReadOnlyEvent::TranscriptChanged {
            session_path: event_path,
        } if event_path == session_path => {
            trace("transcript_changed");
            app.clear_for_reload("记录已重写，正在重新读取");
            trace("reload_requested");
            Ok(true)
        }
        ReadOnlyEvent::TranscriptCommitted {
            session_path: event_path,
            transcript_generation,
            from_revision,
            to_revision,
            items,
        } if event_path == session_path => {
            trace("transcript_committed");
            if !app.transcript.append_committed(
                transcript_generation,
                *from_revision,
                *to_revision,
                items.clone(),
            ) {
                app.clear_for_reload("记录版本不连续，正在重新读取");
                trace("reload_requested");
                return Ok(true);
            }
            app.invalidate_rich_text();
            app.invalidate_images();
            app.clear_live_after_commit(items);
            app.transcript.streaming_preview = None;
            trace("append_applied");
            Ok(false)
        }
        ReadOnlyEvent::SessionProgress {
            session_path: event_path,
            progress,
        } if event_path == session_path => {
            app.apply_progress(progress.clone());
            Ok(false)
        }
        ReadOnlyEvent::SessionSnapshot { snapshot } if snapshot.path == session_path => {
            app.apply_snapshot(snapshot.clone());
            Ok(false)
        }
        ReadOnlyEvent::OperationUpdated { operation } if operation.session_path == session_path => {
            app.apply_operation(operation.clone());
            Ok(false)
        }
        ReadOnlyEvent::TranscriptChanged { .. }
        | ReadOnlyEvent::TranscriptCommitted { .. }
        | ReadOnlyEvent::SessionProgress { .. }
        | ReadOnlyEvent::SessionSnapshot { .. }
        | ReadOnlyEvent::OperationUpdated { .. }
        | ReadOnlyEvent::Other => Ok(false),
    }
}

pub fn run_shell(wait_for_child_eof: bool, panic_after_enter: bool) -> Result<(), TuiError> {
    run_shell_with_mode(
        wait_for_child_eof,
        panic_after_enter,
        TerminalMode::Fullscreen,
    )
}

pub fn run_shell_with_mode(
    wait_for_child_eof: bool,
    panic_after_enter: bool,
    mode: TerminalMode,
) -> Result<(), TuiError> {
    let shutdown = Arc::new(AtomicBool::new(false));
    flag::register(SIGINT, Arc::clone(&shutdown))?;
    flag::register(SIGTERM, Arc::clone(&shutdown))?;
    let _terminal = TerminalGuard::enter(mode)?;
    if panic_after_enter {
        panic!("terminal guard panic probe");
    }
    if wait_for_child_eof {
        return wait_for_protocol_eof(&shutdown);
    }
    while !shutdown.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

#[cfg(unix)]
fn wait_for_protocol_eof(shutdown: &AtomicBool) -> Result<(), TuiError> {
    use std::{fs::File, os::fd::FromRawFd};

    let mut input = unsafe { File::from_raw_fd(3) };
    let mut buffer = [0_u8; 1];
    while !shutdown.load(Ordering::Relaxed) {
        if input.read(&mut buffer)? == 0 {
            return Err(TuiError::ChildEof);
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn wait_for_protocol_eof(_shutdown: &AtomicBool) -> Result<(), TuiError> {
    Err(TuiError::HelloRejected(
        "Windows named-pipe transport is not implemented".to_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str) -> lystar_protocol::TranscriptItem {
        lystar_protocol::TranscriptItem {
            entry_id: id.to_owned(),
            timestamp: String::new(),
            view: lystar_protocol::TranscriptViewItem::User {
                text: id.to_owned(),
                images: None,
            },
        }
    }

    fn page(
        items: Vec<lystar_protocol::TranscriptItem>,
        cursor: Option<&str>,
    ) -> lystar_protocol::TranscriptPage {
        lystar_protocol::TranscriptPage {
            items,
            previous_cursor: cursor.map(str::to_owned),
            has_more_previous: cursor.is_some(),
            transcript_generation: "g1".to_owned(),
            transcript_revision: 1,
            complete: true,
            request_context: None,
        }
    }

    fn snapshot_value(path: &str) -> serde_json::Value {
        serde_json::json!({
            "id": "session", "path": path, "cwd": "/tmp", "phase": "idle", "activity": "idle",
            "thinkingLevel": "off", "attached": false, "writeAccess": "owned", "revision": 1,
            "queuedSteerCount": 0, "queuedFollowUpCount": 0, "transcriptGeneration": "g1",
            "transcriptRevision": 1, "model": null
        })
    }

    fn test_pipe() -> ProtocolPipe {
        test_pipe_with_path().0
    }

    fn test_pipe_with_path() -> (ProtocolPipe, PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "lystar-tui-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let output = std::fs::File::create(&path).unwrap();
        let (_sender, inbound) = mpsc::sync_channel(1);
        (ProtocolPipe { output, inbound }, path)
    }

    #[test]
    fn app_interrupt_sends_one_abort_for_an_active_leased_operation() {
        let mut app = AppState::default();
        app.begin_active_session("/tmp/current.jsonl".to_owned(), "/tmp".to_owned());
        app.lease_id = Some("lease".to_owned());
        app.input_focus = InputFocus::Overlay;
        app.operation = Some(lystar_protocol::OperationSnapshot {
            operation_id: "operation-1".to_owned(),
            client_instance_id: "client".to_owned(),
            client_request_id: "request".to_owned(),
            session_path: "/tmp/current.jsonl".to_owned(),
            operation_type: "prompt".to_owned(),
            status: "running".to_owned(),
            progress: None,
            error: None,
        });
        let (mut pipe, path) = test_pipe_with_path();
        let mut sequence = 0;
        let mut session_flow = None;
        let mut quit_requested = false;

        apply_extension_editor_app_action(
            &mut app,
            "app.interrupt",
            &mut pipe,
            "/tmp/current.jsonl",
            "client",
            &mut sequence,
            &mut session_flow,
            &mut quit_requested,
        )
        .unwrap();
        apply_extension_editor_app_action(
            &mut app,
            "app.interrupt",
            &mut pipe,
            "/tmp/current.jsonl",
            "client",
            &mut sequence,
            &mut session_flow,
            &mut quit_requested,
        )
        .unwrap();
        drop(pipe);

        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(
            bytes
                .windows(b"abort_operation".len())
                .filter(|window| *window == b"abort_operation")
                .count(),
            1
        );
        assert_eq!(
            app.operation
                .as_ref()
                .map(|operation| operation.status.as_str()),
            Some("aborting")
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn app_interrupt_skips_missing_lease_and_terminal_operations() {
        for (lease_id, status) in [(None, "running"), (Some("lease".to_owned()), "aborted")] {
            let mut app = AppState::default();
            app.begin_active_session("/tmp/current.jsonl".to_owned(), "/tmp".to_owned());
            app.lease_id = lease_id;
            app.operation = Some(lystar_protocol::OperationSnapshot {
                operation_id: "operation-1".to_owned(),
                client_instance_id: "client".to_owned(),
                client_request_id: "request".to_owned(),
                session_path: "/tmp/current.jsonl".to_owned(),
                operation_type: "prompt".to_owned(),
                status: status.to_owned(),
                progress: None,
                error: None,
            });
            let (mut pipe, path) = test_pipe_with_path();
            let mut sequence = 0;
            let mut session_flow = None;
            let mut quit_requested = false;
            apply_extension_editor_app_action(
                &mut app,
                "app.interrupt",
                &mut pipe,
                "/tmp/current.jsonl",
                "client",
                &mut sequence,
                &mut session_flow,
                &mut quit_requested,
            )
            .unwrap();
            drop(pipe);
            assert!(
                !std::fs::read(&path)
                    .unwrap()
                    .windows(b"abort_operation".len())
                    .any(|window| window == b"abort_operation")
            );
            std::fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn preserves_custom_editor_alt_enter_and_control_sequences() {
        assert_eq!(
            raw_key(KeyCode::Enter, KeyModifiers::ALT),
            Some("\x1b\r".to_owned())
        );
        assert_eq!(
            raw_key(KeyCode::Char('d'), KeyModifiers::CONTROL),
            Some("\x04".to_owned())
        );
    }

    #[test]
    fn resolves_auto_mode_from_environment_and_terminal_capability() {
        let regular = TerminalModeContext {
            stdout_tty: true,
            stdin_tty: true,
            term: Some("dumb".to_owned()),
            env_mode: None,
        };
        assert_eq!(
            resolve_terminal_mode(TerminalMode::Auto, regular),
            TerminalMode::Regular
        );
        let fullscreen = TerminalModeContext {
            stdout_tty: true,
            stdin_tty: true,
            term: Some("xterm-256color".to_owned()),
            env_mode: None,
        };
        assert_eq!(
            resolve_terminal_mode(TerminalMode::Auto, fullscreen),
            TerminalMode::Fullscreen
        );
        let env_regular = TerminalModeContext {
            stdout_tty: true,
            stdin_tty: true,
            term: Some("xterm-256color".to_owned()),
            env_mode: Some(TerminalMode::Regular),
        };
        assert_eq!(
            resolve_terminal_mode(TerminalMode::Auto, env_regular),
            TerminalMode::Regular
        );
        assert_eq!(inline_viewport_height(8), 8);
        assert_eq!(inline_viewport_height(60), 24);
    }

    #[test]
    fn resume_hint_quotes_shell_paths_and_transcript_projection_keeps_metadata() {
        let mut hint = Vec::new();
        write_resume_hint(&mut hint, "/tmp/a'b.jsonl", None).unwrap();
        assert_eq!(
            String::from_utf8(hint).unwrap(),
            "会话已保存，可使用以下命令恢复：\nlc -r '/tmp/a'\"'\"'b.jsonl'\n"
        );
        let projected = transcript_plain_text(&lystar_protocol::TranscriptItem {
            entry_id: "tool-result".to_owned(),
            timestamp: "2026-08-16T00:00:00Z".to_owned(),
            view: TranscriptViewItem::ToolResult {
                call_id: "call-1".to_owned(),
                name: "apply_patch".to_owned(),
                status: "success".to_owned(),
                summary: "更新文件".to_owned(),
                detail: Some("diff --git a/a b/a".to_owned()),
                content_ref: Some("content_ref://tool/1".to_owned()),
                images: Some(vec![lystar_protocol::TranscriptImage {
                    content_ref: "content_ref://image/1".to_owned(),
                    mime_type: "image/png".to_owned(),
                    byte_length: 42,
                    alt: Some("预览".to_owned()),
                }]),
            },
        });
        assert!(projected.contains("diff --git"));
        assert!(projected.contains("contentRef: content_ref://tool/1"));
        assert!(projected.contains("图片 image/png 42B contentRef:content_ref://image/1 alt:预览"));
    }

    #[test]
    fn restores_raw_mode_when_entering_the_screen_fails() {
        let restored = Arc::new(AtomicBool::new(false));
        let restore = Arc::clone(&restored);
        let error = enter_terminal(
            || Ok(()),
            || Err(io::Error::other("screen failed")),
            || {
                restore.store(true, Ordering::Relaxed);
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert!(restored.load(Ordering::Relaxed));
    }

    #[test]
    fn writes_osc8_at_the_rendered_label_without_changing_its_width() {
        let region = VisibleLink {
            column: 7,
            row: 3,
            label: "example.rs".to_owned(),
            href: "file:///tmp/example.rs".to_owned(),
        };
        let mut writer = Vec::new();
        write_visible_osc8_link(&mut writer, &region).unwrap();
        let output = String::from_utf8(writer).unwrap();
        assert!(output.starts_with("\x1b[4;8H"));
        assert!(output.contains("\x1b]8;;file:///tmp/example.rs\x1b\\example.rs\x1b]8;;\x1b\\"));
        assert!(!output.contains(">example.rs"));
    }

    #[test]
    fn emits_real_osc8_only_for_linked_text() {
        let linked = osc8_link("file:///tmp/example.rs", "example.rs");
        assert!(linked.contains("\x1b]8;;file:///tmp/example.rs\x1b\\example.rs\x1b]8;;\x1b\\"));
        assert!(!"ordinary text".contains("\x1b]8;;"));
    }

    #[test]
    fn rejects_control_injection_in_osc8_and_clears_extension_titles() {
        assert_eq!(osc8_link("https://example.test/\u{1b}]0;bad", "label"), "");
        assert_eq!(
            osc8_link("https://example.test/path", "label\u{1b}]0;bad\u{7}"),
            "\x1b]8;;https://example.test/path\x1b\\label]0;bad\x1b]8;;\x1b\\"
        );
        assert_eq!(
            extension_title_osc(Some("title\u{1b}]0;bad\u{7}")),
            "\x1b]0;title]0;bad\x07"
        );
        assert_eq!(extension_title_osc(None), "\x1b]0;\x07");
    }

    #[test]
    fn intercepts_only_connected_slash_commands() {
        for (input, target) in [
            ("/help", "help"),
            (" /about ", "about"),
            ("/doctor", "doctor"),
            ("/settings", "settings"),
            ("/model", "model"),
            ("/thinking", "thinking"),
            ("/login", "login"),
        ] {
            assert_eq!(builtin_slash_command(input), Some(target));
        }
        assert_eq!(builtin_slash_command("/about later"), None);
        assert_eq!(builtin_slash_command("/settings-now"), None);
    }

    #[test]
    fn builds_select_items_from_host_payload() {
        let items = ui_select_items(&serde_json::json!({
            "options": [
                {"id":"region-cn", "label":"中国", "description":"中国大陆节点"},
                {"label":"Beta", "value":"beta"},
                "alpha"
            ]
        }));
        assert_eq!(items[0].label, "中国");
        assert_eq!(items[0].detail, "中国大陆节点");
        assert_eq!(items[0].action, "ui:select:region-cn");
        assert_eq!(items[1].action, "ui:select:beta");
        assert_eq!(items[2].action, "ui:select:alpha");
    }

    #[test]
    fn applies_readonly_pages_search_and_rejects_stale_responses() {
        let mut app = AppState::default();
        app.readonly_view = Some(ReadonlySessionView {
            path: "/tmp/readonly.jsonl".to_owned(),
            generation: 7,
            ..ReadonlySessionView::default()
        });
        app.open_overlay(readonly_overlay(app.readonly_view.as_ref().unwrap()));
        app.begin_transcript_request(
            "readonly-initial".to_owned(),
            TranscriptViewKind::Readonly,
            TranscriptRequestKind::Initial,
            "/tmp/readonly.jsonl".to_owned(),
            7,
            None,
        );
        apply_response(
            &mut app,
            &ReadOnlyResponse::TranscriptPage {
                id: "readonly-initial".to_owned(),
                page: page(vec![item("tail")], Some("older")),
            },
        )
        .unwrap();
        assert_eq!(
            app.readonly_view
                .as_ref()
                .unwrap()
                .transcript
                .cached_rounds(),
            1
        );

        let context = TranscriptRequestContext {
            generation: Some("g1".to_owned()),
            revision: Some(1),
            cursor: Some("older".to_owned()),
        };
        app.begin_transcript_request(
            "readonly-older".to_owned(),
            TranscriptViewKind::Readonly,
            TranscriptRequestKind::Older,
            "/tmp/readonly.jsonl".to_owned(),
            7,
            Some(context),
        );
        apply_response(
            &mut app,
            &ReadOnlyResponse::TranscriptPage {
                id: "readonly-older".to_owned(),
                page: page(vec![item("older")], None),
            },
        )
        .unwrap();
        assert_eq!(
            app.readonly_view
                .as_ref()
                .unwrap()
                .transcript
                .cached_rounds(),
            2
        );

        app.begin_transcript_request(
            "readonly-search".to_owned(),
            TranscriptViewKind::Readonly,
            TranscriptRequestKind::Search,
            "/tmp/readonly.jsonl".to_owned(),
            7,
            None,
        );
        apply_response(
            &mut app,
            &ReadOnlyResponse::SearchResult {
                id: "readonly-search".to_owned(),
                result: lystar_protocol::TranscriptSearchResult {
                    generation: "g1".to_owned(),
                    transcript_revision: 1,
                    complete: true,
                    hits: vec![lystar_protocol::TranscriptSearchHit {
                        entry_id: "tail".to_owned(),
                        kind: "user".to_owned(),
                        timestamp: String::new(),
                        snippet: "tail".to_owned(),
                    }],
                    next_cursor: None,
                },
            },
        )
        .unwrap();
        assert_eq!(app.readonly_view.as_ref().unwrap().search.hits.len(), 1);

        app.begin_transcript_request(
            "readonly-stale".to_owned(),
            TranscriptViewKind::Readonly,
            TranscriptRequestKind::Initial,
            "/tmp/readonly.jsonl".to_owned(),
            6,
            None,
        );
        apply_response(
            &mut app,
            &ReadOnlyResponse::TranscriptPage {
                id: "readonly-stale".to_owned(),
                page: page(vec![item("stale")], None),
            },
        )
        .unwrap();
        assert_eq!(
            app.readonly_view
                .as_ref()
                .unwrap()
                .transcript
                .cached_rounds(),
            2
        );
    }

    #[test]
    fn keeps_active_events_running_behind_readonly_view() {
        let mut app = AppState::default();
        app.begin_active_session("/tmp/active.jsonl".to_owned(), "/tmp".to_owned());
        app.transcript
            .replace_page(vec![item("before")], "g1".to_owned(), 1, None);
        app.readonly_view = Some(ReadonlySessionView {
            path: "/tmp/readonly.jsonl".to_owned(),
            generation: 1,
            ..ReadonlySessionView::default()
        });
        apply_event(
            &mut app,
            &ReadOnlyEvent::SessionProgress {
                session_path: "/tmp/active.jsonl".to_owned(),
                progress: lystar_protocol::SessionProgress::AssistantDelta {
                    text: "running".to_owned(),
                },
            },
            "/tmp/active.jsonl",
        )
        .unwrap();
        apply_event(
            &mut app,
            &ReadOnlyEvent::TranscriptCommitted {
                session_path: "/tmp/active.jsonl".to_owned(),
                transcript_generation: "g1".to_owned(),
                from_revision: 1,
                to_revision: 2,
                items: vec![item("after")],
            },
            "/tmp/active.jsonl",
        )
        .unwrap();
        assert_eq!(app.assistant_stream, "");
        assert_eq!(app.transcript.cached_rounds(), 2);
        assert_eq!(
            app.readonly_view
                .as_ref()
                .unwrap()
                .transcript
                .cached_rounds(),
            0
        );
    }

    #[test]
    fn session_transitions_clear_released_leases_and_reject_stale_acquires() {
        let mut app = AppState::default();
        app.begin_active_session("/tmp/old.jsonl".to_owned(), "/tmp".to_owned());
        let old_snapshot = serde_json::from_value(snapshot_value("/tmp/old.jsonl")).unwrap();
        app.apply_active_lease("old-lease".to_owned(), old_snapshot);
        let restore = app.restore_point();
        let target = SessionSummary {
            path: "/tmp/new.jsonl".to_owned(),
            id: "new".to_owned(),
            cwd: "/tmp".to_owned(),
            name: None,
            updated_at: 1,
            first_message: "new".to_owned(),
            activity: "idle".to_owned(),
        };
        let mut pipe = test_pipe();
        let mut sequence = 10;
        let mut quit = false;
        let mut flow = Some(SessionFlow::SwitchReleasing {
            id: "release".to_owned(),
            target: target.clone(),
            restore: restore.clone(),
        });
        apply_session_flow(
            &mut app,
            &serde_json::json!({"id":"release","ok":true,"result":{}}),
            &mut pipe,
            "client",
            &mut sequence,
            &mut flow,
            &mut quit,
        )
        .unwrap();
        assert!(app.lease_id.is_none());
        assert!(app.active_session.as_ref().unwrap().lease_id.is_none());

        let mut flow = Some(SessionFlow::SwitchAcquiring {
            id: "acquire".to_owned(),
            target: target.clone(),
            restore: restore.clone(),
        });
        apply_session_flow(&mut app, &serde_json::json!({"id":"acquire","ok":true,"result":{"lease":{"leaseId":"new-lease"},"snapshot":snapshot_value("/tmp/new.jsonl")}}), &mut pipe, "client", &mut sequence, &mut flow, &mut quit).unwrap();
        assert_eq!(app.active_session_path(), Some("/tmp/new.jsonl"));
        assert_eq!(app.lease_id.as_deref(), Some("new-lease"));

        let mut flow = Some(SessionFlow::SwitchRollback {
            id: "rollback".to_owned(),
            restore: restore.clone(),
            reason: "target failed".to_owned(),
        });
        apply_session_flow(
            &mut app,
            &serde_json::json!({"id":"rollback","ok":false,"error":{"message":"old failed"}}),
            &mut pipe,
            "client",
            &mut sequence,
            &mut flow,
            &mut quit,
        )
        .unwrap();
        assert!(app.active_session.is_none());
        assert!(app.lease_id.is_none());

        app.begin_active_session("/tmp/delete.jsonl".to_owned(), "/tmp".to_owned());
        let mut flow = Some(SessionFlow::DeleteRemoving {
            id: "delete".to_owned(),
            restore,
            target: None,
        });
        apply_session_flow(
            &mut app,
            &serde_json::json!({"id":"delete","ok":true,"result":{}}),
            &mut pipe,
            "client",
            &mut sequence,
            &mut flow,
            &mut quit,
        )
        .unwrap();
        assert!(app.active_session.is_none());

        app.begin_active_session("/tmp/initial.jsonl".to_owned(), "/tmp".to_owned());
        let generation = app.session_generation;
        let mut flow = Some(SessionFlow::InitialAcquiring {
            id: "expected".to_owned(),
            path: "/tmp/initial.jsonl".to_owned(),
            generation,
        });
        let outcome = apply_session_flow(&mut app, &serde_json::json!({"id":"stale","ok":true,"result":{"lease":{"leaseId":"stale"},"snapshot":snapshot_value("/tmp/initial.jsonl")}}), &mut pipe, "client", &mut sequence, &mut flow, &mut quit).unwrap();
        assert!(outcome.is_none());
        assert!(app.lease_id.is_none());

        quit = true;
        let mut flow = Some(SessionFlow::SwitchAcquiring {
            id: "quit-acquire".to_owned(),
            target,
            restore: app.restore_point(),
        });
        apply_session_flow(&mut app, &serde_json::json!({"id":"quit-acquire","ok":true,"result":{"lease":{"leaseId":"quit-lease"},"snapshot":snapshot_value("/tmp/new.jsonl")}}), &mut pipe, "client", &mut sequence, &mut flow, &mut quit).unwrap();
        assert!(matches!(flow, Some(SessionFlow::QuitReleasing { .. })));
        assert!(app.lease_id.is_none());
    }

    #[test]
    fn reads_accepted_queue_operation_id_from_host_response() {
        assert_eq!(
            queue_operation_id(&serde_json::json!({"result":{"operationId":"operation-1"}})),
            Some("operation-1")
        );
        assert_eq!(
            queue_operation_id(
                &serde_json::json!({"result":{"operation":{"operationId":"operation-2"}}})
            ),
            Some("operation-2")
        );
        assert_eq!(queue_operation_id(&serde_json::json!({"result":{}})), None);
    }

    #[test]
    fn renders_bounded_auth_notifications_with_copy_and_osc8_link() {
        let detail = ui_notify_detail(
            "模型认证",
            &serde_json::json!({
                "method":"auth_device_code",
                "userCode":"ABCD-EFGH",
                "verificationUri":"https://example.test/device",
                "intervalSeconds":5,
                "expiresInSeconds":600
            }),
        );
        assert_eq!(detail.copy_text.as_deref(), Some("ABCD-EFGH"));
        assert_eq!(
            detail.link.as_ref().map(|link| link.href.as_str()),
            Some("https://example.test/device")
        );
        assert!(detail.status.contains('c'));
    }
}
