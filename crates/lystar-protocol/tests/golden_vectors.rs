use std::fs;

use lystar_protocol::{FrameDecoder, decode_client_message, decode_server_message, encode_frame};

#[test]
fn typescript_and_rust_golden_frames_round_trip_as_generated_types() {
    let directory = format!("{}/tests/fixtures", env!("CARGO_MANIFEST_DIR"));
    for name in [
        "client-hello",
        "client-read-transcript",
        "client-ui-response",
    ] {
        let payload = decode_frame(&fs::read(format!("{directory}/ts-{name}.frame")).unwrap());
        let message = decode_client_message(&payload).unwrap();
        let rust_payload =
            decode_frame(&fs::read(format!("{directory}/rust-{name}.frame")).unwrap());
        let rust_message = decode_client_message(&rust_payload).unwrap();
        assert_eq!(
            serde_json::to_value(&rust_message).unwrap(),
            serde_json::to_value(&message).unwrap(),
            "client fixture {name}"
        );
        let round_trip =
            decode_client_message(&decode_frame(&encode_frame(&message).unwrap())).unwrap();
        assert_eq!(
            serde_json::to_value(&round_trip).unwrap(),
            serde_json::to_value(&message).unwrap(),
            "client typed re-encode {name}"
        );
    }
    for name in [
        "server-hello",
        "server-response-ok",
        "server-response-error",
        "server-event-transcript",
        "server-event-ui-request",
    ] {
        let payload = decode_frame(&fs::read(format!("{directory}/ts-{name}.frame")).unwrap());
        let message = decode_server_message(&payload).unwrap();
        let rust_payload =
            decode_frame(&fs::read(format!("{directory}/rust-{name}.frame")).unwrap());
        let rust_message = decode_server_message(&rust_payload).unwrap();
        assert_eq!(
            serde_json::to_value(&rust_message).unwrap(),
            serde_json::to_value(&message).unwrap(),
            "server fixture {name}"
        );
        let round_trip =
            decode_server_message(&decode_frame(&encode_frame(&message).unwrap())).unwrap();
        assert_eq!(
            serde_json::to_value(&round_trip).unwrap(),
            serde_json::to_value(&message).unwrap(),
            "server typed re-encode {name}"
        );
    }
}

fn decode_frame(frame: &[u8]) -> Vec<u8> {
    let mut decoder = FrameDecoder::default();
    let payload = decoder.push(frame).unwrap().pop().unwrap();
    decoder.end().unwrap();
    payload
}
