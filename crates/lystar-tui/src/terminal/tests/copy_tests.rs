use super::*;

fn active_operation() -> lystar_protocol::OperationSnapshot {
    lystar_protocol::OperationSnapshot {
        operation_id: "prompt-operation".to_owned(),
        client_instance_id: "client".to_owned(),
        client_request_id: "prompt-request".to_owned(),
        session_path: "/tmp/session.jsonl".to_owned(),
        operation_type: "prompt".to_owned(),
        status: "running".to_owned(),
        progress: None,
        result: None,
        error: None,
    }
}

fn apply_copy_response(
    app: &mut AppState,
    id: &str,
    capability: bool,
    copied: bool,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
) {
    let response = serde_json::json!({
        "type": "response",
        "id": id,
        "ok": true,
        "result": { "capability": capability, "copied": copied }
    });
    let mut bytes = Vec::new();
    ciborium::into_writer(
        &serde_json::from_value::<ciborium::value::Value>(response).unwrap(),
        &mut bytes,
    )
    .unwrap();
    let message = lystar_protocol::decode_server_message(&bytes).unwrap();
    let mut quit = false;
    apply_server_message(
        app,
        &message,
        "/tmp/session.jsonl",
        pipe,
        "client",
        sequence,
        session_flow,
        &mut quit,
    )
    .unwrap();
}

#[test]
fn copy_command_targets_the_core_selected_assistant_even_while_prompting() {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/session.jsonl".to_owned(), "/work/project".to_owned());
    app.lease_id = Some("lease".to_owned());
    app.operation = Some(active_operation());
    app.editor.insert("/copy");
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
    let message = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let request = serde_json::to_value(message.value()).unwrap();
    assert_eq!(request["request"]["command"], "copy_last_assistant_message");
    assert_eq!(request["request"]["sessionPath"], "/tmp/session.jsonl");
    assert_eq!(request["request"]["clientInstanceId"], "client");
    assert!(request["request"].get("leaseId").is_none());
    std::fs::remove_file(path).unwrap();
}

#[test]
fn copy_command_reports_success_empty_session_and_missing_clipboard() {
    for (capability, copied, toast, error) in [
        (true, true, Some("最近一条 Agent 消息已复制到剪贴板"), None),
        (true, false, None, Some("还没有可复制的 Agent 消息")),
        (false, false, None, Some("Host 不支持剪贴板写入")),
    ] {
        let mut app = AppState::default();
        app.begin_active_session("/tmp/session.jsonl".to_owned(), "/work/project".to_owned());
        app.lease_id = Some("lease".to_owned());
        app.editor.insert("/copy");
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
        let id = request["id"].as_str().unwrap();
        std::fs::remove_file(path).unwrap();

        let mut response_pipe = test_pipe();
        apply_copy_response(
            &mut app,
            id,
            capability,
            copied,
            &mut response_pipe,
            &mut sequence,
            &mut session_flow,
        );
        assert_eq!(app.toast.as_deref(), toast);
        assert_eq!(app.overlay_error.as_deref(), error);
    }
}
