use std::{
    io::{self, Read, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
    },
    time::Duration,
};

use ciborium::{de::from_reader, ser::into_writer, value::Value as CborValue};
use crossterm::{
    cursor::{Hide, Show},
    event::{
        self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind, KeyModifiers,
        MouseEventKind,
    },
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use lystar_protocol::{
    FrameDecoder, ProtocolError, ServerMessage, decode_server_message, encode_client_message,
    new_client_message,
};
use ratatui::{Terminal, backend::CrosstermBackend};
use signal_hook::{
    consts::signal::{SIGINT, SIGTERM},
    flag,
};
use thiserror::Error;

use crate::app::{AppState, SearchHit, TranscriptItem, TranscriptView};

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
    fn connect() -> Result<Self, TuiError> {
        use std::{fs::File, os::fd::FromRawFd, thread};

        // fd3/4 仅承载 Host 的 framed protocol，Session 文件始终由 Host 读取。
        let input = unsafe { File::from_raw_fd(3) };
        let mut output = unsafe { File::from_raw_fd(4) };
        send_client(
            &mut output,
            serde_json::json!({"type":"hello","version":1,"clientInstanceId":"lystar-rust-m7"}),
        )?;
        let (sender, inbound) = mpsc::channel();
        thread::spawn(move || read_protocol(input, sender));
        let pipe = Self { output, inbound };
        match pipe.inbound.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(message)) if message.message_kind() == "hello" => Ok(pipe),
            Ok(Ok(message)) if message.message_kind() == "hello_error" => Err(
                TuiError::HelloRejected("host returned hello_error".to_owned()),
            ),
            Ok(Ok(_)) => Err(TuiError::HelloRejected("expected server hello".to_owned())),
            Ok(Err(error)) => Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err(TuiError::HelloRejected("host hello timed out".to_owned()))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(TuiError::ChildEof),
        }
    }

    fn request(&mut self, id: &str, request: serde_json::Value) -> Result<(), TuiError> {
        send_client(
            &mut self.output,
            serde_json::json!({"type":"request","id":id,"request":request}),
        )
    }
}

