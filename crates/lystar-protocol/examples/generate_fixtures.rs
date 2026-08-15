use std::fs;

use lystar_protocol::{
    DecodedMessage, FrameDecoder, decode_client_message, decode_server_message, encode_frame,
    generated::{ClientMessage, ServerMessage},
};

fn main() {
    let directory = format!("{}/tests/fixtures", env!("CARGO_MANIFEST_DIR"));
    for name in [
        "client-hello",
        "client-read-transcript",
        "client-ui-response-missing",
        "client-ui-response-null",
        "client-ui-response-value",
    ] {
        let message = decode_client_fixture(&directory, name);
        write_client_fixture(&directory, name, &message);
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
        let message = decode_server_fixture(&directory, name);
        write_server_fixture(&directory, name, &message);
    }
}

fn decode_client_fixture(directory: &str, name: &str) -> DecodedMessage<ClientMessage> {
    let payload = decode_frame(&fs::read(format!("{directory}/ts-{name}.frame")).unwrap());
    decode_client_message(&payload).unwrap()
}

fn decode_server_fixture(directory: &str, name: &str) -> DecodedMessage<ServerMessage> {
    let payload = decode_frame(&fs::read(format!("{directory}/ts-{name}.frame")).unwrap());
    decode_server_message(&payload).unwrap()
}

fn write_client_fixture(directory: &str, name: &str, message: &DecodedMessage<ClientMessage>) {
    let path = format!("{directory}/rust-{name}.frame");
    let encoded = encode_frame(message).unwrap();
    if fs::read(&path).ok().as_deref() == Some(encoded.as_slice()) {
        return;
    }
    fs::write(path, encoded).unwrap();
}

fn write_server_fixture(directory: &str, name: &str, message: &DecodedMessage<ServerMessage>) {
    let path = format!("{directory}/rust-{name}.frame");
    let encoded = encode_frame(message).unwrap();
    if fs::read(&path).ok().as_deref() == Some(encoded.as_slice()) {
        return;
    }
    fs::write(path, encoded).unwrap();
}

fn decode_frame(frame: &[u8]) -> Vec<u8> {
    let mut decoder = FrameDecoder::default();
    let payload = decoder.push(frame).unwrap().pop().unwrap();
    decoder.end().unwrap();
    payload
}
