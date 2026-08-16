use std::fmt;

use ciborium::{de::from_reader, ser::into_writer, value::Value};
use serde::{Serialize, de::DeserializeOwned};
use thiserror::Error;

use crate::generated::{
    ClientMessage as GeneratedClientMessage, ServerMessage as GeneratedServerMessage,
    ServerMessageVariant2,
};

pub const MAX_FRAME_LENGTH: usize = 16 * 1024 * 1024;
const GUI_PROTOCOL_VERSION: u64 = 1;

/// CBOR map field state. Typify maps an omitted optional field and an explicit null to None.
#[derive(Debug, PartialEq, Eq)]
pub enum FieldPresence {
    Missing,
    Null,
    Value,
}

/// Read-only message metadata suitable for diagnostics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageDiagnostic {
    message_kind: String,
    protocol_version: Option<u64>,
}

impl MessageDiagnostic {
    pub fn message_kind(&self) -> &str {
        &self.message_kind
    }

    pub fn protocol_version(&self) -> Option<u64> {
        self.protocol_version
    }
}

#[derive(Debug)]
struct DecodedMessage<T> {
    #[allow(dead_code)]
    typed: T,
    raw: Value,
}

impl<T> DecodedMessage<T> {
    fn presence(&self, path: &[&str]) -> FieldPresence {
        let mut current = &self.raw;
        for key in path {
            let Value::Map(entries) = current else {
                return FieldPresence::Missing;
            };
            let Some((_, next)) = entries
                .iter()
                .find(|(candidate, _)| matches!(candidate, Value::Text(text) if text == key))
            else {
                return FieldPresence::Missing;
            };
            current = next;
        }
        if matches!(current, Value::Null) {
            FieldPresence::Null
        } else {
            FieldPresence::Value
        }
    }

    fn message_kind(&self) -> &str {
        top_level_text(&self.raw, "type").expect("validated message has a type")
    }

    fn protocol_version(&self) -> Option<u64> {
        top_level_u64(&self.raw, "protocolVersion").or_else(|| top_level_u64(&self.raw, "version"))
    }

    fn diagnostic(&self) -> MessageDiagnostic {
        MessageDiagnostic {
            message_kind: self.message_kind().to_owned(),
            protocol_version: self.protocol_version(),
        }
    }
}

pub struct ClientMessage(DecodedMessage<GeneratedClientMessage>);

impl fmt::Debug for ClientMessage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClientMessage")
            .field("diagnostic", &self.diagnostic())
            .finish()
    }
}

impl ClientMessage {
    pub fn presence(&self, path: &[&str]) -> FieldPresence {
        self.0.presence(path)
    }

    pub fn message_kind(&self) -> &str {
        self.0.message_kind()
    }

    pub fn protocol_version(&self) -> Option<u64> {
        self.0.protocol_version()
    }

    pub fn diagnostic(&self) -> MessageDiagnostic {
        self.0.diagnostic()
    }

    pub fn value(&self) -> &Value {
        &self.0.raw
    }
}

pub struct ServerMessage(DecodedMessage<GeneratedServerMessage>);

impl fmt::Debug for ServerMessage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ServerMessage")
            .field("diagnostic", &self.diagnostic())
            .finish()
    }
}

impl ServerMessage {
    pub fn presence(&self, path: &[&str]) -> FieldPresence {
        self.0.presence(path)
    }

    pub fn message_kind(&self) -> &str {
        self.0.message_kind()
    }

    pub fn protocol_version(&self) -> Option<u64> {
        self.0.protocol_version()
    }

    pub fn diagnostic(&self) -> MessageDiagnostic {
        self.0.diagnostic()
    }

    pub(crate) fn json(&self) -> Result<serde_json::Value, ProtocolError> {
        serde_json::to_value(&self.0.raw)
            .map_err(|error| ProtocolError::InvalidCbor(error.to_string()))
    }

    pub(crate) fn generated(&self) -> &GeneratedServerMessage {
        &self.0.typed
    }

    pub fn value(&self) -> &Value {
        &self.0.raw
    }
}

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

