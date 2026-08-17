use super::*;

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
pub(super) fn wait_for_protocol_eof(shutdown: &AtomicBool) -> Result<(), TuiError> {
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
pub(super) fn wait_for_protocol_eof(_shutdown: &AtomicBool) -> Result<(), TuiError> {
    Err(TuiError::HelloRejected(
        "Windows named-pipe transport is not implemented".to_owned(),
    ))
}
