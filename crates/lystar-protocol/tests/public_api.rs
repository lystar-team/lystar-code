use std::fs;

#[test]
fn public_api_exposes_only_opaque_checked_message_wrappers() {
    let exports = include_str!("../src/lib.rs");
    assert!(exports.contains("ClientMessage"));
    assert!(exports.contains("ServerMessage"));
    assert!(exports.contains("encode_client_message"));
    assert!(exports.contains("encode_server_message"));
    assert!(!exports.contains("DecodedMessage"));
    assert!(!exports.contains("pub use generated"));
    assert!(!exports.contains("pub mod generated"));

    let framing = include_str!("../src/framing.rs");
    assert!(framing.contains("struct DecodedMessage"));
    assert!(!framing.contains("pub struct DecodedMessage"));
    assert!(framing.contains("fn encode_frame"));
    assert!(!framing.contains("pub fn encode_frame"));
    assert!(!framing.contains("impl<T> Serialize for DecodedMessage"));
}

#[test]
fn generated_types_have_no_public_wire_encoding_path() {
    let manifest =
        fs::read_to_string(format!("{}/src/lib.rs", env!("CARGO_MANIFEST_DIR"))).unwrap();
    assert!(!manifest.contains("pub mod generated"));
    assert!(!manifest.contains("pub use generated"));
}
