use super::*;

#[cfg(unix)]
pub(super) struct ProtocolPipe {
    pub(super) output: Box<dyn Write>,
    pub(super) inbound: Receiver<Result<ServerMessage, TuiError>>,
}

#[cfg(unix)]
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
        use std::{fs::File, os::fd::FromRawFd, thread};

        let (input, mut output): (Box<dyn Read + Send>, Box<dyn Write>) =
            if let Some(endpoint) = endpoint {
                use std::{os::unix::net::UnixStream, path::Path};

                let stream = UnixStream::connect(Path::new(endpoint))?;
                let input = stream.try_clone()?;
                (Box::new(input), Box::new(stream))
            } else {
                // fd3/4 仅承载 Host 的 framed protocol，Session 文件始终由 Host 读取。
                let input = unsafe { File::from_raw_fd(3) };
                let output = unsafe { File::from_raw_fd(4) };
                (Box::new(input), Box::new(output))
            };
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
