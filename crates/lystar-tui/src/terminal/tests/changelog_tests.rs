use super::*;

#[test]
fn changelog_command_requests_and_displays_rendered_release_notes() {
    let mut app = AppState::default();
    app.begin_active_session(
        "/tmp/sessions/current.jsonl".to_owned(),
        "/work/project".to_owned(),
    );
    app.lease_id = Some("lease".to_owned());
    app.prepare_composer(ratatui::layout::Rect::new(0, 0, 100, 5));
    app.editor.insert("/changelog");
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 0;
    let mut session_flow = None;

    submit_editor(
        &mut app,
        &mut pipe,
        "/tmp/sessions/current.jsonl",
        "client",
        &mut sequence,
        false,
        &mut session_flow,
    )
    .unwrap();
    drop(pipe);

    let frames = FrameDecoder::default()
        .push(&std::fs::read(&path).unwrap())
        .unwrap();
    let request = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let request = serde_json::to_value(request.value()).unwrap();
    assert_eq!(request["request"]["command"], "get_changelog");
    assert_eq!(
        request["request"]["sessionPath"],
        "/tmp/sessions/current.jsonl"
    );
    assert_eq!(request["request"]["width"], 72);
    assert!(matches!(
        app.overlay(),
        Some(OverlayState::Detail(detail)) if detail.title == "更新内容"
    ));

    let first = "\x1b]8;;https://example.test/one\x1b\\One\x1b]8;;\x1b\\";
    let second = "\x1b]8;;https://example.test/two\x1b\\Two\x1b]8;;\x1b\\";
    let response = serde_json::json!({
        "type": "response",
        "id": "get_changelog:1",
        "ok": true,
        "result": {
            "lines": [format!("{first} and {second}")],
            "contentHash": "release-notes"
        }
    });
    let cbor: ciborium::value::Value = serde_json::from_value(response).unwrap();
    let mut bytes = Vec::new();
    ciborium::into_writer(&cbor, &mut bytes).unwrap();
    let message = lystar_protocol::decode_server_message(&bytes).unwrap();
    let mut response_pipe = test_pipe();
    let mut quit = false;
    apply_server_message(
        &mut app,
        &message,
        "/tmp/sessions/current.jsonl",
        &mut response_pipe,
        "client",
        &mut sequence,
        &mut session_flow,
        &mut quit,
    )
    .unwrap();

    let Some(OverlayState::Detail(detail)) = app.overlay() else {
        panic!("更新内容覆盖层没有打开");
    };
    assert_eq!(detail.status, "Esc 返回");
    assert!(detail.lines[0].contains("https://example.test/one"));
    let links =
        WorkbenchOverlayView::new(&app).visible_links(ratatui::layout::Rect::new(0, 0, 120, 30));
    assert_eq!(links.len(), 2);
    assert_eq!(links[0].label, "One");
    assert_eq!(links[1].href, "https://example.test/two");
    std::fs::remove_file(path).unwrap();
}

#[test]
fn command_palette_exposes_changelog() {
    let mut app = AppState::default();
    let mut pipe = test_pipe();
    let mut sequence = 0;
    let mut session_flow = None;
    let mut quit_requested = false;

    handle_key(
        &mut app,
        KeyCode::Char('p'),
        KeyModifiers::CONTROL,
        &mut pipe,
        "/tmp/sessions/current.jsonl",
        "client",
        &mut sequence,
        &mut session_flow,
        &mut quit_requested,
    )
    .unwrap();

    let Some(OverlayState::List(palette)) = app.overlay() else {
        panic!("命令面板没有打开");
    };
    assert!(
        palette
            .items
            .iter()
            .any(|item| item.label == "/changelog" && item.action == "open:changelog")
    );
}
