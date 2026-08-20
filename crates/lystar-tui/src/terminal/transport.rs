use super::*;

type TransportStreams = (Box<dyn Read + Send>, Box<dyn Write>);

pub(super) struct ProtocolPipe {
    pub(super) output: Box<dyn Write>,
    pub(super) inbound: Receiver<Result<ServerMessage, TuiError>>,
}

impl ProtocolPipe {
    pub(super) fn connect(client_instance_id: &str) -> Result<Self, TuiError> {
        // Composition root 注入 socket endpoint；未注入时保留 fd3/fd4 FIFO 兼容路径。
        let endpoint = std::env::var_os("PI_RUST_TUI_HOST_ENDPOINT");
        Self::connect_with_endpoint(client_instance_id, endpoint.as_deref())
    }

    pub(super) fn connect_with_endpoint(
        client_instance_id: &str,
        endpoint: Option<&std::ffi::OsStr>,
    ) -> Result<Self, TuiError> {
        use std::thread;

        let (input, mut output) = open_transport(endpoint)?;
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

    pub(super) fn request(&mut self, frame: &[u8]) -> Result<(), TuiError> {
        self.output.write_all(frame)?;
        self.output.flush()?;
        Ok(())
    }
}

#[cfg(unix)]
fn open_transport(endpoint: Option<&std::ffi::OsStr>) -> Result<TransportStreams, TuiError> {
    use std::{fs::File, os::fd::FromRawFd, os::unix::net::UnixStream, path::Path};

    if let Some(endpoint) = endpoint {
        let stream = UnixStream::connect(Path::new(endpoint))?;
        let input = stream.try_clone()?;
        return Ok((Box::new(input), Box::new(stream)));
    }
    // fd3/4 仅承载 Host 的 framed protocol，Session 文件始终由 Host 读取。
    let input = unsafe { File::from_raw_fd(3) };
    let output = unsafe { File::from_raw_fd(4) };
    Ok((Box::new(input), Box::new(output)))
}

#[cfg(windows)]
fn open_transport(endpoint: Option<&std::ffi::OsStr>) -> Result<TransportStreams, TuiError> {
    use std::{fs::OpenOptions, path::Path};

    let endpoint = endpoint
        .ok_or_else(|| TuiError::HelloRejected("缺少 Windows named pipe endpoint".to_owned()))?;
    let stream = OpenOptions::new()
        .read(true)
        .write(true)
        .open(Path::new(endpoint))?;
    let input = stream.try_clone()?;
    Ok((Box::new(input), Box::new(stream)))
}

pub(super) fn read_protocol(
    mut input: Box<dyn Read + Send>,
    sender: SyncSender<Result<ServerMessage, TuiError>>,
) {
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

pub fn handshake_inherited_pipes() -> Result<(), TuiError> {
    let _pipe = ProtocolPipe::connect("lystar-rust-handshake")?;
    Ok(())
}

pub fn smoke_production_ipc(cwd: &str) -> Result<(), TuiError> {
    const CLIENT_ID: &str = "lystar-rust-ipc-smoke";
    const RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);

    let mut pipe = ProtocolPipe::connect(CLIENT_ID)?;
    pipe.request(&encode_create_session_request(
        "smoke-create",
        cwd,
        CLIENT_ID,
        "smoke:create",
    )?)?;
    let (session_path, created_lease) = expect_session_lease(
        wait_for_response(&pipe, "smoke-create", RESPONSE_TIMEOUT)?,
        "smoke-create",
    )?;

    pipe.request(&encode_release_session_request(
        "smoke-release-created",
        &session_path,
        &created_lease,
    )?)?;
    expect_other_response(
        wait_for_response(&pipe, "smoke-release-created", RESPONSE_TIMEOUT)?,
        "smoke-release-created",
    )?;

    pipe.request(&encode_acquire_session_request(
        "smoke-acquire",
        &session_path,
        CLIENT_ID,
    )?)?;
    let (acquired_path, lease_id) = expect_session_lease(
        wait_for_response(&pipe, "smoke-acquire", RESPONSE_TIMEOUT)?,
        "smoke-acquire",
    )?;
    if acquired_path != session_path {
        return Err(TuiError::InvalidResponse(
            "IPC smoke acquire 返回了不同的 Session".to_owned(),
        ));
    }

    pipe.request(&encode_queue_request(
        "smoke-prompt",
        "prompt",
        &session_path,
        &lease_id,
        CLIENT_ID,
        "smoke:prompt",
        Some("production IPC smoke"),
        None,
    )?)?;
    let operation = expect_operation(
        wait_for_response(&pipe, "smoke-prompt", RESPONSE_TIMEOUT)?,
        "smoke-prompt",
    )?;
    wait_for_completed_operation(&pipe, &operation.operation_id, RESPONSE_TIMEOUT)?;

    pipe.request(&encode_release_session_request(
        "smoke-release",
        &session_path,
        &lease_id,
    )?)?;
    expect_other_response(
        wait_for_response(&pipe, "smoke-release", RESPONSE_TIMEOUT)?,
        "smoke-release",
    )
}

fn wait_for_response(
    pipe: &ProtocolPipe,
    expected_id: &str,
    timeout: Duration,
) -> Result<ReadOnlyResponse, TuiError> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(TuiError::InvalidResponse(format!(
                "等待 {expected_id} 响应超时"
            )));
        }
        let message = match pipe.inbound.recv_timeout(remaining) {
            Ok(Ok(message)) => message,
            Ok(Err(error)) => return Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(TuiError::InvalidResponse(format!(
                    "等待 {expected_id} 响应超时"
                )));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(TuiError::ChildEof),
        };
        let ReadOnlyMessage::Response(response) = message.read_only().map_err(TuiError::from)?
        else {
            continue;
        };
        let response_id = match &response {
            ReadOnlyResponse::TranscriptPage { id, .. }
            | ReadOnlyResponse::SearchResult { id, .. }
            | ReadOnlyResponse::SessionLease { id, .. }
            | ReadOnlyResponse::Operation { id, .. }
            | ReadOnlyResponse::Error { id, .. }
            | ReadOnlyResponse::Other { id } => id,
        };
        if response_id == expected_id {
            return Ok(response);
        }
    }
}

