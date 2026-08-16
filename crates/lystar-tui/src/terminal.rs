use std::{
    io::{self, Read, Write},
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
        self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind, KeyModifiers,
        MouseEventKind,
    },
    execute, queue,
    style::Print,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use lystar_protocol::{
    B3Command, FrameDecoder, ProtocolError, ReadOnlyEvent, ReadOnlyMessage, ReadOnlyResponse,
    ServerMessage, TranscriptRequestContext, decode_server_message, encode_abort_operation_request,
    encode_acquire_session_request, encode_b3_request, encode_client_hello, encode_queue_request,
    encode_read_transcript_request, encode_search_transcript_request, encode_ui_response,
};
use ratatui::{Terminal, backend::CrosstermBackend};
use signal_hook::{
    consts::signal::{SIGINT, SIGTERM},
    flag,
};
use thiserror::Error;

use crate::app::{
    AppState, B3Request, ComposerView, ConfirmOverlay, DetailOverlay, InputFocus, ListOverlay,
    ModelDescriptor, OverlayItem, OverlayLink, OverlayState, PendingIntent, ProviderDescriptor,
    SearchHit, SettingDescriptor, TextEditorOverlay, TranscriptView, UiRequest, UiRequestKind,
    VisibleLink, WorkbenchOverlayView, WorkbenchTarget, composer_area, transcript_area,
};

const INITIAL_PAGE_LIMIT: u64 = 200;
const PAGE_LIMIT: u64 = 200;
const SEARCH_LIMIT: u64 = 50;

#[derive(Debug, Error)]
pub enum TuiError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error("host closed the protocol pipe before hello")]
    ChildEof,
    #[error("host rejected the Rust frontend: {0}")]
    HelloRejected(String),
    #[error("host protocol response is malformed: {0}")]
    InvalidResponse(String),
}

pub struct TerminalGuard {
    active: bool,
}

impl TerminalGuard {
    pub fn enter() -> Result<Self, io::Error> {
        enter_terminal(
            enable_raw_mode,
            || {
                let mut stdout = io::stdout();
                execute!(stdout, EnterAlternateScreen, EnableMouseCapture, Hide)
            },
            disable_raw_mode,
        )?;
        Ok(Self { active: true })
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let mut stdout = io::stdout();
        let _ = execute!(stdout, DisableMouseCapture, Show, LeaveAlternateScreen);
        let _ = disable_raw_mode();
        self.active = false;
    }
}

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

