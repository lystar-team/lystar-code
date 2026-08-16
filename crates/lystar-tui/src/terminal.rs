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
    FrameDecoder, ProtocolError, ReadOnlyEvent, ReadOnlyMessage, ReadOnlyResponse,
    TranscriptRequestContext, decode_server_message, encode_client_hello,
    encode_read_transcript_request, encode_search_transcript_request,
};
use ratatui::{Terminal, backend::CrosstermBackend};
use signal_hook::{
    consts::signal::{SIGINT, SIGTERM},
    flag,
};
use thiserror::Error;

use crate::app::{AppState, SearchHit, TranscriptView, VisibleLink};

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
    inbound: Receiver<Result<ReadOnlyMessage, TuiError>>,
}

#[cfg(unix)]
impl ProtocolPipe {
    fn connect() -> Result<Self, TuiError> {
        use std::{fs::File, os::fd::FromRawFd, thread};

        // fd3/4 仅承载 Host 的 framed protocol，Session 文件始终由 Host 读取。
        let input = unsafe { File::from_raw_fd(3) };
        let mut output = unsafe { File::from_raw_fd(4) };
        output.write_all(&encode_client_hello("lystar-rust-m7")?)?;
        output.flush()?;
        let (sender, inbound) = mpsc::sync_channel(64);
        thread::spawn(move || read_protocol(input, sender));
        let pipe = Self { output, inbound };
        match pipe.inbound.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(ReadOnlyMessage::Hello)) => Ok(pipe),
            Ok(Ok(ReadOnlyMessage::HelloError { .. })) => Err(TuiError::HelloRejected(
                "host returned hello_error".to_owned(),
            )),
            Ok(Ok(_)) => Err(TuiError::HelloRejected("expected server hello".to_owned())),
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
fn read_protocol(mut input: std::fs::File, sender: SyncSender<Result<ReadOnlyMessage, TuiError>>) {
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
                            .send(
                                decode_server_message(&frame)
                                    .and_then(|message| message.read_only())
                                    .map_err(TuiError::from),
                            )
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
    let size = terminal.size()?;
    let Some(region) = TranscriptView::new(app).visible_link(ratatui::layout::Rect::new(
        0,
        0,
        size.width,
        size.height,
    )) else {
        return Ok(());
    };
    write_visible_osc8_link(terminal.backend_mut().writer_mut(), &region)
}

#[cfg(unix)]
pub fn handshake_inherited_pipes() -> Result<(), TuiError> {
    let _pipe = ProtocolPipe::connect()?;
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
    let mut pipe = ProtocolPipe::connect()?;
    let mut request_sequence = 0_u64;
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
        terminal.draw(|frame| frame.render_widget(TranscriptView::new(&app), frame.area()))?;
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
                terminal
                    .draw(|frame| frame.render_widget(TranscriptView::new(&app), frame.area()))?;
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
                        &mut request_sequence,
                    )? {
                        return Ok(());
                    }
                }
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
                        terminal.draw(|frame| {
                            frame.render_widget(TranscriptView::new(&app), frame.area())
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
    message: Result<ReadOnlyMessage, TuiError>,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    request_sequence: &mut u64,
) -> Result<(), TuiError> {
    let message = message?;
    if apply_server_message(app, &message, session_path)? {
        request_transcript(pipe, session_path, None, true, None, request_sequence)?;
    }
    Ok(())
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
                    (app.search.selected + 1).min(app.search.hits.len().saturating_sub(1));
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
    match code {
        KeyCode::Char('q') => return Ok(true),
        KeyCode::Char('/') => {
            app.open_search();
            trace("search_open");
        }
        KeyCode::Char('f') if modifiers.contains(KeyModifiers::CONTROL) => {
            app.open_search();
            trace("search_open");
        }
        KeyCode::Char('o') if modifiers.contains(KeyModifiers::CONTROL) => {
            app.transcript.toggle_current_tool()
        }
        KeyCode::Up => app.transcript.scroll_by(-1),
        KeyCode::Down => app.transcript.scroll_by(1),
        KeyCode::PageUp => {
            trace("key_page_up");
            app.transcript.scroll_by(-20);
        }
        KeyCode::PageDown => app.transcript.scroll_by(20),
        KeyCode::Home => {
            trace("key_home");
            app.transcript.current = 0;
            app.transcript.scroll = 0;
        }
        KeyCode::End => {
            trace("key_end");
            let last = app.transcript.cached_rounds().saturating_sub(1);
            app.transcript.current = last;
            app.transcript.scroll = last;
        }
        _ => {}
    }
    Ok(false)
}

fn apply_server_message(
    app: &mut AppState,
    message: &ReadOnlyMessage,
    session_path: &str,
) -> Result<bool, TuiError> {
    match message {
        ReadOnlyMessage::Response(response) => apply_response(app, response),
        ReadOnlyMessage::Event(event) => apply_event(app, event, session_path),
        ReadOnlyMessage::Hello | ReadOnlyMessage::HelloError { .. } => Ok(false),
    }
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
            app.transcript.streaming_preview = None;
            trace("append_applied");
            Ok(false)
        }
        ReadOnlyEvent::SessionProgress {
            session_path: event_path,
            preview,
        } if event_path == session_path => {
            app.transcript.streaming_preview = Some(preview.clone());
            Ok(false)
        }
        ReadOnlyEvent::TranscriptChanged { .. }
        | ReadOnlyEvent::TranscriptCommitted { .. }
        | ReadOnlyEvent::SessionProgress { .. }
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
}
