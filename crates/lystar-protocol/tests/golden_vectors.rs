use std::fs;

use lystar_protocol::{FrameDecoder, decode_client_message, decode_server_message};

#[test]
fn decodes_typescript_golden_frames() {
    let directory = format!("{}/tests/fixtures", env!("CARGO_MANIFEST_DIR"));
    let client = fs::read(format!("{directory}/ts-client-hello.frame")).unwrap();
    let server = fs::read(format!("{directory}/ts-server-hello.frame")).unwrap();
    let mut decoder = FrameDecoder::default();
    let client_payload = decoder.push(&client[..5]).unwrap();
    assert!(client_payload.is_empty());
    let client_payload = decoder.push(&client[5..]).unwrap().pop().unwrap();
    assert_eq!(
        decode_client_message(&client_payload).unwrap()["type"],
        "hello"
    );
    let mut decoder = FrameDecoder::default();
    let server_payload = decoder.push(&server).unwrap().pop().unwrap();
    assert_eq!(
        decode_server_message(&server_payload).unwrap()["protocolVersion"],
        1
    );
}
