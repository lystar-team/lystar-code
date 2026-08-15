use std::{
    io::{self, Read, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use ciborium::{de::from_reader, ser::into_writer, value::Value};
use crossterm::{
    cursor::{Hide, Show},
    event::{DisableMouseCapture, EnableMouseCapture},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use lystar_protocol::{
    FrameDecoder, ProtocolError, ServerMessage, decode_server_message, encode_client_message,
    new_client_message,
};
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
pub fn handshake_inherited_pipes() -> Result<(), TuiError> {
    use std::{fs::File, os::fd::FromRawFd};

    // fd3/4 是 Node spawn 的独立 IPC，不会与 TTY stdout 混用。
    let mut input = unsafe { File::from_raw_fd(3) };
    let mut output = unsafe { File::from_raw_fd(4) };
    let mut hello_payload = Vec::new();
    into_writer(
        &serde_json::json!({"type":"hello","version":1,"clientInstanceId":"lystar-rust-b0"}),
        &mut hello_payload,
    )
    .map_err(|error| ProtocolError::InvalidCbor(error.to_string()))?;
    let raw_hello: Value = from_reader(hello_payload.as_slice())
        .map_err(|error| ProtocolError::InvalidCbor(error.to_string()))?;
    let hello = new_client_message(raw_hello)?;
    output.write_all(&encode_client_message(&hello)?)?;
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
            match message.typed() {
                ServerMessage::Variant0 { .. } => return Ok(()),
                ServerMessage::Variant1 { .. } => {
                    return Err(TuiError::HelloRejected(
                        "host returned hello_error".to_owned(),
                    ));
                }
                _ => return Err(TuiError::HelloRejected("expected server hello".to_owned())),
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

pub fn run_shell(wait_for_child_eof: bool, panic_after_enter: bool) -> Result<(), TuiError> {
    let shutdown = Arc::new(AtomicBool::new(false));
    flag::register(SIGINT, Arc::clone(&shutdown))?;
    flag::register(SIGTERM, Arc::clone(&shutdown))?;
    let _terminal = TerminalGuard::enter()?;
    if panic_after_enter {
        panic!("B0 terminal guard panic probe");
    }
    if wait_for_child_eof {
        return wait_for_protocol_eof(&shutdown);
    }
    while !shutdown.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(10));
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
        "Windows B0 named-pipe transport is not implemented".to_owned(),
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
