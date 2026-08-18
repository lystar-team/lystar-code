use super::*;

fn named_snapshot(path: &str, name: Option<&str>) -> lystar_protocol::SessionSnapshot {
    let mut snapshot = snapshot_value(path);
    if let Some(name) = name {
        snapshot["name"] = serde_json::Value::String(name.to_owned());
    }
    serde_json::from_value(snapshot).unwrap()
}

fn submit_name(app: &mut AppState, input: &str) -> (Option<SessionFlow>, Vec<u8>) {
    app.editor.insert(input);
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 0;
    let mut session_flow = None;
    submit_editor(
        app,
        &mut pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        false,
        &mut session_flow,
    )
    .unwrap();
    drop(pipe);
    let bytes = std::fs::read(&path).unwrap();
    std::fs::remove_file(path).unwrap();
    (session_flow, bytes)
}

#[test]
fn name_command_reports_current_name_and_requires_a_lease_for_changes() {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/session.jsonl".to_owned(), "/work/project".to_owned());
    app.apply_active_lease(
        "lease".to_owned(),
        named_snapshot("/tmp/session.jsonl", Some("当前名称")),
    );

    let (flow, bytes) = submit_name(&mut app, "/name");
    assert!(flow.is_none());
    assert!(bytes.is_empty());
    assert_eq!(app.toast.as_deref(), Some("会话名称：当前名称"));

    app.clear_active_lease();
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 0;
    let mut flow = None;
    request_session_name(
        &mut app,
        &mut pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        &mut flow,
        " 新名称",
    )
    .unwrap();
    drop(pipe);
    assert!(flow.is_none());
    assert!(std::fs::read(&path).unwrap().is_empty());
    std::fs::remove_file(path).unwrap();
    assert_eq!(app.overlay_error.as_deref(), Some("尚未获取会话租约"));
}

#[test]
fn name_command_uses_existing_rename_contract_and_applies_the_normalized_snapshot() {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/session.jsonl".to_owned(), "/work/project".to_owned());
    app.lease_id = Some("lease".to_owned());
    let (mut flow, bytes) = submit_name(&mut app, "/name   新\n名称   ");
    let frames = FrameDecoder::default().push(&bytes).unwrap();
    let request = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let request = serde_json::to_value(request.value()).unwrap();
    assert_eq!(request["request"]["command"], "rename_session");
    assert_eq!(request["request"]["name"], "新\n名称");
    assert_eq!(request["request"]["leaseId"], "lease");

    let id = request["id"].as_str().unwrap();
    let mut snapshot = snapshot_value("/tmp/session.jsonl");
    snapshot["name"] = serde_json::Value::String("新 名称".to_owned());
    let response = serde_json::json!({
        "type": "response",
        "id": id,
        "ok": true,
        "result": snapshot
    });
    let mut response_bytes = Vec::new();
    ciborium::into_writer(
        &serde_json::from_value::<ciborium::value::Value>(response).unwrap(),
        &mut response_bytes,
    )
    .unwrap();
    let message = lystar_protocol::decode_server_message(&response_bytes).unwrap();
    let mut pipe = test_pipe();
    let mut sequence = 1;
    let mut quit = false;
    apply_server_message(
        &mut app,
        &message,
        "/tmp/session.jsonl",
        &mut pipe,
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap();

    assert_eq!(
        app.snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.name.as_deref()),
        Some("新 名称")
    );
    assert_eq!(
        app.toast.as_deref(),
        Some("会话名称已设置：新 名称（已从 \"新\\n名称\" 规范化）")
    );
}

#[test]
fn name_command_without_an_existing_name_keeps_the_typescript_usage_hint() {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/session.jsonl".to_owned(), "/work/project".to_owned());
    app.apply_active_lease(
        "lease".to_owned(),
        named_snapshot("/tmp/session.jsonl", None),
    );
    let (flow, bytes) = submit_name(&mut app, "/name");
    assert!(flow.is_none());
    assert!(bytes.is_empty());
    assert_eq!(app.overlay_error.as_deref(), Some("用法：/name <name>"));
}

#[test]
fn name_command_failure_keeps_the_previous_snapshot() {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/session.jsonl".to_owned(), "/work/project".to_owned());
    app.apply_active_lease(
        "lease".to_owned(),
        named_snapshot("/tmp/session.jsonl", Some("原名称")),
    );
    let (mut flow, bytes) = submit_name(&mut app, "/name 新名称");
    let frames = FrameDecoder::default().push(&bytes).unwrap();
    let request = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let request = serde_json::to_value(request.value()).unwrap();
    let response = serde_json::json!({
        "type": "response",
        "id": request["id"],
        "ok": false,
        "error": { "code": "session_locked", "message": "会话已被占用" }
    });
    let mut response_bytes = Vec::new();
    ciborium::into_writer(
        &serde_json::from_value::<ciborium::value::Value>(response).unwrap(),
        &mut response_bytes,
    )
    .unwrap();
    let message = lystar_protocol::decode_server_message(&response_bytes).unwrap();
    let mut pipe = test_pipe();
    let mut sequence = 1;
    let mut quit = false;
    apply_server_message(
        &mut app,
        &message,
        "/tmp/session.jsonl",
        &mut pipe,
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap();

    assert_eq!(app.overlay_error.as_deref(), Some("会话已被占用"));
    assert_eq!(
        app.snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.name.as_deref()),
        Some("原名称")
    );
}
