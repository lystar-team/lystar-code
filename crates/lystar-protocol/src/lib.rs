pub mod framing;

#[allow(clippy::all)]
pub mod generated;

pub use framing::{
    DecodedMessage, FieldPresence, FrameDecoder, MAX_FRAME_LENGTH, ProtocolError,
    decode_client_message, decode_server_message, encode_frame, new_client_message,
    new_server_message,
};
