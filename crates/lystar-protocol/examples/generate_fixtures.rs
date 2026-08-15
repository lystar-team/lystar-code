use std::fs;

use lystar_protocol::{
    FrameDecoder, decode_client_message, decode_server_message, encode_frame,
    generated::{ClientMessage, ServerMessage},
};

fn main() {
    let directory = format!("{}/tests/fixtures", env!("CARGO_MANIFEST_DIR"));
    for name in [
        "client-hello",
        "client-read-transcript",
        "client-ui-response",
    ] {
        let message = decode_client_fixture(&directory, name);
        write_client_fixture(&directory, name, &message);
    }
    for name in [
        "server-hello",
        "server-response-ok",
        "server-response-error",
        "server-event-transcript",
        "server-event-ui-request",
    ] {
        let message = decode_server_fixture(&directory, name);
        write_server_fixture(&directory, name, &message);
    }
}

fn decode_client_fixture(directory: &str, name: &str) -> ClientMessage {
    let payload = decode_frame(&fs::read(format!("{directory}/ts-{name}.frame")).unwrap());
    decode_client_message(&payload).unwrap()
}

fn decode_server_fixture(directory: &str, name: &str) -> ServerMessage {
    let payload = decode_frame(&fs::read(format!("{directory}/ts-{name}.frame")).unwrap());
    decode_server_message(&payload).unwrap()
}

fn write_client_fixture(directory: &str, name: &str, message: &ClientMessage) {
    let path = format!("{directory}/rust-{name}.frame");
    if fs::read(&path)
        .ok()
        .and_then(|frame| decode_existing_client(&frame))
        .is_some_and(|existing| {
            serde_json::to_value(existing).unwrap() == serde_json::to_value(message).unwrap()
        })
    {
        return;
    }
    fs::write(path, encode_frame(message).unwrap()).unwrap();
}

fn write_server_fixture(directory: &str, name: &str, message: &ServerMessage) {
    let path = format!("{directory}/rust-{name}.frame");
    if fs::read(&path)
        .ok()
        .and_then(|frame| decode_existing_server(&frame))
        .is_some_and(|existing| {
            serde_json::to_value(existing).unwrap() == serde_json::to_value(message).unwrap()
        })
    {
        return;
    }
    fs::write(path, encode_frame(message).unwrap()).unwrap();
}

fn decode_existing_client(frame: &[u8]) -> Option<ClientMessage> {
    decode_client_message(&decode_frame(frame)).ok()
}

fn decode_existing_server(frame: &[u8]) -> Option<ServerMessage> {
    decode_server_message(&decode_frame(frame)).ok()
}

fn decode_frame(frame: &[u8]) -> Vec<u8> {
    let mut decoder = FrameDecoder::default();
    let payload = decoder.push(frame).unwrap().pop().unwrap();
    decoder.end().unwrap();
    payload
}
