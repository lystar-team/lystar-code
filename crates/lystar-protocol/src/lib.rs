mod b3;
mod framing;
mod read_only;

#[allow(dead_code, clippy::all)]
mod generated;

pub use b3::{B3Command, B3Result};

pub use framing::{
    ClientMessage, FieldPresence, FrameDecoder, MAX_FRAME_LENGTH, MessageDiagnostic, ProtocolError,
    ServerMessage, decode_client_message, decode_server_message, encode_abort_operation_request,
    encode_acquire_session_request, encode_b3_request, encode_client_hello, encode_queue_request,
    encode_read_transcript_request, encode_search_transcript_request, encode_ui_response,
};

pub use read_only::{
    MAX_PROGRESS_PREVIEW_BYTES, ModelRef, OperationSnapshot, ReadOnlyEvent, ReadOnlyMessage,
    ReadOnlyResponse, SessionProgress, SessionSnapshot, ToolCall, TranscriptItem, TranscriptPage,
    TranscriptRequestContext, TranscriptSearchHit, TranscriptSearchResult, TranscriptViewItem,
    UsageProgress,
};
