use std::fs;

use lystar_protocol::{FieldPresence, FrameDecoder, decode_client_message, decode_server_message};

#[test]
fn typescript_and_rust_golden_frames_round_trip_through_public_wrappers() {
    let directory = format!("{}/tests/fixtures", env!("CARGO_MANIFEST_DIR"));
    for name in [
        "client-hello",
        "client-read-transcript",
        "client-search-transcript",
        "client-ui-response-missing",
        "client-ui-response-null",
        "client-ui-response-value",
    ] {
        let payload = decode_frame(&fs::read(format!("{directory}/ts-{name}.frame")).unwrap());
        let message = decode_client_message(&payload).unwrap();
        let rust_payload =
            decode_frame(&fs::read(format!("{directory}/rust-{name}.frame")).unwrap());
        let rust_message = decode_client_message(&rust_payload).unwrap();
        assert_eq!(
            rust_message.message_kind(),
            message.message_kind(),
            "client fixture {name}"
        );
        assert_eq!(
            rust_message.protocol_version(),
            message.protocol_version(),
            "client fixture {name}"
        );
        let round_trip = decode_client_message(&payload).unwrap();
        assert_eq!(
            round_trip.message_kind(),
            message.message_kind(),
            "client round trip {name}"
        );
        assert_presence(name, &message);
    }
    for name in [
        "server-hello",
        "server-response-ok",
        "server-response-error",
        "server-response-error-null",
        "server-response-error-missing",
        "server-event-transcript",
        "server-event-ui-request",
        "server-event-operation-missing",
        "server-event-operation-value",
    ] {
        let payload = decode_frame(&fs::read(format!("{directory}/ts-{name}.frame")).unwrap());
        let message = decode_server_message(&payload)
            .unwrap_or_else(|error| panic!("typescript server fixture {name}: {error}"));
        let rust_payload =
            decode_frame(&fs::read(format!("{directory}/rust-{name}.frame")).unwrap());
        let rust_message = decode_server_message(&rust_payload)
            .unwrap_or_else(|error| panic!("server fixture {name}: {error}"));
        assert_eq!(
            rust_message.message_kind(),
            message.message_kind(),
            "server fixture {name}"
        );
        assert_eq!(
            rust_message.protocol_version(),
            message.protocol_version(),
            "server fixture {name}"
        );
        let round_trip = decode_server_message(&payload).unwrap();
        assert_eq!(
            round_trip.message_kind(),
            message.message_kind(),
            "server round trip {name}"
        );
        assert_presence(name, &message);
    }
}

fn assert_presence(name: &str, message: &impl HasPresence) {
    let (path, expected) = match name {
        "client-ui-response-missing" => (&["value"][..], FieldPresence::Missing),
        "client-ui-response-null" => (&["value"][..], FieldPresence::Null),
        "client-ui-response-value" => (&["value"][..], FieldPresence::Value),
        "server-response-error" => (&["error", "details"][..], FieldPresence::Value),
        "server-response-error-null" => (&["error", "details"][..], FieldPresence::Null),
        "server-response-error-missing" => (&["error", "details"][..], FieldPresence::Missing),
        "server-event-operation-missing" => (
            &["event", "operation", "progress"][..],
            FieldPresence::Missing,
        ),
        "server-event-operation-value" => (
            &["event", "operation", "progress"][..],
            FieldPresence::Value,
        ),
        _ => return,
    };
    assert_eq!(message.presence(path), expected, "{name}");
    if name.starts_with("server-event-operation-") {
        assert_eq!(
            message.presence(&["event", "operation", "result"]),
            expected,
            "{name}"
        );
    }
}

trait HasPresence {
    fn presence(&self, path: &[&str]) -> FieldPresence;
}

impl HasPresence for lystar_protocol::ClientMessage {
    fn presence(&self, path: &[&str]) -> FieldPresence {
        self.presence(path)
    }
}

impl HasPresence for lystar_protocol::ServerMessage {
    fn presence(&self, path: &[&str]) -> FieldPresence {
        self.presence(path)
    }
}

fn decode_frame(frame: &[u8]) -> Vec<u8> {
    let mut decoder = FrameDecoder::default();
    let payload = decoder.push(frame).unwrap().pop().unwrap();
    decoder.end().unwrap();
    payload
}
