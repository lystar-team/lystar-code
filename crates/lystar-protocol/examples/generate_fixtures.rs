use std::fs;

use lystar_protocol::encode_frame;
use serde_json::json;

fn main() {
    let directory = format!("{}/tests/fixtures", env!("CARGO_MANIFEST_DIR"));
    fs::create_dir_all(&directory).unwrap();
    fs::write(
        format!("{directory}/rust-client-hello.frame"),
        encode_frame(&json!({"type":"hello", "version":1, "clientInstanceId":"rust-spike-client"}))
            .unwrap(),
    )
    .unwrap();
    fs::write(
        format!("{directory}/rust-server-hello.frame"),
        encode_frame(&json!({
            "type":"hello",
            "version":1,
            "productVersion":"rust-spike",
            "protocolVersion":1,
            "serverInstanceId":"rust-host",
            "hostInstanceId":"rust-host",
            "hostStartedAt":0,
            "capabilities":["session-paging"],
        }))
        .unwrap(),
    )
    .unwrap();
}