fn monotonic_millis() -> u128 {
    #[cfg(target_os = "linux")]
    {
        if let Some(seconds) = std::fs::read_to_string("/proc/uptime")
            .ok()
            .and_then(|uptime| uptime.split_whitespace().next()?.parse::<f64>().ok())
        {
            return (seconds * 1_000.0) as u128;
        }
    }
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis()
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

fn osc8_link(href: &str, text: &str) -> String {
    let href = href.replace(['\u{1b}', '\u{7}'], "");
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
    let shutdown = Arc::new(AtomicBool::new(false));
    flag::register(SIGINT, Arc::clone(&shutdown))?;
    flag::register(SIGTERM, Arc::clone(&shutdown))?;
    let client_instance_id = std::env::var("PI_RUST_TUI_CLIENT_INSTANCE_ID")
        .unwrap_or_else(|_| format!("lystar-rust-m8-{}", std::process::id()));
    let mut pipe = ProtocolPipe::connect(&client_instance_id)?;
    let mut request_sequence = 0_u64;
    request_acquire(
        &mut pipe,
        session_path,
        &client_instance_id,
        &mut request_sequence,
    )?;
    request_transcript(
        &mut pipe,
        session_path,
        None,
        true,
        None,
        &mut request_sequence,
    )?;

    let _terminal_guard = TerminalGuard::enter()?;
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::new(backend)?;
    trace("terminal_ready");
    let mut app = AppState::default();
    app.mark_page_load_pending();
    let mut dirty = true;
    let mut timeout_notified = false;
    loop {
        if dirty {
            let area = terminal.size()?;
            let full = ratatui::layout::Rect::new(0, 0, area.width, area.height);
            app.prepare_composer(composer_area(&app, full));
            trace("draw_start");
            terminal.draw(|frame| {
                let area = frame.area();
                frame.render_widget(TranscriptView::new(&app), transcript_area(&app, area));
                frame.render_widget(ComposerView::new(&app), composer_area(&app, area));
                frame.render_widget(WorkbenchOverlayView::new(&app), area);
            })?;
            trace("draw_end");
            trace("frame_rendered");
            if app.transcript.cached_rounds() > 0 {
                trace("frame_rendered_nonempty");
            }
            render_active_osc8_link(&mut terminal, &app)?;
            trace_cache(&app);
            dirty = false;
        }
        if shutdown.load(Ordering::Relaxed) {
            return Ok(());
        }

        let mut state_changed = false;
        let mut handled_message = false;
        loop {
            match pipe.inbound.try_recv() {
                Ok(message) => {
                    process_inbound_message(
                        &mut app,
                        message,
                        &mut pipe,
                        session_path,
                        &client_instance_id,
                        &mut request_sequence,
                    )?;
                    handled_message = true;
                    state_changed = true;
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return Err(TuiError::ChildEof),
            }
        }
        if event::poll(Duration::ZERO)? {
            match event::read()? {
                Event::Key(key) if key.kind == KeyEventKind::Press => {
                    if handle_key(
                        &mut app,
                        key.code,
                        key.modifiers,
                        &mut pipe,
                        session_path,
                        &client_instance_id,
                        &mut request_sequence,
                    )? {
                        return Ok(());
                    }
                    state_changed = true;
                }
                Event::Paste(text) => {
                    app.editor.insert(&text);
                    state_changed = true;
                }
                Event::Mouse(mouse) => match mouse.kind {
                    MouseEventKind::ScrollUp => {
                        app.transcript.scroll_by(-3);
                        state_changed = true;
                    }
                    MouseEventKind::ScrollDown => {
                        app.transcript.scroll_by(3);
                        state_changed = true;
                    }
                    _ => {}
                },
                Event::Resize(_, _) => {
                    terminal.autoresize()?;
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
                    process_inbound_message(
                        &mut app,
                        message,
                        &mut pipe,
                        session_path,
                        &client_instance_id,
                        &mut request_sequence,
                    )?;
                    state_changed = true;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(TuiError::ChildEof),
            }
        }
        if app.timed_out_b3_request().is_some() {
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
                app.mark_page_load_pending();
                request_transcript(
                    &mut pipe,
                    session_path,
                    Some(cursor.clone()),
                    false,
                    Some(TranscriptRequestContext {
                        generation: app.transcript.generation.clone(),
                        revision: Some(app.transcript.revision),
                        cursor: Some(cursor),
                    }),
                    &mut request_sequence,
                )?;
                state_changed = true;
            } else if app.search.pending_jump.is_some() {
                app.search.status = "目标不在当前可分页记录中".to_owned();
                app.search.pending_jump = None;
                state_changed = true;
            }
        }
        dirty |= state_changed;
    }
}

#[cfg(not(unix))]
pub fn run(_session_path: &str) -> Result<(), TuiError> {
    Err(TuiError::HelloRejected(
        "Windows named-pipe transport is not implemented".to_owned(),
    ))
}

#[cfg(unix)]
fn process_inbound_message(
    app: &mut AppState,
    message: Result<ServerMessage, TuiError>,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    request_sequence: &mut u64,
) -> Result<(), TuiError> {
    let message = message?;
    if apply_server_message(
        app,
        &message,
        session_path,
        pipe,
        client_instance_id,
        request_sequence,
    )? {
        app.mark_page_load_pending();
        request_transcript(pipe, session_path, None, true, None, request_sequence)?;
    }
    Ok(())
}

#[cfg(unix)]
fn request_acquire(
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
) -> Result<(), TuiError> {
    *sequence += 1;
    pipe.request(&encode_acquire_session_request(
        &format!("acquire-{sequence}"),
        session_path,
        client_instance_id,
    )?)
}

#[cfg(unix)]
fn request_transcript(
    pipe: &mut ProtocolPipe,
    session_path: &str,
    cursor: Option<String>,
    replace: bool,
    context: Option<TranscriptRequestContext>,
    sequence: &mut u64,
) -> Result<(), TuiError> {
    *sequence += 1;
    trace("read_transcript");
    let id = format!("{}-{sequence}", if replace { "initial" } else { "older" });
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
    pipe: &mut ProtocolPipe,
    session_path: &str,
    query: &str,
    sequence: &mut u64,
) -> Result<(), TuiError> {
    *sequence += 1;
    trace("search_transcript");
    let id = format!("search-{sequence}");
    pipe.request(&encode_search_transcript_request(
        &id,
        session_path,
        query,
        SEARCH_LIMIT,
    )?)
}

#[cfg(unix)]
fn handle_key(
    app: &mut AppState,
    code: KeyCode,
    modifiers: KeyModifiers,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
) -> Result<bool, TuiError> {
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
                    request_search(pipe, session_path, &query, sequence)?;
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
            items: [
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
            session_path,
            client_instance_id,
            sequence,
        );
    }

    if matches!(code, KeyCode::Esc)
        || (matches!(code, KeyCode::Char('c')) && modifiers.contains(KeyModifiers::CONTROL))
    {
        if let (Some(operation), Some(lease_id)) = (&app.operation, &app.lease_id)
            && matches!(
                operation.status.as_str(),
                "accepted" | "running" | "waiting_for_input"
            )
        {
            *sequence += 1;
            pipe.request(&encode_abort_operation_request(
                &format!("abort-{sequence}"),
                &operation.operation_id,
                lease_id,
            )?)?;
            app.transcript.status = "正在停止".to_owned();
        }
        return Ok(false);
    }

    match code {
        KeyCode::Char('q') if app.editor.is_empty() => return Ok(true),
        KeyCode::Char('f') if modifiers.contains(KeyModifiers::CONTROL) => {
            app.open_search();
            trace("search_open");
        }
        KeyCode::Char('o') if modifiers.contains(KeyModifiers::CONTROL) => {
            app.transcript.toggle_current_tool()
        }
        KeyCode::Char('u') if modifiers.contains(KeyModifiers::CONTROL) => app.editor.clear(),
        KeyCode::Char('z') if modifiers.contains(KeyModifiers::CONTROL) => app.editor.undo(),
        KeyCode::Char('r') if modifiers.contains(KeyModifiers::CONTROL) => app.editor.redo(),
        KeyCode::Char('j') if modifiers.contains(KeyModifiers::CONTROL) => app.editor.insert("\n"),
        KeyCode::Enter if modifiers.contains(KeyModifiers::SHIFT) => app.editor.insert("\n"),
        KeyCode::Enter => submit_editor(
            app,
            pipe,
            session_path,
            client_instance_id,
            sequence,
            modifiers.contains(KeyModifiers::ALT),
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
        "/about" => Some("about"),
        "/doctor" => Some("doctor"),
        "/help" => Some("help"),
        "/settings" => Some("settings"),
        "/model" => Some("model"),
        "/thinking" => Some("thinking"),
        "/login" => Some("login"),
        _ => None,
    }
}

#[cfg(unix)]
fn handle_overlay_key(
    app: &mut AppState,
    code: KeyCode,
    modifiers: KeyModifiers,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
) -> Result<bool, TuiError> {
    match code {
        KeyCode::Esc => {
            if let Some(request) = app.take_ui_response() {
                pipe.request(&encode_ui_response(&request.id, None, None, Some(true))?)?;
                app.set_toast("已取消输入");
            }
            app.close_overlay();
        }
        KeyCode::Up => app.move_overlay_selection(-1),
        KeyCode::Down => app.move_overlay_selection(1),
        KeyCode::PageUp => app.overlay_page(-1),
        KeyCode::PageDown => app.overlay_page(1),
        KeyCode::Home => app.overlay_home_end(false),
        KeyCode::End => app.overlay_home_end(true),
        KeyCode::Tab => {}

        KeyCode::Char('r') if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => {
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
        KeyCode::Char('d') if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => {
            if let Some(index) = app
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
) -> Result<(), TuiError> {
    if target == "help" {
        app.open_overlay(OverlayState::Detail(DetailOverlay {
            title: "帮助".to_owned(),
            lines: vec![
                "Ctrl+P 打开命令面板".to_owned(),
                "/settings 设置，/model 模型，/thinking 思考，/login 登录".to_owned(),
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
) -> Result<(), TuiError> {
    if let Some(target) = action.strip_prefix("open:") {
        return open_workbench(
            app,
            target,
            pipe,
            session_path,
            client_instance_id,
            sequence,
        );
    }
    if app.write_pending && !action.starts_with("ui:") {
        app.set_overlay_error("正在写入，请稍候");
        return Ok(());
    }
    if action.starts_with("disabled:") {
        app.set_overlay_error(action.trim_start_matches("disabled:"));
        return Ok(());
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
fn submit_editor(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    follow_up: bool,
) -> Result<(), TuiError> {
    let Some(lease_id) = app.lease_id.as_deref() else {
        app.transcript.status = "正在获取会话租约".to_owned();
        return Ok(());
    };
    let Some(text) = app.editor.submit() else {
        return Ok(());
    };
    if let Some(command) = builtin_slash_command(&text) {
        open_workbench(
            app,
            command,
            pipe,
            session_path,
            client_instance_id,
            sequence,
        )?;
        return Ok(());
    }
    *sequence += 1;
    let request_id = format!("composer-{sequence}");
    let command = if follow_up {
        "follow_up"
    } else if app.is_active_operation() {
        "steer"
    } else {
        "prompt"
    };
    pipe.request(&encode_queue_request(
        &format!("command-{sequence}"),
        command,
        session_path,
        lease_id,
        client_instance_id,
        &request_id,
        Some(&text),
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

fn apply_server_message(
    app: &mut AppState,
    message: &ServerMessage,
    session_path: &str,
    pipe: &mut ProtocolPipe,
    _client_instance_id: &str,
    sequence: &mut u64,
) -> Result<bool, TuiError> {
    let raw = message.json().map_err(TuiError::from)?;
    let page_response_id = (raw.get("type").and_then(serde_json::Value::as_str)
        == Some("response"))
    .then(|| raw.get("id").and_then(serde_json::Value::as_str))
    .flatten()
    .filter(|id| id.starts_with("initial-") || id.starts_with("older-"))
    .map(str::to_owned);
    if let Some(id) = &page_response_id {
        trace_id("host_response_received", id);
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
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("response")
        && let Some(id) = raw.get("id").and_then(serde_json::Value::as_str)
        && let Some(pending) = app.take_pending(id)
    {
        if pending.generation != app.request_generation {
            return Ok(false);
        }
        if raw.get("ok").and_then(serde_json::Value::as_bool) == Some(false) {
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
            PendingIntent::WorkbenchLoad {
                target,
                selected_key,
                filter,
            } => apply_workbench_load(app, target, selected_key, filter, result)?,
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
        ReadOnlyMessage::Event(event) => apply_event(app, &event, session_path),
        ReadOnlyMessage::Hello | ReadOnlyMessage::HelloError { .. } => Ok(false),
    }
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
    }
    Ok(())
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
        items,
        selected,
        filter,
        status: "Enter 选择认证方式，d 退出登录，Esc 返回".to_owned(),
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
        ReadOnlyResponse::Error { message, .. } => {
            app.clear_page_load_pending();
            app.transcript.status = message.clone();
            app.transcript.loading_previous = false;
        }
        ReadOnlyResponse::TranscriptPage { id, page }
            if id.starts_with("initial-") || id.starts_with("older-") =>
        {
            if !page.complete {
                app.clear_for_reload("记录页未完整返回，正在重新读取");
                trace("reload_requested");
                return Ok(true);
            }
            if id.starts_with("initial-") {
                trace_id("page_apply_start", id);
                app.clear_page_load_pending();
                app.transcript.replace_page(
                    page.items.clone(),
                    page.transcript_generation.clone(),
                    page.transcript_revision,
                    page.previous_cursor.clone(),
                );
                trace_id("page_apply_end", id);
                trace("page_applied");
            } else {
                let context = page.request_context.as_ref();
                if !app.transcript.accepts_previous_page(
                    &page.transcript_generation,
                    page.transcript_revision,
                    context.and_then(|value| value.generation.as_deref()),
                    context.and_then(|value| value.revision),
                ) {
                    app.clear_for_reload("更早记录已过期，正在重新读取");
                    trace("reload_requested");
                    return Ok(true);
                }
                trace_id("page_apply_start", id);
                app.clear_page_load_pending();
                app.transcript
                    .prepend_page(page.items.clone(), page.previous_cursor.clone());
                app.resolve_pending_jump();
                trace_id("page_apply_end", id);
                trace("page_applied");
            }
        }
        ReadOnlyResponse::SearchResult { id, result } if id.starts_with("search-") => {
            app.set_search_results(
                result
                    .hits
                    .iter()
                    .map(|hit| SearchHit {
                        entry_id: hit.entry_id.clone(),
                        kind: hit.kind.clone(),
                        timestamp: hit.timestamp.clone(),
                        snippet: hit.snippet.clone(),
                    })
                    .collect(),
            );
            trace("search_applied");
        }
        ReadOnlyResponse::SessionLease {
            lease_id, snapshot, ..
        } => {
            app.apply_lease(lease_id.clone(), snapshot.clone());
            app.transcript.status = "已获取会话租约".to_owned();
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
        ReadOnlyResponse::TranscriptPage { .. }
        | ReadOnlyResponse::SearchResult { .. }
        | ReadOnlyResponse::Other { .. } => {}
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
    let shutdown = Arc::new(AtomicBool::new(false));
    flag::register(SIGINT, Arc::clone(&shutdown))?;
    flag::register(SIGTERM, Arc::clone(&shutdown))?;
    let _terminal = TerminalGuard::enter()?;
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