fn encode_frame<T: Serialize>(message: &T) -> Result<Vec<u8>, ProtocolError> {
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

pub fn encode_client_message(message: &ClientMessage) -> Result<Vec<u8>, ProtocolError> {
    encode_frame(&message.0.raw)
}

pub fn decode_client_message(payload: &[u8]) -> Result<ClientMessage, ProtocolError> {
    decode_message(payload, validate_client_message).map(ClientMessage)
}

pub fn decode_server_message(payload: &[u8]) -> Result<ServerMessage, ProtocolError> {
    decode_message(payload, validate_server_message).map(ServerMessage)
}

pub fn encode_client_hello(client_instance_id: &str) -> Result<Vec<u8>, ProtocolError> {
    encode_client_value(serde_json::json!({
        "type": "hello",
        "version": GUI_PROTOCOL_VERSION,
        "clientInstanceId": client_instance_id,
    }))
}

pub fn encode_read_transcript_request(
    id: &str,
    session_path: &str,
    limit: u64,
    cursor: Option<&str>,
    context: Option<&crate::TranscriptRequestContext>,
) -> Result<Vec<u8>, ProtocolError> {
    let mut request = serde_json::json!({
        "command": "read_transcript",
        "sessionPath": session_path,
        "limit": limit,
    });
    if let Some(cursor) = cursor {
        request["cursor"] = serde_json::Value::String(cursor.to_owned());
    }
    if let Some(context) = context {
        let mut value = serde_json::Map::new();
        if let Some(generation) = &context.generation {
            value.insert(
                "generation".to_owned(),
                serde_json::Value::String(generation.clone()),
            );
        }
        if let Some(revision) = context.revision {
            value.insert("revision".to_owned(), serde_json::Value::from(revision));
        }
        if let Some(cursor) = &context.cursor {
            value.insert(
                "cursor".to_owned(),
                serde_json::Value::String(cursor.clone()),
            );
        }
        request["context"] = serde_json::Value::Object(value);
    }
    encode_client_value(serde_json::json!({ "type": "request", "id": id, "request": request }))
}

pub fn encode_search_transcript_request(
    id: &str,
    session_path: &str,
    query: &str,
    limit: u64,
) -> Result<Vec<u8>, ProtocolError> {
    encode_client_value(serde_json::json!({
        "type": "request",
        "id": id,
        "request": { "command": "search_transcript", "sessionPath": session_path, "query": query, "limit": limit },
    }))
}

pub fn encode_acquire_session_request(
    id: &str,
    session_path: &str,
    client_instance_id: &str,
) -> Result<Vec<u8>, ProtocolError> {
    encode_client_value(serde_json::json!({
        "type": "request", "id": id,
        "request": { "command": "acquire_session", "sessionPath": session_path, "clientInstanceId": client_instance_id },
    }))
}

pub fn encode_queue_request(
    id: &str,
    command: &str,
    session_path: &str,
    lease_id: &str,
    client_instance_id: &str,
    client_request_id: &str,
    text: Option<&str>,
) -> Result<Vec<u8>, ProtocolError> {
    let mut request = serde_json::json!({
        "command": command,
        "sessionPath": session_path,
        "leaseId": lease_id,
        "clientInstanceId": client_instance_id,
        "clientRequestId": client_request_id,
    });
    if let Some(text) = text {
        request["text"] = serde_json::Value::String(text.to_owned());
    }
    encode_client_value(serde_json::json!({ "type": "request", "id": id, "request": request }))
}

pub fn encode_abort_operation_request(
    id: &str,
    operation_id: &str,
    lease_id: &str,
) -> Result<Vec<u8>, ProtocolError> {
    encode_client_value(serde_json::json!({
        "type": "request", "id": id,
        "request": { "command": "abort_operation", "operationId": operation_id, "leaseId": lease_id },
    }))
}

fn encode_client_value(value: serde_json::Value) -> Result<Vec<u8>, ProtocolError> {
    let cbor = serde_json::from_value(value)
        .map_err(|error| ProtocolError::InvalidCbor(error.to_string()))?;
    encode_client_message(&new_client_message(cbor)?)
}

pub fn new_client_message(raw: Value) -> Result<ClientMessage, ProtocolError> {
    decode_raw_message(raw, validate_client_message).map(ClientMessage)
}

fn decode_message<T: DeserializeOwned>(
    payload: &[u8],
    validate: impl FnOnce(&T) -> Result<(), ProtocolError>,
) -> Result<DecodedMessage<T>, ProtocolError> {
    let raw = decode_payload(payload)?;
    decode_raw_message(raw, validate)
}

fn decode_raw_message<T: DeserializeOwned>(
    raw: Value,
    validate: impl FnOnce(&T) -> Result<(), ProtocolError>,
) -> Result<DecodedMessage<T>, ProtocolError> {
    let mut encoded = Vec::new();
    into_writer(&raw, &mut encoded)
        .map_err(|error| ProtocolError::InvalidCbor(error.to_string()))?;
    let typed = decode_payload(&encoded)?;
    validate(&typed)?;
    Ok(DecodedMessage { typed, raw })
}

fn decode_payload<T: DeserializeOwned>(payload: &[u8]) -> Result<T, ProtocolError> {
    from_reader(payload).map_err(|error| ProtocolError::InvalidCbor(error.to_string()))
}

fn top_level_text<'a>(raw: &'a Value, name: &str) -> Option<&'a str> {
    let Value::Map(entries) = raw else {
        return None;
    };
    entries.iter().find_map(|(key, value)| match (key, value) {
        (Value::Text(key), Value::Text(value)) if key == name => Some(value.as_str()),
        _ => None,
    })
}

