mod framing;
mod read_only;

#[allow(dead_code, clippy::all)]
mod generated;

pub use framing::{
    ClientMessage, FieldPresence, FrameDecoder, MAX_FRAME_LENGTH, MessageDiagnostic, ProtocolError,
    ServerMessage, decode_client_message, decode_server_message, encode_client_hello,
    encode_read_transcript_request, encode_search_transcript_request,
};

pub use read_only::{
    MAX_PROGRESS_PREVIEW_BYTES, ReadOnlyEvent, ReadOnlyMessage, ReadOnlyResponse, ToolCall,
    TranscriptItem, TranscriptPage, TranscriptRequestContext, TranscriptSearchHit,
    TranscriptSearchResult, TranscriptViewItem,
};
