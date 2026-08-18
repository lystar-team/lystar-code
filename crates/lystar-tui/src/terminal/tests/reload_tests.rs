use super::*;

fn active_app() -> AppState {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/session.jsonl".to_owned(), "/work/project".to_owned());
    app.apply_active_lease(
        "lease".to_owned(),
        serde_json::from_value(snapshot_value("/tmp/session.jsonl")).unwrap(),
    );
    app
}

fn submit_reload(app: &mut AppState) -> (Option<SessionFlow>, Vec<u8>) {
    app.editor.insert("/reload");
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 0;
    let mut flow = None;
    submit_editor(
        app,
        &mut pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        false,
        &mut flow,
    )
    .unwrap();
    drop(pipe);
    let bytes = std::fs::read(&path).unwrap();
    std::fs::remove_file(path).unwrap();
    (flow, bytes)
}

fn server_message(value: serde_json::Value) -> lystar_protocol::ServerMessage {
    let mut bytes = Vec::new();
    ciborium::into_writer(
        &serde_json::from_value::<ciborium::value::Value>(value).unwrap(),
        &mut bytes,
    )
    .unwrap();
    lystar_protocol::decode_server_message(&bytes).unwrap()
}

#[test]
fn reload_command_uses_the_leased_host_resource_contract() {
    let mut app = active_app();
    let (flow, bytes) = submit_reload(&mut app);
    let frames = FrameDecoder::default().push(&bytes).unwrap();
    let request = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let request = serde_json::to_value(request.value()).unwrap();

    assert_eq!(request["request"]["command"], "reload_resources");
    assert_eq!(request["request"]["sessionPath"], "/tmp/session.jsonl");
    assert_eq!(request["request"]["leaseId"], "lease");
    assert_eq!(request["request"]["clientInstanceId"], "client");
    assert_eq!(request["request"]["clientRequestId"], "reload:1");
    assert!(matches!(flow, Some(SessionFlow::Reload { .. })));
    assert!(app.transcript.status.starts_with("正在重新加载"));
    assert_eq!(builtin_slash_command(" /reload "), Some("reload"));

    app.editor.insert("重载期间输入的草稿");
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 1;
    let mut flow = flow;
    submit_editor(
        &mut app,
        &mut pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        false,
        &mut flow,
    )
    .unwrap();
    drop(pipe);
    assert!(std::fs::read(&path).unwrap().is_empty());
    std::fs::remove_file(path).unwrap();
    assert_eq!(app.editor.text(), "重载期间输入的草稿");
    assert_eq!(app.overlay_error.as_deref(), Some("资源重新加载正在进行"));
}

#[test]
fn reload_command_rejects_busy_unleased_and_parallel_sessions() {
    let mut app = active_app();
    app.operation = Some(lystar_protocol::OperationSnapshot {
        operation_id: "operation".to_owned(),
        client_instance_id: "client".to_owned(),
        client_request_id: "prompt".to_owned(),
        session_path: "/tmp/session.jsonl".to_owned(),
        operation_type: "prompt".to_owned(),
        status: "running".to_owned(),
        progress: None,
        result: None,
        error: None,
    });
    let (flow, bytes) = submit_reload(&mut app);
    assert!(flow.is_none());
    assert!(bytes.is_empty());
    assert_eq!(
        app.overlay_error.as_deref(),
        Some("当前会话正在运行，不能重新加载")
    );

    let mut app = active_app();
    app.clear_active_lease();
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 0;
    let mut flow = None;
    reload_resources(
        &mut app,
        &mut pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        &mut flow,
    )
    .unwrap();
    drop(pipe);
    assert!(std::fs::read(&path).unwrap().is_empty());
    std::fs::remove_file(path).unwrap();
    assert_eq!(app.overlay_error.as_deref(), Some("尚未获取会话租约"));

    let mut app = active_app();
    let mut pipe = test_pipe();
    let mut sequence = 0;
    let mut flow = Some(SessionFlow::Reload {
        id: "existing".to_owned(),
    });
    reload_resources(
        &mut app,
        &mut pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        &mut flow,
    )
    .unwrap();
    assert_eq!(app.overlay_error.as_deref(), Some("会话操作正在进行"));
}

