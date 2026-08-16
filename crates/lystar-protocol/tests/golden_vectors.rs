use std::fs;

use lystar_protocol::{
    B3Command, FieldPresence, FrameDecoder, decode_client_message, decode_server_message,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct FixtureManifest {
    fixtures: Vec<Fixture>,
}

#[derive(Deserialize)]
struct Fixture {
    name: String,
    direction: String,
    message: Value,
    #[serde(rename = "b3Command")]
    b3_command: Option<String>,
    presence: Option<Presence>,
}

#[derive(Deserialize)]
struct Presence {
    path: Vec<String>,
    state: String,
}

#[test]
fn typescript_and_rust_frames_match_the_shared_semantic_matrix() {
    let directory = format!("{}/tests/fixtures", env!("CARGO_MANIFEST_DIR"));
    let source = format!(
        "{}/../../packages/gui-protocol/scripts/fixtures/semantic.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let manifest: FixtureManifest = serde_json::from_slice(&fs::read(source).unwrap()).unwrap();

    for fixture in manifest.fixtures {
        let typescript = fs::read(format!("{directory}/ts-{}.frame", fixture.name)).unwrap();
        let rust = fs::read(format!("{directory}/rust-{}.frame", fixture.name)).unwrap();
        match fixture.direction.as_str() {
            "client" => {
                let typescript = decode_client_message(&decode_frame(&typescript)).unwrap();
                let rust = decode_client_message(&decode_frame(&rust)).unwrap();
                assert_eq!(
                    as_json(typescript.value()),
                    fixture.message,
                    "TS client fixture {}",
                    fixture.name
                );
                assert_eq!(
                    as_json(rust.value()),
                    fixture.message,
                    "Rust client fixture {}",
                    fixture.name
                );
                if let Some(command) = fixture.b3_command.as_deref() {
                    assert_eq!(
                        typescript.b3_command(),
                        B3Command::from_wire(command),
                        "TS client B3 fixture {}",
                        fixture.name
                    );
                    assert_eq!(
                        rust.b3_command(),
                        B3Command::from_wire(command),
                        "Rust client B3 fixture {}",
                        fixture.name
                    );
                }
                if let Some(presence) = &fixture.presence {
                    assert_presence(&fixture.name, &typescript, presence);
                    assert_presence(&fixture.name, &rust, presence);
                }
            }
            "server" => {
                let typescript = decode_server_message(&decode_frame(&typescript)).unwrap();
                let rust = decode_server_message(&decode_frame(&rust)).unwrap();
                assert_eq!(
                    as_json(typescript.value()),
                    fixture.message,
                    "TS server fixture {}",
                    fixture.name
                );
                assert_eq!(
                    as_json(rust.value()),
                    fixture.message,
                    "Rust server fixture {}",
                    fixture.name
                );
                if let Some(command) = fixture.b3_command.as_deref().and_then(B3Command::from_wire)
                {
                    assert!(
                        typescript.decode_b3_result(command).is_ok(),
                        "TS B3 fixture {}",
                        fixture.name
                    );
                    assert!(
                        rust.decode_b3_result(command).is_ok(),
                        "Rust B3 fixture {}",
                        fixture.name
                    );
                }
                if let Some(presence) = &fixture.presence {
                    assert_presence(&fixture.name, &typescript, presence);
                    assert_presence(&fixture.name, &rust, presence);
                }
            }
            _ => panic!("fixture {} has an invalid direction", fixture.name),
        }
    }
}

fn as_json(value: &ciborium::value::Value) -> Value {
    serde_json::to_value(value).unwrap()
}

fn assert_presence(name: &str, message: &impl HasPresence, presence: &Presence) {
    let path = presence.path.iter().map(String::as_str).collect::<Vec<_>>();
    let expected = match presence.state.as_str() {
        "missing" => FieldPresence::Missing,
        "null" => FieldPresence::Null,
        "value" => FieldPresence::Value,
        _ => panic!("fixture {name} has an invalid presence state"),
    };
    assert_eq!(message.presence(&path), expected, "{name}");
    if path.as_slice() == ["event", "operation", "progress"] {
        assert_eq!(
            message.presence(&["event", "operation", "result"]),
            expected,
            "{name} result presence"
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
