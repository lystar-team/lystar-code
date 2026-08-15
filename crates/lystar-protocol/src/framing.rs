use ciborium::{de::from_reader, ser::into_writer};
use serde_json::{Map, Value};
use thiserror::Error;

pub const MAX_FRAME_LENGTH: usize = 16 * 1024 * 1024;

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

pub fn encode_frame(value: &Value) -> Result<Vec<u8>, ProtocolError> {
    let mut payload = Vec::new();
    into_writer(value, &mut payload)
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

pub fn decode_client_message(payload: &[u8]) -> Result<Value, ProtocolError> {
    let value = decode_payload(payload)?;
    validate_hello(&value, "client", false)?;
    Ok(value)
}

pub fn decode_server_message(payload: &[u8]) -> Result<Value, ProtocolError> {
    let value = decode_payload(payload)?;
    validate_hello(&value, "server", true)?;
    Ok(value)
}

fn decode_payload(payload: &[u8]) -> Result<Value, ProtocolError> {
    from_reader(payload).map_err(|error| ProtocolError::InvalidCbor(error.to_string()))
}

fn validate_hello(
    value: &Value,
    direction: &'static str,
    server: bool,
) -> Result<(), ProtocolError> {
    let object = value
        .as_object()
        .ok_or_else(|| ProtocolError::InvalidMessage {
            direction,
            reason: "message must be an object".to_owned(),
        })?;
    let message_type = object.get("type").and_then(Value::as_str).ok_or_else(|| {
        ProtocolError::InvalidMessage {
            direction,
            reason: "missing type".to_owned(),
        }
    })?;
    if message_type != "hello" {
        return Ok(());
    }
    let allowed = if server {
        [
            "type",
            "version",
            "productVersion",
            "protocolVersion",
            "serverInstanceId",
            "hostInstanceId",
            "hostStartedAt",
            "capabilities",
        ]
    } else {
        [
            "type",
            "version",
            "clientInstanceId",
            "request",
            "id",
            "value",
            "confirmed",
            "cancelled",
        ]
    };
    reject_unknown_fields(object, &allowed, direction)?;
    let version = object
        .get("version")
        .and_then(Value::as_u64)
        .ok_or_else(|| ProtocolError::InvalidMessage {
            direction,
            reason: "hello version must be an integer".to_owned(),
        })?;
    if server && version != 1 {
        return Err(ProtocolError::InvalidMessage {
            direction,
            reason: "unsupported protocol version".to_owned(),
        });
    }
    if !server
        && object
            .get("clientInstanceId")
            .and_then(Value::as_str)
            .is_none()
    {
        return Err(ProtocolError::InvalidMessage {
            direction,
            reason: "hello requires clientInstanceId".to_owned(),
        });
    }
    Ok(())
}

fn reject_unknown_fields(
    object: &Map<String, Value>,
    allowed: &[&str],
    direction: &'static str,
) -> Result<(), ProtocolError> {
    if let Some(field) = object
        .keys()
        .find(|field| !allowed.contains(&field.as_str()))
    {
        return Err(ProtocolError::InvalidMessage {
            direction,
            reason: format!("unknown field {field}"),
        });
    }
    Ok(())
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
    use serde_json::json;

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
    fn rejects_truncated_frames_and_unknown_hello_fields() {
        let mut decoder = FrameDecoder::default();
        decoder.push(&[0, 0, 0, 1]).unwrap();
        assert_eq!(decoder.end().unwrap_err(), ProtocolError::TruncatedFrame);
        let payload = encode_frame(
            &json!({"type":"hello", "version":1, "clientInstanceId":"client", "extra":true}),
        )
        .unwrap();
        let mut decoder = FrameDecoder::default();
        let frame = decoder.push(&payload).unwrap().pop().unwrap();
        assert!(matches!(
            decode_client_message(&frame),
            Err(ProtocolError::InvalidMessage { .. })
        ));
    }
}