fn top_level_u64(raw: &Value, name: &str) -> Option<u64> {
    let Value::Map(entries) = raw else {
        return None;
    };
    entries.iter().find_map(|(key, value)| match (key, value) {
        (Value::Text(key), Value::Integer(value)) if key == name => u64::try_from(*value).ok(),
        _ => None,
    })
}

fn validate_client_message(message: &GeneratedClientMessage) -> Result<(), ProtocolError> {
    if let GeneratedClientMessage::Hello { version, .. } = message
        && *version != GUI_PROTOCOL_VERSION
    {
        return Err(invalid_message("client", "unsupported protocol version"));
    }
    Ok(())
}

fn validate_server_message(message: &GeneratedServerMessage) -> Result<(), ProtocolError> {
    match message {
        GeneratedServerMessage::Variant0 {
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
        GeneratedServerMessage::Variant1 { type_, .. } if type_ != "hello_error" => {
            return Err(invalid_message("server", "unknown message variant"));
        }
        GeneratedServerMessage::Variant2(response) => match response {
            ServerMessageVariant2::Variant0 { type_, ok, .. } if type_ == "response" && *ok => {}
            ServerMessageVariant2::Variant1 { type_, ok, .. } if type_ == "response" && !*ok => {}
            _ => return Err(invalid_message("server", "invalid response variant")),
        },
        GeneratedServerMessage::Variant3 { type_, .. } if type_ != "event" => {
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
        if self.pending.len() < 4 && self.pending.len() + chunk.len() >= 4 {
            let mut prefix = [0_u8; 4];
            let pending_len = self.pending.len();
            prefix[..pending_len].copy_from_slice(&self.pending);
            prefix[pending_len..].copy_from_slice(&chunk[..4 - pending_len]);
            if u32::from_be_bytes(prefix) as usize > MAX_FRAME_LENGTH {
                self.failed = true;
                return Err(ProtocolError::FrameTooLarge);
            }
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
    use crate::generated::ClientMessageRequest;
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
    fn generated_types_are_checked_only_inside_the_crate() {
        let request = decode_client_message(&client_payload(json!({
            "type":"request", "id":"request-1",
            "request":{"command":"read_transcript", "sessionPath":"/tmp/session", "limit":20}
        })))
        .unwrap();
        assert!(matches!(
            request.0.typed,
            GeneratedClientMessage::Request {
                request: ClientMessageRequest::ReadTranscript { cursor: None, .. },
                ..
            }
        ));

        let null_value = decode_client_message(&client_payload(
            json!({"type":"ui_response", "id":"ui-1", "value":null}),
        ))
        .unwrap();
        assert!(matches!(
            null_value.0.typed,
            GeneratedClientMessage::UiResponse { value: None, .. }
        ));
        assert_eq!(null_value.presence(&["value"]), FieldPresence::Null);
    }

    #[test]
    fn public_wrapper_preserves_presence_and_diagnostics() {
        let request = decode_client_message(&client_payload(json!({
            "type":"request", "id":"request-1",
            "request":{"command":"read_transcript", "sessionPath":"/tmp/session", "limit":20}
        })))
        .unwrap();
        assert_eq!(
            request.presence(&["request", "cursor"]),
            FieldPresence::Missing
        );
        assert_eq!(request.message_kind(), "request");
        assert_eq!(request.protocol_version(), None);
        assert_eq!(request.diagnostic().message_kind(), "request");

        let hello = decode_client_message(&client_payload(
            json!({"type":"hello", "version":1, "clientInstanceId":"client"}),
        ))
        .unwrap();
        assert_eq!(hello.protocol_version(), Some(1));
        assert_eq!(hello.diagnostic().protocol_version(), Some(1));
        assert!(!format!("{hello:?}").contains("raw"));
        assert!(!format!("{hello:?}").contains("typed"));

        let value = decode_client_message(&client_payload(
            json!({"type":"ui_response", "id":"ui-2", "value":{"answer":true}}),
        ))
        .unwrap();
        assert_eq!(value.presence(&["value"]), FieldPresence::Value);

        let encoded = encode_client_message(&value).unwrap();
        assert_eq!(
            decode_client_message(&encoded[4..])
                .unwrap()
                .presence(&["value"]),
            FieldPresence::Value
        );
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