#[cfg(unix)]
fn read_protocol(mut input: std::fs::File, sender: mpsc::Sender<Result<ServerMessage, TuiError>>) {
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

fn send_client(output: &mut impl Write, json: serde_json::Value) -> Result<(), TuiError> {
    let mut encoded = Vec::new();
    into_writer(&json, &mut encoded)
        .map_err(|error| ProtocolError::InvalidCbor(error.to_string()))?;
    let raw: CborValue = from_reader(encoded.as_slice())
        .map_err(|error| ProtocolError::InvalidCbor(error.to_string()))?;
    let message = new_client_message(raw)?;
    output.write_all(&encode_client_message(&message)?)?;
    output.flush()?;
    Ok(())
}

fn json_value(value: &CborValue) -> Result<serde_json::Value, TuiError> {
    let mut bytes = Vec::new();
    into_writer(value, &mut bytes)
        .map_err(|error| ProtocolError::InvalidCbor(error.to_string()))?;
    serde_json::from_slice(&bytes).map_err(|error| TuiError::InvalidResponse(error.to_string()))
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
    request_transcript(&mut pipe, session_path, None, true, &mut request_sequence)?;

    let _terminal_guard = TerminalGuard::enter()?;
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::new(backend)?;
    let mut app = AppState::default();
    loop {
        terminal.draw(|frame| frame.render_widget(TranscriptView::new(&app), frame.area()))?;
        if shutdown.load(Ordering::Relaxed) {
            return Ok(());
        }
        while let Ok(message) = pipe.inbound.try_recv() {
            match message {
                Ok(message) => {
                    let reload = apply_server_message(&mut app, &message, session_path)?;
                    if reload {
                        request_transcript(
                            &mut pipe,
                            session_path,
                            None,
                            true,
                            &mut request_sequence,
                        )?;
                    }
                }
                Err(error) => {
                    app.disconnected = Some(format!("连接已关闭: {error}"));
                    terminal.draw(|frame| {
                        frame.render_widget(TranscriptView::new(&app), frame.area())
                    })?;
                    return Err(error);
                }
            }
        }
        if event::poll(Duration::from_millis(50))? {
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
        }
        if app.transcript.needs_previous_page()
            || app.search.pending_jump.is_some() && !app.transcript.loading_previous
        {
            if let Some(cursor) = app.transcript.take_previous_cursor() {
                request_transcript(
                    &mut pipe,
                    session_path,
                    Some(cursor),
                    false,
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
fn request_transcript(
    pipe: &mut ProtocolPipe,
    session_path: &str,
    cursor: Option<String>,
    replace: bool,
    sequence: &mut u64,
) -> Result<(), TuiError> {
    *sequence += 1;
    let mut request = serde_json::json!({
        "command":"read_transcript",
        "sessionPath":session_path,
        "limit": if replace { INITIAL_PAGE_LIMIT } else { PAGE_LIMIT },
    });
    if let Some(cursor) = cursor {
        request["cursor"] = serde_json::Value::String(cursor);
    }
    pipe.request(
        &format!("{}-{sequence}", if replace { "initial" } else { "older" }),
        request,
    )
}

#[cfg(unix)]
fn request_search(
    pipe: &mut ProtocolPipe,
    session_path: &str,
    query: &str,
    sequence: &mut u64,
) -> Result<(), TuiError> {
    *sequence += 1;
    pipe.request(
        &format!("search-{sequence}"),
        serde_json::json!({
            "command":"search_transcript",
            "sessionPath":session_path,
            "query":query,
            "limit":SEARCH_LIMIT,
        }),
    )
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
            KeyCode::Esc => app.close_search(),
            KeyCode::Enter => {
                if app.search.query.trim().is_empty() {
                    app.search.status = "请输入搜索内容".to_owned();
                } else if app.select_search_result().is_none() {
                    let query = app.search.query.clone();
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
        KeyCode::Char('/') => app.open_search(),
        KeyCode::Char('f') if modifiers.contains(KeyModifiers::CONTROL) => app.open_search(),
        KeyCode::Char('o') if modifiers.contains(KeyModifiers::CONTROL) => {
            app.transcript.toggle_current_tool()
        }
        KeyCode::Up => app.transcript.scroll_by(-1),
        KeyCode::Down => app.transcript.scroll_by(1),
        KeyCode::PageUp => app.transcript.scroll_by(-20),
        KeyCode::PageDown => app.transcript.scroll_by(20),
        KeyCode::Home => {
            app.transcript.current = 0;
            app.transcript.scroll = 0;
        }
        KeyCode::End => {
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
    message: &ServerMessage,
    session_path: &str,
) -> Result<bool, TuiError> {
    let message = json_value(message.value())?;
    match message.get("type").and_then(serde_json::Value::as_str) {
        Some("response") => apply_response(app, &message),
        Some("event") => apply_event(app, &message, session_path),
        _ => Ok(false),
    }
}

fn apply_response(app: &mut AppState, message: &serde_json::Value) -> Result<bool, TuiError> {
    let id = message
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if message.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        app.transcript.status = message
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Host 请求失败")
            .to_owned();
        app.transcript.loading_previous = false;
        return Ok(false);
    }
    let result = message
        .get("result")
        .ok_or_else(|| TuiError::InvalidResponse("missing response result".to_owned()))?;
    if id.starts_with("initial-") || id.starts_with("older-") {
        let items = transcript_items(result)?;
        let generation = result
            .get("transcriptGeneration")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| TuiError::InvalidResponse("missing transcript generation".to_owned()))?
            .to_owned();
        let revision = result
            .get("transcriptRevision")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| TuiError::InvalidResponse("missing transcript revision".to_owned()))?;
        let cursor = result
            .get("previousCursor")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        if id.starts_with("initial-") {
            app.transcript
                .replace_page(items, generation, revision, cursor);
        } else {
            app.transcript.prepend_page(items, cursor);
            app.resolve_pending_jump();
        }
    } else if id.starts_with("search-") {
        let hits = result
            .get("hits")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| TuiError::InvalidResponse("missing search hits".to_owned()))?
            .iter()
            .filter_map(|hit| {
                Some(SearchHit {
                    entry_id: hit.get("entryId")?.as_str()?.to_owned(),
                    kind: hit.get("kind")?.as_str()?.to_owned(),
                    timestamp: hit.get("timestamp")?.as_str()?.to_owned(),
                    snippet: hit.get("snippet")?.as_str()?.to_owned(),
                })
            })
            .collect();
        app.set_search_results(hits);
    }
    Ok(false)
}

fn apply_event(
    app: &mut AppState,
    message: &serde_json::Value,
    session_path: &str,
) -> Result<bool, TuiError> {
    let event = message
        .get("event")
        .ok_or_else(|| TuiError::InvalidResponse("missing event".to_owned()))?;
    if event.get("sessionPath").and_then(serde_json::Value::as_str) != Some(session_path) {
        return Ok(false);
    }
    match event.get("type").and_then(serde_json::Value::as_str) {
        Some("transcript_changed") => {
            app.transcript.clear_for_reload("记录已重写，正在重新读取");
            Ok(true)
        }
        Some("transcript_committed") => {
            let generation = event
                .get("transcriptGeneration")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    TuiError::InvalidResponse("missing committed generation".to_owned())
                })?;
            let from = event
                .get("fromRevision")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| {
                    TuiError::InvalidResponse("missing committed from revision".to_owned())
                })?;
            let to = event
                .get("toRevision")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| {
                    TuiError::InvalidResponse("missing committed to revision".to_owned())
                })?;
            let items = event
                .get("items")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| TuiError::InvalidResponse("missing committed items".to_owned()))?
                .iter()
                .filter_map(TranscriptItem::from_value)
                .collect();
            if !app.transcript.append_committed(generation, from, to, items) {
                app.transcript
                    .clear_for_reload("记录版本不连续，正在重新读取");
                return Ok(true);
            }
            Ok(false)
        }
        Some("session_progress") => {
            app.transcript.streaming_preview = event.get("progress").map(|value| {
                serde_json::to_string(value).unwrap_or_else(|_| "streaming".to_owned())
            });
            Ok(false)
        }
        _ => Ok(false),
    }
}

fn transcript_items(value: &serde_json::Value) -> Result<Vec<TranscriptItem>, TuiError> {
    value
        .get("items")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| TuiError::InvalidResponse("missing transcript items".to_owned()))
        .map(|items| {
            items
                .iter()
                .filter_map(TranscriptItem::from_value)
                .collect()
        })
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
}
