use std::fs;

#[test]
fn public_api_exposes_typed_read_only_projections_without_generic_encoders() {
    let exports = include_str!("../src/lib.rs");
    assert!(exports.contains("ReadOnlyMessage"));
    assert!(exports.contains("ReadOnlyResponse"));
    assert!(exports.contains("TranscriptPage"));
    assert!(exports.contains("encode_client_hello"));
    assert!(exports.contains("encode_read_transcript_request"));
    assert!(!exports.contains("encode_client_message"));
    assert!(!exports.contains("encode_server_message"));
    assert!(!exports.contains("new_client_message"));
    assert!(!exports.contains("new_server_message"));
    assert!(!exports.contains("pub mod framing"));
    assert!(!exports.contains("pub use generated"));
    assert!(!exports.contains("pub mod generated"));

    let framing = include_str!("../src/framing.rs");
    assert!(framing.contains("struct DecodedMessage"));
    assert!(!framing.contains("pub struct DecodedMessage"));
    assert!(framing.contains("fn encode_frame"));
    assert!(!framing.contains("pub fn encode_frame"));
}

#[test]
fn generated_types_remain_private_to_the_protocol_crate() {
    let manifest =
        fs::read_to_string(format!("{}/src/lib.rs", env!("CARGO_MANIFEST_DIR"))).unwrap();
    assert!(!manifest.contains("pub mod generated"));
    assert!(!manifest.contains("pub use generated"));
}
