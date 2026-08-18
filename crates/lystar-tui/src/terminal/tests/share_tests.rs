use super::*;

fn share_operation(status: &str) -> lystar_protocol::OperationSnapshot {
    lystar_protocol::OperationSnapshot {
        operation_id: "share-operation".to_owned(),
        client_instance_id: "client".to_owned(),
        client_request_id: "share-1".to_owned(),
        session_path: "/tmp/session.jsonl".to_owned(),
        operation_type: "share_session".to_owned(),
        status: status.to_owned(),
        progress: None,
        result: None,
        error: None,
    }
}

fn operation_value(status: &str, result: Option<serde_json::Value>) -> serde_json::Value {
    let mut operation = serde_json::json!({
        "operationId": "share-operation",
        "clientInstanceId": "client",
        "clientRequestId": "share-1",
        "sessionPath": "/tmp/session.jsonl",
        "type": "share_session",
        "status": status,
        "acceptedAt": 1,
        "updatedAt": 2,
        "payloadHash": "hash"
    });
    if let Some(result) = result {
        operation["result"] = result;
    }
    operation
}

#[test]
fn share_command_sends_a_cancellable_operation_and_displays_the_urls() {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/session.jsonl".to_owned(), "/work/project".to_owned());
    app.lease_id = Some("lease".to_owned());
    app.editor.insert("/share");
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 0;
    let mut session_flow = None;
    submit_editor(
        &mut app,
        &mut pipe,
        "/tmp/session.jsonl",
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
    assert_eq!(request["request"]["command"], "share_session");
    assert_eq!(request["request"]["sessionPath"], "/tmp/session.jsonl");
    assert_eq!(app.transcript.status, "正在创建私密 Gist，按 Ctrl+C 可取消");
    std::fs::remove_file(path).unwrap();

    let mut response_pipe = test_pipe();
    let mut quit = false;
    let accepted = serde_json::json!({
        "type": "response",
        "id": "share-1",
        "ok": true,
        "result": { "operation": operation_value("accepted", None), "duplicate": false }
    });
    let mut bytes = Vec::new();
    ciborium::into_writer(
        &serde_json::from_value::<ciborium::value::Value>(accepted).unwrap(),
        &mut bytes,
    )
    .unwrap();
    let message = lystar_protocol::decode_server_message(&bytes).unwrap();
    apply_server_message(
        &mut app,
        &message,
        "/tmp/session.jsonl",
        &mut response_pipe,
        "client",
        &mut sequence,
        &mut session_flow,
        &mut quit,
    )
    .unwrap();
    assert!(matches!(
        app.operation.as_ref(),
        Some(operation) if operation.operation_type == "share_session" && operation.status == "accepted"
    ));

    let completed = serde_json::json!({
        "type": "event",
        "event": {
            "type": "operation_updated",
            "operation": operation_value("completed", Some(serde_json::json!({
                "previewUrl": "https://pi.dev/session/#gist-id",
                "gistUrl": "https://gist.github.com/user/gist-id",
                "operationId": "share-operation"
            })))
        }
    });
    let mut bytes = Vec::new();
    ciborium::into_writer(
        &serde_json::from_value::<ciborium::value::Value>(completed).unwrap(),
        &mut bytes,
    )
    .unwrap();
    let message = lystar_protocol::decode_server_message(&bytes).unwrap();
    apply_server_message(
        &mut app,
        &message,
        "/tmp/session.jsonl",
        &mut response_pipe,
        "client",
        &mut sequence,
        &mut session_flow,
        &mut quit,
    )
    .unwrap();
    assert!(matches!(
        app.overlay(),
        Some(OverlayState::Detail(detail))
            if detail.title == "会话已分享"
                && detail.copy_text.as_deref() == Some("https://pi.dev/session/#gist-id")
                && detail.lines == [
                    "分享地址：https://pi.dev/session/#gist-id",
                    "Gist：https://gist.github.com/user/gist-id"
                ]
    ));
    assert_eq!(app.toast.as_deref(), Some("会话已分享"));
    assert!(app.transcript.status.is_empty());
}

#[test]
fn share_can_be_aborted_and_blocks_other_submissions() {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/session.jsonl".to_owned(), "/work/project".to_owned());
    app.lease_id = Some("lease".to_owned());
    app.apply_operation(share_operation("running"));
    app.editor.insert("continue while sharing");
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 0;
    let mut session_flow = None;
    submit_editor(
        &mut app,
        &mut pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        false,
        &mut session_flow,
    )
    .unwrap();
    assert!(std::fs::read(&path).unwrap().is_empty());
    assert_eq!(
        app.overlay_error.as_deref(),
        Some("正在分享会话，按 Ctrl+C 可取消")
    );

    interrupt_active_operation(&mut app, &mut pipe, &mut sequence).unwrap();
    drop(pipe);
    let frames = FrameDecoder::default()
        .push(&std::fs::read(&path).unwrap())
        .unwrap();
    let request = lystar_protocol::decode_client_message(frames.last().unwrap()).unwrap();
    let request = serde_json::to_value(request.value()).unwrap();
    assert_eq!(request["request"]["command"], "abort_operation");
    std::fs::remove_file(path).unwrap();

    app.apply_operation(share_operation("aborted"));
    assert_eq!(app.toast.as_deref(), Some("分享已取消"));
    assert!(app.transcript.status.is_empty());

    let mut failed = share_operation("failed");
    failed.error = Some("GitHub CLI 尚未登录".to_owned());
    app.apply_operation(failed);
    assert_eq!(app.overlay_error.as_deref(), Some("GitHub CLI 尚未登录"));
}
