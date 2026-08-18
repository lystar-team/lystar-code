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

fn server_message(value: serde_json::Value) -> lystar_protocol::ServerMessage {
    let mut bytes = Vec::new();
    ciborium::into_writer(
        &serde_json::from_value::<ciborium::value::Value>(value).unwrap(),
        &mut bytes,
    )
    .unwrap();
    lystar_protocol::decode_server_message(&bytes).unwrap()
}

fn submit_fork(app: &mut AppState) -> (Option<SessionFlow>, Vec<u8>) {
    app.editor.insert("/fork");
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

fn apply_candidates(app: &mut AppState, sequence: &mut u64) {
    let message = server_message(serde_json::json!({
        "type": "response",
        "id": "list_fork_messages:1",
        "ok": true,
        "result": [
            {"entryId": "entry-first", "text": "first prompt"},
            {"entryId": "entry-latest", "text": "latest prompt\nwith details"}
        ]
    }));
    let mut pipe = test_pipe();
    let mut flow = None;
    let mut quit = false;
    apply_server_message(
        app,
        &message,
        "/tmp/session.jsonl",
        &mut pipe,
        "client",
        sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap();
}

fn select_latest(app: &mut AppState) -> (Option<SessionFlow>, Vec<u8>) {
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 1;
    let mut flow = None;
    handle_overlay_key(
        app,
        KeyCode::Enter,
        KeyModifiers::NONE,
        &mut pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        &mut flow,
    )
    .unwrap();
    drop(pipe);
    let bytes = std::fs::read(&path).unwrap();
    std::fs::remove_file(path).unwrap();
    (flow, bytes)
}

fn fork_result(path: &str, selected_text: &str) -> serde_json::Value {
    let mut snapshot = snapshot_value(path);
    snapshot["id"] = serde_json::json!("forked");
    snapshot["leafId"] = serde_json::Value::Null;
    serde_json::json!({
        "lease": {
            "leaseId": "fork-lease",
            "leaseGeneration": 2,
            "sessionPath": path,
            "clientInstanceId": "client",
            "createdAt": 1,
            "updatedAt": 2
        },
        "snapshot": snapshot,
        "selectedText": selected_text
    })
}

#[test]
fn fork_command_lists_messages_and_defaults_to_the_latest() {
    let mut app = active_app();
    let (flow, bytes) = submit_fork(&mut app);
    let frames = FrameDecoder::default().push(&bytes).unwrap();
    let request = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let request = serde_json::to_value(request.value()).unwrap();

    assert!(flow.is_none());
    assert_eq!(request["request"]["command"], "list_fork_messages");
    assert_eq!(request["request"]["sessionPath"], "/tmp/session.jsonl");
    assert_eq!(request["request"]["leaseId"], "lease");
    assert_eq!(builtin_slash_command(" /fork "), Some("fork"));

    let mut sequence = 1;
    apply_candidates(&mut app, &mut sequence);
    assert!(matches!(
        app.overlay(),
        Some(OverlayState::List(list))
            if list.title == "分叉会话"
                && list.selected == 1
                && list.items[1].label == "latest prompt"
                && list.items[1].action == "fork-message:entry-latest"
    ));

    let mut pipe = test_pipe();
    let mut session_flow = None;
    handle_overlay_key(
        &mut app,
        KeyCode::Esc,
        KeyModifiers::NONE,
        &mut pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        &mut session_flow,
    )
    .unwrap();
    assert!(app.overlay().is_none());
    assert!(session_flow.is_none());

    let (_, _) = submit_fork(&mut app);
    let message = server_message(serde_json::json!({
        "type": "response",
        "id": "list_fork_messages:1",
        "ok": true,
        "result": []
    }));
    let mut quit = false;
    apply_server_message(
        &mut app,
        &message,
        "/tmp/session.jsonl",
        &mut pipe,
        "client",
        &mut sequence,
        &mut session_flow,
        &mut quit,
    )
    .unwrap();
    assert!(app.overlay().is_none());
    assert_eq!(app.toast.as_deref(), Some("当前还没有可分叉的用户消息"));
}

#[test]
fn selecting_a_fork_message_uses_before_and_restores_selected_text_on_success() {
    let mut app = active_app();
    app.transcript
        .replace_page(vec![item("kept-round")], "g1".to_owned(), 1, None);
    let (_, _) = submit_fork(&mut app);
    let mut sequence = 1;
    apply_candidates(&mut app, &mut sequence);
    let (mut flow, bytes) = select_latest(&mut app);
    let frames = FrameDecoder::default().push(&bytes).unwrap();
    let request = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let request = serde_json::to_value(request.value()).unwrap();
    let id = request["id"].as_str().unwrap();

    assert_eq!(request["request"]["command"], "fork_session");
    assert_eq!(request["request"]["entryId"], "entry-latest");
    assert_eq!(request["request"]["position"], "before");
    assert_eq!(request["request"]["clientRequestId"], "fork-message:2");
    assert!(matches!(
        flow,
        Some(SessionFlow::Fork {
            restore_selected_text: true,
            ..
        })
    ));

    app.editor.insert("waiting draft");
    let mut no_submit_pipe = test_pipe_with_path();
    submit_editor(
        &mut app,
        &mut no_submit_pipe.0,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        false,
        &mut flow,
    )
    .unwrap();
    drop(no_submit_pipe.0);
    assert!(std::fs::read(&no_submit_pipe.1).unwrap().is_empty());
    std::fs::remove_file(no_submit_pipe.1).unwrap();
    assert_eq!(app.editor.text(), "waiting draft");

    let message = server_message(serde_json::json!({
        "type": "response",
        "id": id,
        "ok": true,
        "result": fork_result("/tmp/forked.jsonl", "latest prompt\nwith details")
    }));
    let mut pipe = test_pipe();
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
    assert_eq!(app.active_session_path(), Some("/tmp/forked.jsonl"));
    assert_eq!(app.lease_id.as_deref(), Some("fork-lease"));
    assert_eq!(app.editor.text(), "latest prompt\nwith details");
    assert_eq!(app.transcript.cached_rounds(), 0);
    assert_eq!(app.toast.as_deref(), Some("已创建并切换分叉会话"));
}

#[test]
fn fork_command_rejects_busy_unleased_and_parallel_sessions() {
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
    let (flow, bytes) = submit_fork(&mut app);
    assert!(flow.is_none());
    assert!(bytes.is_empty());
    assert_eq!(
        app.overlay_error.as_deref(),
        Some("当前会话正在运行，不能分叉")
    );

    let mut app = active_app();
    app.clear_active_lease();
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 0;
    let flow = None;
    open_fork_selector(
        &mut app,
        &mut pipe,
        "/tmp/session.jsonl",
        &mut sequence,
        &flow,
    )
    .unwrap();
    drop(pipe);
    assert!(std::fs::read(&path).unwrap().is_empty());
    std::fs::remove_file(path).unwrap();
    assert_eq!(app.overlay_error.as_deref(), Some("尚未获取会话租约"));

    let mut app = active_app();
    let mut pipe = test_pipe();
    let mut sequence = 0;
    let flow = Some(SessionFlow::Reload {
        id: "existing".to_owned(),
    });
    open_fork_selector(
        &mut app,
        &mut pipe,
        "/tmp/session.jsonl",
        &mut sequence,
        &flow,
    )
    .unwrap();
    assert_eq!(app.overlay_error.as_deref(), Some("会话操作正在进行"));
}

#[test]
fn fork_failure_or_invalid_response_preserves_the_current_state() {
    let mut app = active_app();
    app.transcript
        .replace_page(vec![item("kept-round")], "g1".to_owned(), 1, None);
    let (_, _) = submit_fork(&mut app);
    let mut sequence = 1;
    apply_candidates(&mut app, &mut sequence);
    let (mut flow, _) = select_latest(&mut app);
    app.editor.insert("failure draft");
    let message = server_message(serde_json::json!({
        "type": "response",
        "id": "session-fork-message-2",
        "ok": false,
        "error": {"code": "session_fork_cancelled", "message": "已取消会话分叉"}
    }));
    let mut pipe = test_pipe();
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
    assert_eq!(app.active_session_path(), Some("/tmp/session.jsonl"));
    assert_eq!(app.lease_id.as_deref(), Some("lease"));
    assert_eq!(app.transcript.cached_rounds(), 1);
    assert_eq!(app.editor.text(), "failure draft");
    assert_eq!(app.overlay_error.as_deref(), Some("已取消会话分叉"));

    let mut app = active_app();
    app.transcript
        .replace_page(vec![item("kept-round")], "g1".to_owned(), 1, None);
    let (_, _) = submit_fork(&mut app);
    apply_candidates(&mut app, &mut sequence);
    let (mut flow, _) = select_latest(&mut app);
    app.editor.insert("invalid draft");
    let mut invalid = fork_result("/tmp/forked.jsonl", "selected");
    invalid["unexpected"] = serde_json::json!(true);
    let message = server_message(serde_json::json!({
        "type": "response",
        "id": "session-fork-message-2",
        "ok": true,
        "result": invalid
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
    assert_eq!(app.active_session_path(), Some("/tmp/session.jsonl"));
    assert_eq!(app.lease_id.as_deref(), Some("lease"));
    assert_eq!(app.transcript.cached_rounds(), 1);
    assert_eq!(app.editor.text(), "invalid draft");

    let mut app = active_app();
    app.transcript
        .replace_page(vec![item("kept-round")], "g1".to_owned(), 1, None);
    let (_, _) = submit_fork(&mut app);
    let mut sequence = 1;
    apply_candidates(&mut app, &mut sequence);
    let (mut flow, _) = select_latest(&mut app);
    app.editor.insert("missing text draft");
    let mut missing_text = fork_result("/tmp/forked.jsonl", "selected");
    missing_text.as_object_mut().unwrap().remove("selectedText");
    let message = server_message(serde_json::json!({
        "type": "response",
        "id": "session-fork-message-2",
        "ok": true,
        "result": missing_text
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
    assert!(matches!(error, TuiError::InvalidResponse(_)));
    assert_eq!(app.active_session_path(), Some("/tmp/session.jsonl"));
    assert_eq!(app.lease_id.as_deref(), Some("lease"));
    assert_eq!(app.transcript.cached_rounds(), 1);
    assert_eq!(app.editor.text(), "missing text draft");
}

#[test]
fn command_palette_exposes_fork() {
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
            if palette.items.iter().any(|item| item.label == "/fork" && item.action == "open:fork")
    ));
}
