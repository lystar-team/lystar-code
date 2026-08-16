use std::fs;

fn main() {
    let directory = format!("{}/tests/fixtures", env!("CARGO_MANIFEST_DIR"));
    for name in [
        "client-hello",
        "client-read-transcript",
        "client-search-transcript",
        "client-ui-response-missing",
        "client-ui-response-null",
        "client-ui-response-value",
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
        let source = format!("{directory}/ts-{name}.frame");
        let target = format!("{directory}/rust-{name}.frame");
        if fs::read(&target).ok().as_deref() != fs::read(&source).ok().as_deref() {
            fs::copy(source, target).unwrap();
        }
    }
}
