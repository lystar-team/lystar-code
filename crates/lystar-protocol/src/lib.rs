pub mod framing;

#[allow(dead_code, clippy::all)]
mod generated;

pub use framing::{
    DecodedMessage, FieldPresence, FrameDecoder, MAX_FRAME_LENGTH, ProtocolError,
    decode_client_message, decode_server_message, encode_client_message, encode_server_message,
    new_client_message, new_server_message,
};
pub use generated::{ClientMessage, ClientMessageRequest, ServerMessage, ServerMessageVariant2};
