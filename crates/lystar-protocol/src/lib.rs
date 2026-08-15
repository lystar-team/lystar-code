pub mod framing;

#[allow(clippy::all)]
pub mod generated;

pub use framing::{
    FrameDecoder, MAX_FRAME_LENGTH, ProtocolError, decode_client_message, decode_server_message,
    encode_frame,
};