#[test]
fn command_palette_exposes_reload() {
    let mut app = AppState::default();
    let mut pipe = test_pipe();
    let mut sequence = 0;
    let mut flow = None;
    let mut quit = false;
    handle_key(
        &mut app,
        KeyCode::Char('p'),
        KeyModifiers::CONTROL,
        &mut pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap();

    assert!(matches!(
        app.overlay(),
        Some(OverlayState::List(palette))
            if palette.items.iter().any(|item| item.label == "/reload" && item.action == "open:reload")
    ));
}

#[test]
fn reload_response_applies_only_a_valid_successful_snapshot() {
    let mut app = active_app();
    app.transcript
        .replace_page(vec![item("保留的记录")], "g1".to_owned(), 1, None);
    let (mut flow, bytes) = submit_reload(&mut app);
    let frames = FrameDecoder::default().push(&bytes).unwrap();
    let request = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let request = serde_json::to_value(request.value()).unwrap();
    let id = request["id"].as_str().unwrap();
    app.editor.insert("重载期间输入的草稿");
    let mut snapshot = snapshot_value("/tmp/session.jsonl");
    snapshot["revision"] = serde_json::json!(2);
    snapshot["name"] = serde_json::json!("重载后的名称");
    let message = server_message(serde_json::json!({
        "type": "response", "id": id, "ok": true, "result": snapshot
    }));
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

    assert!(flow.is_none());
    assert_eq!(app.snapshot.as_ref().map(|value| value.revision), Some(2));
    assert_eq!(app.lease_id.as_deref(), Some("lease"));
    assert_eq!(app.transcript.cached_rounds(), 1);
    assert_eq!(app.editor.text(), "重载期间输入的草稿");
    assert!(app.transcript.status.is_empty());
    assert_eq!(
        app.toast.as_deref(),
        Some("已重新加载 Extension、Skill、Prompt、Theme 和上下文文件")
    );
}

#[test]
fn reload_failure_or_invalid_response_preserves_session_state() {
    let mut app = active_app();
    let (mut flow, _) = submit_reload(&mut app);
    app.editor.insert("失败后保留的草稿");
    let message = server_message(serde_json::json!({
        "type": "response", "id": "session-reload-1", "ok": false,
        "error": {"code": "reload_failed", "message": "Extension 初始化失败"}
    }));
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
    assert_eq!(app.snapshot.as_ref().map(|value| value.revision), Some(1));
    assert_eq!(app.lease_id.as_deref(), Some("lease"));
    assert_eq!(app.editor.text(), "失败后保留的草稿");
    assert_eq!(
        app.overlay_error.as_deref(),
        Some("重新加载失败：Extension 初始化失败")
    );

    let mut app = active_app();
    let (mut flow, _) = submit_reload(&mut app);
    app.editor.insert("非法响应后保留的草稿");
    let mut invalid = snapshot_value("/tmp/session.jsonl");
    invalid["unexpected"] = serde_json::json!(true);
    let message = server_message(serde_json::json!({
        "type": "response", "id": "session-reload-1", "ok": true, "result": invalid
    }));
    let error = apply_server_message(
        &mut app,
        &message,
        "/tmp/session.jsonl",
        &mut pipe,
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap_err();
    assert!(matches!(error, TuiError::Protocol(_)));
    assert!(flow.is_none());
    assert_eq!(app.snapshot.as_ref().map(|value| value.revision), Some(1));
    assert_eq!(app.lease_id.as_deref(), Some("lease"));
    assert_eq!(app.editor.text(), "非法响应后保留的草稿");
    assert!(app.transcript.status.is_empty());
}