fn expect_session_lease(
    response: ReadOnlyResponse,
    expected_id: &str,
) -> Result<(String, String), TuiError> {
    match response {
        ReadOnlyResponse::SessionLease {
            lease_id, snapshot, ..
        } => Ok((snapshot.path, lease_id)),
        ReadOnlyResponse::Error { message, .. } => Err(TuiError::InvalidResponse(message)),
        _ => Err(TuiError::InvalidResponse(format!(
            "{expected_id} 未返回 Session lease"
        ))),
    }
}

fn expect_operation(
    response: ReadOnlyResponse,
    expected_id: &str,
) -> Result<lystar_protocol::OperationSnapshot, TuiError> {
    match response {
        ReadOnlyResponse::Operation { operation, .. } => Ok(operation),
        ReadOnlyResponse::Error { message, .. } => Err(TuiError::InvalidResponse(message)),
        _ => Err(TuiError::InvalidResponse(format!(
            "{expected_id} 未返回 operation"
        ))),
    }
}

fn expect_other_response(response: ReadOnlyResponse, expected_id: &str) -> Result<(), TuiError> {
    match response {
        ReadOnlyResponse::Other { .. } => Ok(()),
        ReadOnlyResponse::Error { message, .. } => Err(TuiError::InvalidResponse(message)),
        _ => Err(TuiError::InvalidResponse(format!(
            "{expected_id} 返回了意外结果"
        ))),
    }
}

fn wait_for_completed_operation(
    pipe: &ProtocolPipe,
    operation_id: &str,
    timeout: Duration,
) -> Result<(), TuiError> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(TuiError::InvalidResponse(
                "等待 IPC smoke operation 完成超时".to_owned(),
            ));
        }
        let message = match pipe.inbound.recv_timeout(remaining) {
            Ok(Ok(message)) => message,
            Ok(Err(error)) => return Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(TuiError::InvalidResponse(
                    "等待 IPC smoke operation 完成超时".to_owned(),
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(TuiError::ChildEof),
        };
        match message.read_only().map_err(TuiError::from)? {
            ReadOnlyMessage::Event(ReadOnlyEvent::OperationUpdated { operation })
                if operation.operation_id == operation_id =>
            {
                match operation.status.as_str() {
                    "completed" => return Ok(()),
                    "failed" | "aborted" | "interrupted" => {
                        return Err(TuiError::InvalidResponse(format!(
                            "IPC smoke operation 终止于 {}",
                            operation.status
                        )));
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
}
