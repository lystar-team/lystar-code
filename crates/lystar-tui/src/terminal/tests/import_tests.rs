use super::*;

#[test]
fn import_command_confirms_missing_cwd_and_commits_the_replacement_session() {
    assert_eq!(
        path_command_argument("/import 'path with spaces/session.jsonl'", "/import"),
        Some("path with spaces/session.jsonl".to_owned())
    );
    assert_eq!(
        path_command_argument("/import john's/session.jsonl", "/import"),
        Some("john's/session.jsonl".to_owned())
    );
    assert_eq!(path_command_argument("/import", "/import"), None);

    let mut app = AppState::default();
    app.begin_active_session(
        "/tmp/sessions/current.jsonl".to_owned(),
        "/work/project".to_owned(),
    );
    app.lease_id = Some("lease".to_owned());
    app.editor
        .insert("/import \"path with spaces/session.jsonl\"");
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
    assert!(std::fs::read(&path).unwrap().is_empty());
    assert_eq!(
        app.current_overlay_action().as_deref(),
        Some("session-import-confirm")
    );

    activate_workbench_action(
        &mut app,
        "session-import-confirm",
        &mut pipe,
        "/tmp/sessions/current.jsonl",
        "client",
        &mut sequence,
        &mut session_flow,
    )
    .unwrap();
    drop(pipe);
    let frames = FrameDecoder::default()
        .push(&std::fs::read(&path).unwrap())
        .unwrap();
    let request = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let request = serde_json::to_value(request.value()).unwrap();
    assert_eq!(request["request"]["command"], "import_session");
    assert_eq!(
        request["request"]["inputPath"],
        "path with spaces/session.jsonl"
    );
    assert!(request["request"].get("cwdOverride").is_none());
    assert!(matches!(
        session_flow,
        Some(SessionFlow::Import { ref input_path, .. })
            if input_path == "path with spaces/session.jsonl"
    ));
    std::fs::remove_file(path).unwrap();

    let mut response_pipe = test_pipe();
    let mut quit = false;
    apply_session_flow(
        &mut app,
        &serde_json::json!({
            "id": "session-import-1",
            "ok": false,
            "error": {
                "code": "missing_session_cwd",
                "message": "会话保存的工作目录不存在",
                "retryable": false,
                "details": {
                    "sessionCwd": "/missing/project",
                    "fallbackCwd": "/work/project"
                }
            }
        }),
        &mut response_pipe,
        "client",
        &mut sequence,
        &mut session_flow,
        &mut quit,
    )
    .unwrap();
    assert_eq!(
        app.current_overlay_action().as_deref(),
        Some("session-import-cwd-confirm")
    );
    assert_eq!(
        app.pending_session_import
            .as_ref()
            .and_then(|pending| pending.cwd_override.as_deref()),
        Some("/work/project")
    );

    let (mut retry_pipe, retry_path) = test_pipe_with_path();
    activate_workbench_action(
        &mut app,
        "session-import-cwd-confirm",
        &mut retry_pipe,
        "/tmp/sessions/current.jsonl",
        "client",
        &mut sequence,
        &mut session_flow,
    )
    .unwrap();
    drop(retry_pipe);
    let frames = FrameDecoder::default()
        .push(&std::fs::read(&retry_path).unwrap())
        .unwrap();
    let request = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let request = serde_json::to_value(request.value()).unwrap();
    assert_eq!(request["request"]["cwdOverride"], "/work/project");
    std::fs::remove_file(retry_path).unwrap();

    let mut snapshot = snapshot_value("/tmp/sessions/imported.jsonl");
    snapshot["cwd"] = serde_json::json!("/work/project");
    apply_session_flow(
        &mut app,
        &serde_json::json!({
            "id": "session-import-2",
            "ok": true,
            "result": {
                "cancelled": false,
                "lease": { "leaseId": "imported-lease" },
                "snapshot": snapshot
            }
        }),
        &mut response_pipe,
        "client",
        &mut sequence,
        &mut session_flow,
        &mut quit,
    )
    .unwrap();
    assert_eq!(
        app.active_session_path(),
        Some("/tmp/sessions/imported.jsonl")
    );
    assert_eq!(app.lease_id.as_deref(), Some("imported-lease"));
    assert!(app.pending_session_import.is_none());
    assert_eq!(
        app.toast.as_deref(),
        Some("已从 path with spaces/session.jsonl 导入会话")
    );
}

#[test]
fn import_cancel_and_failure_keep_the_active_session() {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/current.jsonl".to_owned(), "/work/project".to_owned());
    app.lease_id = Some("lease".to_owned());
    app.pending_session_import = Some(PendingSessionImport {
        input_path: "cancel.jsonl".to_owned(),
        cwd_override: None,
    });
    app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
        title: "导入会话".to_owned(),
        message: "确认".to_owned(),
        confirm_action: "session-import-confirm".to_owned(),
        status: String::new(),
    }));
    let mut pipe = test_pipe();
    let mut sequence = 0;
    let mut flow = None;
    handle_overlay_key(
        &mut app,
        KeyCode::Esc,
        KeyModifiers::NONE,
        &mut pipe,
        "/tmp/current.jsonl",
        "client",
        &mut sequence,
        &mut flow,
    )
    .unwrap();
    assert!(app.pending_session_import.is_none());
    assert_eq!(app.active_session_path(), Some("/tmp/current.jsonl"));
    assert_eq!(app.toast.as_deref(), Some("导入已取消"));

    app.pending_session_import = Some(PendingSessionImport {
        input_path: "/root/forbidden.jsonl".to_owned(),
        cwd_override: None,
    });
    flow = Some(SessionFlow::Import {
        id: "permission".to_owned(),
        input_path: "/root/forbidden.jsonl".to_owned(),
    });
    let mut quit = false;
    apply_session_flow(
        &mut app,
        &serde_json::json!({
            "id": "permission",
            "ok": false,
            "error": { "code": "io_error", "message": "Permission denied", "retryable": false }
        }),
        &mut pipe,
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap();
    assert_eq!(app.active_session_path(), Some("/tmp/current.jsonl"));
    assert_eq!(
        app.overlay_error.as_deref(),
        Some("导入会话失败：Permission denied")
    );
    assert!(app.pending_session_import.is_none());

    app.pending_session_import = Some(PendingSessionImport {
        input_path: "cancelled.jsonl".to_owned(),
        cwd_override: None,
    });
    flow = Some(SessionFlow::Import {
        id: "cancelled".to_owned(),
        input_path: "cancelled.jsonl".to_owned(),
    });
    apply_session_flow(
        &mut app,
        &serde_json::json!({"id":"cancelled","ok":true,"result":{"cancelled":true}}),
        &mut pipe,
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap();
    assert_eq!(app.active_session_path(), Some("/tmp/current.jsonl"));
    assert_eq!(app.toast.as_deref(), Some("导入已取消"));

    app.lease_id = Some("lease".to_owned());
    app.pending_session_import = Some(PendingSessionImport {
        input_path: "disconnect.jsonl".to_owned(),
        cwd_override: None,
    });
    app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
        title: "导入会话".to_owned(),
        message: "确认".to_owned(),
        confirm_action: "session-import-confirm".to_owned(),
        status: String::new(),
    }));
    app.clear_connection_state("连接已断开");
    assert!(app.pending_session_import.is_none());
    assert!(app.overlay().is_none());
    assert!(app.lease_id.is_none());
}
