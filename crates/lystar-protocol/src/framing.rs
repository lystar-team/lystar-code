use ciborium::{de::from_reader, ser::into_writer};
use serde::{Serialize, de::DeserializeOwned};
use thiserror::Error;

use crate::generated::{ClientMessage, ServerMessage, ServerMessageVariant2};

pub const MAX_FRAME_LENGTH: usize = 16 * 1024 * 1024;
const GUI_PROTOCOL_VERSION: u64 = 1;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("frame length exceeds 16 MiB")]
    FrameTooLarge,
    #[error("truncated frame")]
    TruncatedFrame,
    #[error("decoder has failed")]
    DecoderFailed,
    #[error("invalid CBOR payload: {0}")]
    InvalidCbor(String),
    #[error("invalid {direction} message: {reason}")]
    InvalidMessage {
        direction: &'static str,
        reason: String,
    },
}

pub fn encode_frame<T: Serialize>(message: &T) -> Result<Vec<u8>, ProtocolError> {
    let mut payload = Vec::new();
    into_writer(message, &mut payload)
        .map_err(|error| ProtocolError::InvalidCbor(error.to_string()))?;
    if payload.len() > MAX_FRAME_LENGTH {
        return Err(ProtocolError::FrameTooLarge);
    }
    let length = u32::try_from(payload.len()).map_err(|_| ProtocolError::FrameTooLarge)?;
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

pub fn decode_client_message(payload: &[u8]) -> Result<ClientMessage, ProtocolError> {
    let message = decode_payload(payload)?;
    validate_client_message(&message)?;
    Ok(message)
}

pub fn decode_server_message(payload: &[u8]) -> Result<ServerMessage, ProtocolError> {
    let message = decode_payload(payload)?;
    validate_server_message(&message)?;
    Ok(message)
}

fn decode_payload<T: DeserializeOwned>(payload: &[u8]) -> Result<T, ProtocolError> {
    from_reader(payload).map_err(|error| ProtocolError::InvalidCbor(error.to_string()))
}

fn validate_client_message(message: &ClientMessage) -> Result<(), ProtocolError> {
    if let ClientMessage::Hello { version, .. } = message
        && *version != GUI_PROTOCOL_VERSION
    {
        return Err(invalid_message("client", "unsupported protocol version"));
    }
    Ok(())
}

fn validate_server_message(message: &ServerMessage) -> Result<(), ProtocolError> {
    match message {
        ServerMessage::Variant0 {
            type_,
            version,
            protocol_version,
            ..
        } => {
            if type_ != "hello" {
                return Err(invalid_message("server", "unknown message variant"));
            }
            if *version != GUI_PROTOCOL_VERSION as i64
                || *protocol_version != GUI_PROTOCOL_VERSION as i64
            {
                return Err(invalid_message("server", "unsupported protocol version"));
            }
        }
        ServerMessage::Variant1 { type_, .. } if type_ != "hello_error" => {
            return Err(invalid_message("server", "unknown message variant"));
        }
        ServerMessage::Variant2(response) => match response {
            ServerMessageVariant2::Variant0 { type_, ok, .. } if type_ == "response" && *ok => {}
            ServerMessageVariant2::Variant1 { type_, ok, .. } if type_ == "response" && !*ok => {}
            _ => return Err(invalid_message("server", "invalid response variant")),
        },
        ServerMessage::Variant3 { type_, .. } if type_ != "event" => {
            return Err(invalid_message("server", "unknown message variant"));
        }
        _ => {}
    }
    Ok(())
}

fn invalid_message(direction: &'static str, reason: impl Into<String>) -> ProtocolError {
    ProtocolError::InvalidMessage {
        direction,
        reason: reason.into(),
    }
}

#[derive(Debug, Default)]
pub struct FrameDecoder {
    pending: Vec<u8>,
    failed: bool,
}

impl FrameDecoder {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Vec<u8>>, ProtocolError> {
        if self.failed {
            return Err(ProtocolError::DecoderFailed);
        }
        self.pending.extend_from_slice(chunk);
        let mut frames = Vec::new();
        loop {
            if self.pending.len() < 4 {
                return Ok(frames);
            }
            let length =
                u32::from_be_bytes(self.pending[..4].try_into().expect("prefix is four bytes"))
                    as usize;
            if length > MAX_FRAME_LENGTH {
                self.failed = true;
                return Err(ProtocolError::FrameTooLarge);
            }
            let frame_end = 4 + length;
            if self.pending.len() < frame_end {
                return Ok(frames);
            }
            frames.push(self.pending[4..frame_end].to_vec());
            self.pending.drain(..frame_end);
        }
    }

    pub fn end(&mut self) -> Result<(), ProtocolError> {
        if self.failed {
            return Err(ProtocolError::DecoderFailed);
        }
        if self.pending.is_empty() {
            Ok(())
        } else {
            self.failed = true;
            Err(ProtocolError::TruncatedFrame)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generated::{ClientMessage, ClientMessageRequest};
    use serde_json::json;

    fn client_payload(value: serde_json::Value) -> Vec<u8> {
        let frame = encode_frame(&value).unwrap();
        let mut decoder = FrameDecoder::default();
        decoder.push(&frame).unwrap().pop().unwrap()
    }

    #[test]
    fn incrementally_decodes_coalesced_frames() {
        let first =
            encode_frame(&json!({"type":"hello", "version": 1, "clientInstanceId":"client"}))
                .unwrap();
        let second = encode_frame(
            &json!({"type":"request", "id":"1", "request":{"command":"get_snapshot"}}),
        )
        .unwrap();
        let mut decoder = FrameDecoder::default();
        let mut wire = first;
        wire.extend(second);
        assert!(decoder.push(&wire[..7]).unwrap().is_empty());
        assert_eq!(decoder.push(&wire[7..]).unwrap().len(), 2);
        decoder.end().unwrap();
    }

    #[test]
    fn typed_decode_accepts_optional_and_null_json_value() {
        let request = decode_client_message(&client_payload(json!({
            "type":"request", "id":"request-1",
            "request":{"command":"read_transcript", "sessionPath":"/tmp/session", "limit":20}
        })))
        .unwrap();
        assert!(matches!(
            request,
            ClientMessage::Request {
                request: ClientMessageRequest::ReadTranscript { cursor: None, .. },
                ..
            }
        ));

        let null_value = decode_client_message(&client_payload(
            json!({"type":"ui_response", "id":"ui-1", "value":null}),
        ))
        .unwrap();
        // Typify maps an optional field carrying CBOR null to None; this test
        // locks the generated-type behavior so the spike cannot claim lossless null preservation.
        assert!(matches!(
            null_value,
            ClientMessage::UiResponse { value: None, .. }
        ));

        let absent_value =
            decode_client_message(&client_payload(json!({"type":"ui_response", "id":"ui-2"})))
                .unwrap();
        assert!(matches!(
            absent_value,
            ClientMessage::UiResponse { value: None, .. }
        ));
    }

    #[test]
    fn rejects_unknown_fields_unknown_variants_and_bad_hello_versions() {
        for value in [
            json!({"type":"hello", "version":1, "clientInstanceId":"client", "extra":true}),
            json!({"type":"future", "id":"1"}),
            json!({"type":"hello", "version":2, "clientInstanceId":"client"}),
        ] {
            assert!(matches!(
                decode_client_message(&client_payload(value)),
                Err(ProtocolError::InvalidCbor(_) | ProtocolError::InvalidMessage { .. })
            ));
        }
    }

    #[test]
    fn permanently_fails_after_a_too_large_frame() {
        let mut decoder = FrameDecoder::default();
        assert_eq!(
            decoder
                .push(&((MAX_FRAME_LENGTH as u32 + 1).to_be_bytes()))
                .unwrap_err(),
            ProtocolError::FrameTooLarge
        );
        assert_eq!(decoder.push(&[]).unwrap_err(), ProtocolError::DecoderFailed);
    }

    #[test]
    fn rejects_truncated_frames() {
        let mut decoder = FrameDecoder::default();
        decoder.push(&[0, 0, 0, 1]).unwrap();
        assert_eq!(decoder.end().unwrap_err(), ProtocolError::TruncatedFrame);
    }
}
