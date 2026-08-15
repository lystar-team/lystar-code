pub mod framing;

#[allow(dead_code, clippy::all)]
mod generated;

pub use framing::{
    ClientMessage, FieldPresence, FrameDecoder, MAX_FRAME_LENGTH, MessageDiagnostic, ProtocolError,
    ServerMessage, decode_client_message, decode_server_message, encode_client_message,
    encode_server_message, new_client_message, new_server_message,
};
