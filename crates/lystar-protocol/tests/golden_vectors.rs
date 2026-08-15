use std::fs;

use lystar_protocol::{
    DecodedMessage, FieldPresence, FrameDecoder, decode_client_message, decode_server_message,
    encode_client_message, encode_server_message,
};

#[test]
fn typescript_and_rust_golden_frames_round_trip_as_generated_types() {
    let directory = format!("{}/tests/fixtures", env!("CARGO_MANIFEST_DIR"));
    for name in [
        "client-hello",
        "client-read-transcript",
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
            serde_json::to_value(rust_message.typed()).unwrap(),
            serde_json::to_value(message.typed()).unwrap(),
            "client fixture {name}"
        );
        assert_eq!(
            encode_client_message(&message).unwrap(),
            fs::read(format!("{directory}/ts-{name}.frame")).unwrap()
        );
        let round_trip =
            decode_client_message(&decode_frame(&encode_client_message(&message).unwrap()))
                .unwrap();
        assert_eq!(
            serde_json::to_value(round_trip.typed()).unwrap(),
            serde_json::to_value(message.typed()).unwrap(),
            "client typed re-encode {name}"
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
        "server-event-operation-null",
        "server-event-operation-value",
    ] {
        let payload = decode_frame(&fs::read(format!("{directory}/ts-{name}.frame")).unwrap());
        let message = decode_server_message(&payload).unwrap();
        let rust_payload =
            decode_frame(&fs::read(format!("{directory}/rust-{name}.frame")).unwrap());
        let rust_message = decode_server_message(&rust_payload).unwrap();
        assert_eq!(
            serde_json::to_value(rust_message.typed()).unwrap(),
            serde_json::to_value(message.typed()).unwrap(),
            "server fixture {name}"
        );
        assert_eq!(
            encode_server_message(&message).unwrap(),
            fs::read(format!("{directory}/ts-{name}.frame")).unwrap()
        );
        let round_trip =
            decode_server_message(&decode_frame(&encode_server_message(&message).unwrap()))
                .unwrap();
        assert_eq!(
            serde_json::to_value(round_trip.typed()).unwrap(),
            serde_json::to_value(message.typed()).unwrap(),
            "server typed re-encode {name}"
        );
        assert_presence(name, &message);
    }
}

fn assert_presence<T>(name: &str, message: &DecodedMessage<T>) {
    let (path, expected) = match name {
        "client-ui-response-missing" => (&["value"][..], "missing"),
        "client-ui-response-null" => (&["value"][..], "null"),
        "client-ui-response-value" => (&["value"][..], "value"),
        "server-response-error" => (&["error", "details"][..], "value"),
        "server-response-error-null" => (&["error", "details"][..], "null"),
        "server-response-error-missing" => (&["error", "details"][..], "missing"),
        "server-event-operation-missing" => (&["event", "operation", "progress"][..], "missing"),
        "server-event-operation-null" => (&["event", "operation", "progress"][..], "null"),
        "server-event-operation-value" => (&["event", "operation", "progress"][..], "value"),
        _ => return,
    };
    assert_presence_at(name, message, path, expected);
    if name.starts_with("server-event-operation-") {
        assert_presence_at(name, message, &["event", "operation", "result"], expected);
    }
}

fn assert_presence_at<T>(
    name: &str,
    message: &lystar_protocol::DecodedMessage<T>,
    path: &[&str],
    expected: &str,
) {
    match expected {
        "missing" => assert!(
            matches!(message.presence(path), FieldPresence::Missing),
            "{name}"
        ),
        "null" => assert!(
            matches!(message.presence(path), FieldPresence::Null),
            "{name}"
        ),
        "value" => assert!(
            matches!(message.presence(path), FieldPresence::Value(_)),
            "{name}"
        ),
        _ => unreachable!(),
    }
}

fn decode_frame(frame: &[u8]) -> Vec<u8> {
    let mut decoder = FrameDecoder::default();
    let payload = decoder.push(frame).unwrap().pop().unwrap();
    decoder.end().unwrap();
    payload
}
