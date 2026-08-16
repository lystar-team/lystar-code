use std::fs;

use ciborium::ser::into_writer;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct FixtureManifest {
    fixtures: Vec<Fixture>,
}

#[derive(Deserialize)]
struct Fixture {
    name: String,
    message: Value,
}

fn main() {
    let directory = format!("{}/tests/fixtures", env!("CARGO_MANIFEST_DIR"));
    let source = format!(
        "{}/../../packages/gui-protocol/scripts/fixtures/semantic.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let manifest: FixtureManifest = serde_json::from_slice(&fs::read(source).unwrap()).unwrap();
    for fixture in manifest.fixtures {
        let mut payload = Vec::new();
        let cbor: ciborium::value::Value = serde_json::from_value(fixture.message).unwrap();
        into_writer(&cbor, &mut payload).unwrap();
        let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
        frame.extend(payload);
        fs::write(format!("{directory}/rust-{}.frame", fixture.name), frame).unwrap();
    }
}
