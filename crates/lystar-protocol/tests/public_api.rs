use std::fs;

#[test]
fn public_api_exposes_only_checked_message_encoders() {
    let exports = include_str!("../src/lib.rs");
    assert!(exports.contains("encode_client_message"));
    assert!(exports.contains("encode_server_message"));
    assert!(!exports.contains("encode_frame"));
    assert!(!exports.contains("pub mod generated"));

    let framing = include_str!("../src/framing.rs");
    assert!(framing.contains("fn encode_frame"));
    assert!(!framing.contains("pub fn encode_frame"));
}

#[test]
fn generated_types_are_not_a_public_wire_encoding_path() {
    let manifest =
        fs::read_to_string(format!("{}/src/lib.rs", env!("CARGO_MANIFEST_DIR"))).unwrap();
    assert!(!manifest.contains("pub mod generated"));
}
