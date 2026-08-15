use std::{
    io::{self, Read, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use crossterm::{
    cursor::{Hide, Show},
    event::{DisableMouseCapture, EnableMouseCapture},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use lystar_protocol::{FrameDecoder, ProtocolError, decode_server_message, encode_frame};
use serde_json::json;
use signal_hook::{
    consts::signal::{SIGINT, SIGTERM},
    flag,
};
use thiserror::Error;

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
}

pub struct TerminalGuard {
    active: bool,
}

impl TerminalGuard {
    pub fn enter() -> Result<Self, io::Error> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        execute!(stdout, EnterAlternateScreen, EnableMouseCapture, Hide)?;
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

#[cfg(unix)]
pub fn handshake_inherited_pipes() -> Result<(), TuiError> {
    use std::{fs::File, os::fd::FromRawFd};

    // fd3/4 是 Node spawn 的独立 IPC，不会与 TTY stdout 混用。
    let mut input = unsafe { File::from_raw_fd(3) };
    let mut output = unsafe { File::from_raw_fd(4) };
    output.write_all(&encode_frame(
        &json!({"type":"hello", "version":1, "clientInstanceId":"lystar-rust-b0"}),
    )?)?;
    output.flush()?;
    let mut decoder = FrameDecoder::default();
    let mut buffer = [0_u8; 8192];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            decoder.end()?;
            return Err(TuiError::ChildEof);
        }
        if let Some(frame) = decoder.push(&buffer[..count])?.into_iter().next() {
            let message = decode_server_message(&frame)?;
            match message.get("type").and_then(serde_json::Value::as_str) {
                Some("hello") => return Ok(()),
                Some("hello_error") => {
                    let reason = message["error"]["message"]
                        .as_str()
                        .unwrap_or("unknown host error");
                    return Err(TuiError::HelloRejected(reason.to_owned()));
                }
                Some(kind) => {
                    return Err(TuiError::HelloRejected(format!(
                        "expected hello, got {kind}"
                    )));
                }
                None => {
                    return Err(TuiError::HelloRejected(
                        "host message has no type".to_owned(),
                    ));
                }
            }
        }
    }
}

#[cfg(not(unix))]
pub fn handshake_inherited_pipes() -> Result<(), TuiError> {
    Err(TuiError::HelloRejected(
        "Windows B0 named-pipe transport is not implemented".to_owned(),
    ))
}

pub fn run_shell() -> Result<(), TuiError> {
    let shutdown = Arc::new(AtomicBool::new(false));
    flag::register(SIGINT, Arc::clone(&shutdown))?;
    flag::register(SIGTERM, Arc::clone(&shutdown))?;
    let _terminal = TerminalGuard::enter()?;
    while !shutdown.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    Ok(())
}
