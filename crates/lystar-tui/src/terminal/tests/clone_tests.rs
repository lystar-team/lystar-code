use super::*;

fn submit_clone(app: &mut AppState) -> (Option<SessionFlow>, Vec<u8>) {
    app.editor.insert("/clone");
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

fn active_app() -> AppState {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/session.jsonl".to_owned(), "/work/project".to_owned());
    app.apply_active_lease(
        "lease".to_owned(),
        serde_json::from_value(snapshot_value("/tmp/session.jsonl")).unwrap(),
    );
    app
}

#[test]
fn clone_command_forks_the_snapshot_leaf_at_its_current_position() {
    let mut app = active_app();
    let (flow, bytes) = submit_clone(&mut app);
    let frames = FrameDecoder::default().push(&bytes).unwrap();
    let request = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let request = serde_json::to_value(request.value()).unwrap();

    assert_eq!(request["request"]["command"], "fork_session");
    assert_eq!(request["request"]["sessionPath"], "/tmp/session.jsonl");
    assert_eq!(request["request"]["leaseId"], "lease");
    assert_eq!(request["request"]["entryId"], "leaf-current");
    assert_eq!(request["request"]["position"], "at");
    assert!(matches!(flow, Some(SessionFlow::Fork { .. })));
}

#[test]
fn clone_command_rejects_an_active_operation_and_requires_content_and_a_lease() {
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
    let (flow, bytes) = submit_clone(&mut app);
    assert!(flow.is_none());
    assert!(bytes.is_empty());
    assert_eq!(
        app.overlay_error.as_deref(),
        Some("当前会话正在运行，不能复制")
    );

    let mut app = active_app();
    app.snapshot.as_mut().unwrap().leaf_id = None;
    let (flow, bytes) = submit_clone(&mut app);
    assert!(flow.is_none());
    assert!(bytes.is_empty());
    assert_eq!(app.toast.as_deref(), Some("当前还没有可复制的会话内容"));

    let mut app = active_app();
    app.clear_active_lease();
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 0;
    let mut flow = None;
    clone_current_session(
        &mut app,
        &mut pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        &mut flow,
    )
    .unwrap();
    drop(pipe);
    assert!(flow.is_none());
    assert!(std::fs::read(&path).unwrap().is_empty());
    std::fs::remove_file(path).unwrap();
    assert_eq!(app.overlay_error.as_deref(), Some("尚未获取会话租约"));
}

#[test]
fn clone_response_switches_on_success_and_preserves_the_session_on_failure() {
    let mut app = active_app();
    let (mut flow, bytes) = submit_clone(&mut app);
    let frames = FrameDecoder::default().push(&bytes).unwrap();
    let request = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let request = serde_json::to_value(request.value()).unwrap();
    let id = request["id"].as_str().unwrap();
    let mut cloned = snapshot_value("/tmp/cloned.jsonl");
    cloned["id"] = serde_json::json!("cloned");
    cloned["leafId"] = serde_json::json!("cloned-leaf");
    let mut pipe = test_pipe();
    let mut sequence = 1;
    let mut quit = false;
    apply_session_flow(
        &mut app,
        &serde_json::json!({
            "id": id,
            "ok": true,
            "result": {"lease": {"leaseId": "cloned-lease"}, "snapshot": cloned}
        }),
        &mut pipe,
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap();
    assert_eq!(app.active_session_path(), Some("/tmp/cloned.jsonl"));
    assert_eq!(app.lease_id.as_deref(), Some("cloned-lease"));
    assert_eq!(app.toast.as_deref(), Some("已复制为新会话"));

    let mut app = active_app();
    app.transcript
        .replace_page(vec![item("保留的记录")], "g1".to_owned(), 1, None);
    let (mut flow, _) = submit_clone(&mut app);
    app.editor.insert("失败后保留的草稿");
    apply_session_flow(
        &mut app,
        &serde_json::json!({
            "id": "session-clone-1",
            "ok": false,
            "error": {"code": "session_locked", "message": "会话已被占用"}
        }),
        &mut pipe,
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap();
    assert_eq!(app.active_session_path(), Some("/tmp/session.jsonl"));
    assert_eq!(app.lease_id.as_deref(), Some("lease"));
    assert_eq!(app.transcript.cached_rounds(), 1);
    assert_eq!(app.editor.text(), "失败后保留的草稿");
    assert_eq!(app.overlay_error.as_deref(), Some("会话已被占用"));
}

#[test]
fn command_palette_exposes_clone() {
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
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        &mut session_flow,
        &mut quit_requested,
    )
    .unwrap();

    assert!(matches!(
        app.overlay(),
        Some(OverlayState::List(palette))
            if palette.items.iter().any(|item| item.label == "/clone" && item.action == "open:clone")
    ));
}
