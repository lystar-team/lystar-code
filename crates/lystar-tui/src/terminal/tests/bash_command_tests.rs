use super::*;
use crate::app::LiveToolStatus;

fn server_message(value: serde_json::Value) -> lystar_protocol::ServerMessage {
    let mut bytes = Vec::new();
    ciborium::into_writer(
        &serde_json::from_value::<ciborium::value::Value>(value).unwrap(),
        &mut bytes,
    )
    .unwrap();
    lystar_protocol::decode_server_message(&bytes).unwrap()
}

fn bash_operation(status: &str, output: &str) -> lystar_protocol::OperationSnapshot {
    lystar_protocol::OperationSnapshot {
        operation_id: "bash-operation".to_owned(),
        client_instance_id: "client".to_owned(),
        client_request_id: "bash:1".to_owned(),
        session_path: "/tmp/session.jsonl".to_owned(),
        operation_type: "run_bash".to_owned(),
        status: status.to_owned(),
        progress: Some(lystar_protocol::SessionProgress::Bash {
            command: "printf ok".to_owned(),
            output: output.to_owned(),
            truncated: None,
        }),
        result: None,
        error: None,
    }
}

fn submit(text: &str) -> (AppState, PathBuf, u64, Option<SessionFlow>) {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/session.jsonl".to_owned(), "/tmp".to_owned());
    app.lease_id = Some("lease".to_owned());
    app.editor.insert(text);
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 0;
    let mut flow = None;
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
    (app, path, sequence, flow)
}

#[test]
fn shell_prefixes_encode_context_policy_and_accept_an_operation() {
    for (text, expected_excluded) in [("!printf ok", false), ("!! printf ok", true)] {
        let (mut app, path, mut sequence, mut flow) = submit(text);
        let frames = FrameDecoder::default()
            .push(&std::fs::read(&path).unwrap())
            .unwrap();
        let request = lystar_protocol::decode_client_message(&frames[0]).unwrap();
        let request = serde_json::to_value(request.value()).unwrap();
        assert_eq!(request["request"]["command"], "run_bash");
        assert_eq!(request["request"]["commandText"], "printf ok");
        assert_eq!(request["request"]["excludeFromContext"], expected_excluded);
        assert!(app.editor.is_empty());

        let accepted = serde_json::json!({
            "type": "response",
            "id": "bash-1",
            "ok": true,
            "result": {
                "operation": {
                    "operationId": "bash-operation",
                    "clientInstanceId": "client",
                    "clientRequestId": "bash:1",
                    "sessionPath": "/tmp/session.jsonl",
                    "type": "run_bash",
                    "status": "accepted",
                    "acceptedAt": 1,
                    "updatedAt": 1,
                    "payloadHash": "hash"
                },
                "duplicate": false
            }
        });
        let message = server_message(accepted);
        let mut response_pipe = test_pipe();
        let mut quit = false;
        apply_server_message(
            &mut app,
            &message,
            "/tmp/session.jsonl",
            &mut response_pipe,
            "client",
            &mut sequence,
            &mut flow,
            &mut quit,
        )
        .unwrap();
        assert_eq!(
            app.pending_bash_submit
                .as_ref()
                .and_then(|submit| submit.operation_id.as_deref()),
            Some("bash-operation")
        );
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
fn shell_rejection_and_terminal_failure_restore_the_original_draft() {
    let (mut rejected, path, mut sequence, mut flow) = submit("!! printf rejected");
    let response = server_message(serde_json::json!({
        "type": "response",
        "id": "bash-1",
        "ok": false,
        "error": { "code": "lease_required", "message": "租约已失效", "retryable": true }
    }));
    let mut pipe = test_pipe();
    let mut quit = false;
    apply_server_message(
        &mut rejected,
        &response,
        "/tmp/session.jsonl",
        &mut pipe,
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap();
    assert_eq!(rejected.editor.text(), "!! printf rejected");
    assert_eq!(rejected.overlay_error.as_deref(), Some("租约已失效"));
    std::fs::remove_file(path).unwrap();

    let (mut failed, path, _, _) = submit("!printf ok");
    failed.accept_bash_submit("bash-1", "bash-operation".to_owned());
    failed.apply_operation(bash_operation("running", "partial"));
    assert_eq!(
        failed.live_tools.get("bash-operation").unwrap().status,
        LiveToolStatus::Running
    );
    failed.apply_operation(bash_operation("failed", "partial output"));
    assert_eq!(failed.editor.text(), "!printf ok");
    assert_eq!(
        failed.live_tools.get("bash-operation").unwrap().status,
        LiveToolStatus::Error
    );
    std::fs::remove_file(path).unwrap();
}

#[test]
fn pending_shell_request_blocks_another_composer_submission() {
    let (mut app, path, mut sequence, mut flow) = submit("!printf pending");
    app.editor.insert("ordinary prompt");
    let (mut pipe, second_path) = test_pipe_with_path();
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

    assert!(std::fs::read(&second_path).unwrap().is_empty());
    assert_eq!(app.editor.text(), "ordinary prompt");
    assert_eq!(
        app.overlay_error.as_deref(),
        Some("Shell 请求正在提交，请稍候")
    );
    std::fs::remove_file(path).unwrap();
    std::fs::remove_file(second_path).unwrap();
}

#[test]
fn committed_bash_replaces_live_output_without_reappearing_on_completion() {
    let (mut app, path, _, _) = submit("!printf ok");
    app.accept_bash_submit("bash-1", "bash-operation".to_owned());
    app.apply_operation(bash_operation("running", "ok"));
    let committed = lystar_protocol::TranscriptItem {
        entry_id: "bash-entry".to_owned(),
        timestamp: String::new(),
        view: lystar_protocol::TranscriptViewItem::Bash {
            text: "$ printf ok\nok".to_owned(),
        },
    };
    app.clear_live_after_commit(&[committed]);
    assert!(app.live_tools.get("bash-operation").is_none());
    app.apply_operation(bash_operation("completed", "ok"));
    assert!(app.live_tools.get("bash-operation").is_none());
    assert!(app.pending_bash_submit.is_none());
    std::fs::remove_file(path).unwrap();
}
