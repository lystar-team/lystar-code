use std::{
    io::{self, Read, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    time::Duration,
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
    AppState, ComposerView, ConfirmOverlay, DetailOverlay, InputFocus, ListOverlay, OverlayItem,
    OverlayState, PendingIntent, SearchHit, TextEditorOverlay, TranscriptView, UiRequest,
    UiRequestKind, VisibleLink, WorkbenchOverlayView, composer_area, transcript_area,
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
        let at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_millis());
        eprintln!("lystar-rust-tui trace={event} at_ms={at_ms}");
    }
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
    let Some(region) = TranscriptView::new(app).visible_link(transcript_area(app, full)) else {
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
    loop {
        let area = terminal.size()?;
        let full = ratatui::layout::Rect::new(0, 0, area.width, area.height);
        app.prepare_composer(composer_area(&app, full));
        terminal.draw(|frame| {
            let area = frame.area();
            frame.render_widget(TranscriptView::new(&app), transcript_area(&app, area));
            frame.render_widget(ComposerView::new(&app), composer_area(&app, area));
            frame.render_widget(WorkbenchOverlayView::new(&app), area);
        })?;
        trace("frame_rendered");
        if app.transcript.cached_rounds() > 0 {
            trace("frame_rendered_nonempty");
        }
        render_active_osc8_link(&mut terminal, &app)?;
        trace_cache(&app);
        if shutdown.load(Ordering::Relaxed) {
            return Ok(());
        }
        let mut handled_message = false;
        while let Ok(message) = pipe.inbound.try_recv() {
            handled_message = true;
            if let Err(error) = process_inbound_message(
                &mut app,
                message,
                &mut pipe,
                session_path,
                &mut request_sequence,
            ) {
                app.disconnected = Some(format!("连接已关闭: {error}"));
                app.clear_transient();
                app.clear_overlay_transient();
                let area = terminal.size()?;
                app.prepare_composer(composer_area(
                    &app,
                    ratatui::layout::Rect::new(0, 0, area.width, area.height),
                ));
                terminal.draw(|frame| {
                    let area = frame.area();
                    frame.render_widget(TranscriptView::new(&app), transcript_area(&app, area));
                    frame.render_widget(ComposerView::new(&app), composer_area(&app, area));
                })?;
                render_active_osc8_link(&mut terminal, &app)?;
                return Err(error);
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
                }
                Event::Paste(text) => app.editor.insert(&text),
                Event::Mouse(mouse) => match mouse.kind {
                    MouseEventKind::ScrollUp => app.transcript.scroll_by(-3),
                    MouseEventKind::ScrollDown => app.transcript.scroll_by(3),
                    _ => {}
                },
                Event::Resize(_, _) => {
                    terminal.autoresize()?;
                }
                _ => {}
            }
        } else if !handled_message {
            match pipe.inbound.recv_timeout(Duration::from_millis(16)) {
                Ok(message) => {
                    if let Err(error) = process_inbound_message(
                        &mut app,
                        message,
                        &mut pipe,
                        session_path,
                        &mut request_sequence,
                    ) {
                        app.disconnected = Some(format!("连接已关闭: {error}"));
                        app.clear_transient();
                        app.clear_overlay_transient();
                        let area = terminal.size()?;
                        app.prepare_composer(composer_area(
                            &app,
                            ratatui::layout::Rect::new(0, 0, area.width, area.height),
                        ));
                        terminal.draw(|frame| {
                            let area = frame.area();
                            frame.render_widget(
                                TranscriptView::new(&app),
                                transcript_area(&app, area),
                            );
                            frame.render_widget(ComposerView::new(&app), composer_area(&app, area));
                        })?;
                        render_active_osc8_link(&mut terminal, &app)?;
                        return Err(error);
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(TuiError::ChildEof),
            }
        }
        if app.transcript.needs_previous_page()
            || app.search.pending_jump.is_some() && !app.transcript.loading_previous
        {
            if let Some(cursor) = app.transcript.take_previous_cursor() {
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
            } else if app.search.pending_jump.is_some() {
                app.search.status = "目标不在当前可分页记录中".to_owned();
                app.search.pending_jump = None;
            }
        }
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
    request_sequence: &mut u64,
) -> Result<(), TuiError> {
    let message = message?;
    if apply_server_message(app, &message, session_path, pipe)? {
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
            items: [("help", "帮助"), ("about", "关于"), ("doctor", "诊断")]
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
fn open_workbench(
    app: &mut AppState,
    target: &str,
    pipe: &mut ProtocolPipe,
    _session_path: &str,
    _client_instance_id: &str,
    sequence: &mut u64,
) -> Result<(), TuiError> {
    if target == "help" {
        app.open_overlay(OverlayState::Detail(DetailOverlay {
            title: "帮助".to_owned(),
            lines: vec![
                "Ctrl+P 打开命令面板".to_owned(),
                "/help 显示此帮助".to_owned(),
                "/about 显示版本与运行目录".to_owned(),
                "/doctor 显示诊断结果".to_owned(),
                "Esc 关闭；方向键、PageUp/PageDown、Home/End 可浏览详情".to_owned(),
            ],
            scroll: 0,
            status: "Esc 返回".to_owned(),
        }));
        return Ok(());
    }
    let (command, title) = match target {
        "about" => (B3Command::GetAbout, "关于"),
        "doctor" => (B3Command::GetDiagnostics, "诊断"),
        _ => return Ok(()),
    };
    app.open_overlay(OverlayState::Detail(DetailOverlay {
        title: title.to_owned(),
        lines: vec!["正在读取".to_owned()],
        scroll: 0,
        status: "请稍候".to_owned(),
    }));
    *sequence += 1;
    let id = format!("{}:{sequence}", command.wire());
    app.begin_request(
        id.clone(),
        PendingIntent::Overlay {
            target: title.to_owned(),
            command,
        },
    );
    let request = if command == B3Command::GetDiagnostics {
        let cwd = app.snapshot.as_ref().map(|snapshot| snapshot.cwd.clone());
        serde_json::json!({"cwd":cwd})
    } else {
        serde_json::json!({})
    };
    pipe.request(&encode_b3_request(
        &id,
        command,
        request.as_object().cloned().unwrap_or_default(),
    )?)
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
    let Some(request) = app.take_ui_response() else {
        return Ok(());
    };
    let (value, confirmed) = match (request.kind, action) {
        (UiRequestKind::Confirm, "ui:confirm") => (None, Some(true)),
        (UiRequestKind::Input, "ui:input") => {
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
) -> Result<bool, TuiError> {
    let raw = message.json().map_err(TuiError::from)?;
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
        let kind = match event.get("kind").and_then(serde_json::Value::as_str) {
            Some("select") => UiRequestKind::Select,
            Some("confirm") => UiRequestKind::Confirm,
            Some("input") => UiRequestKind::Input,
            Some(kind) => {
                app.set_overlay_error(format!("不支持的输入类型: {kind}"));
                if app.cancel_unknown_ui_request(id) {
                    pipe.request(&encode_ui_response(id, None, None, Some(true))?)?;
                }
                return Ok(false);
            }
            None => {
                app.set_overlay_error("输入请求缺少类型");
                if app.cancel_unknown_ui_request(id) {
                    pipe.request(&encode_ui_response(id, None, None, Some(true))?)?;
                }
                return Ok(false);
            }
        };
        let title = event
            .get("title")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("需要输入");
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
            UiRequestKind::Input => {
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
        let PendingIntent::Overlay { target, command } = pending.intent;
        let result = message.validated_b3_result_value(command)?;
        apply_workbench_result(app, target, result);
        return Ok(false);
    }
    match message.read_only().map_err(TuiError::from)? {
        ReadOnlyMessage::Response(response) => apply_response(app, &response),
        ReadOnlyMessage::Event(event) => apply_event(app, &event, session_path),
        ReadOnlyMessage::Hello | ReadOnlyMessage::HelloError { .. } => Ok(false),
    }
}

fn apply_workbench_result(app: &mut AppState, title: String, result: serde_json::Value) {
    app.replace_overlay(OverlayState::Detail(DetailOverlay {
        title,
        lines: pretty_json_lines(&result),
        scroll: 0,
        status: "Esc 返回".to_owned(),
    }));
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
                .or_else(|| option.as_str())?;
            let label = option
                .get("label")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(value);
            Some(OverlayItem {
                label: label.to_owned(),
                detail: String::new(),
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
                app.transcript.replace_page(
                    page.items.clone(),
                    page.transcript_generation.clone(),
                    page.transcript_revision,
                    page.previous_cursor.clone(),
                );
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
                app.transcript
                    .prepend_page(page.items.clone(), page.previous_cursor.clone());
                app.resolve_pending_jump();
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
    fn intercepts_only_the_three_connected_slash_commands() {
        assert_eq!(builtin_slash_command("/help"), Some("help"));
        assert_eq!(builtin_slash_command(" /about "), Some("about"));
        assert_eq!(builtin_slash_command("/doctor"), Some("doctor"));
        assert_eq!(builtin_slash_command("/settings"), None);
        assert_eq!(builtin_slash_command("/about later"), None);
    }

    #[test]
    fn builds_select_items_from_host_payload() {
        let items = ui_select_items(&serde_json::json!({
            "options": [{"label":"Beta", "value":"beta"}, "alpha"]
        }));
        assert_eq!(items[0].label, "Beta");
        assert_eq!(items[0].action, "ui:select:beta");
        assert_eq!(items[1].action, "ui:select:alpha");
    }
}
