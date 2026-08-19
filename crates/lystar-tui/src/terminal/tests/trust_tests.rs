use super::*;

fn active_app(trusted: bool) -> AppState {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/session.jsonl".to_owned(), "/work/project".to_owned());
    let mut snapshot = snapshot_value("/tmp/session.jsonl");
    snapshot["cwd"] = serde_json::json!("/work/project");
    app.apply_active_lease(
        "lease".to_owned(),
        serde_json::from_value(snapshot).unwrap(),
    );
    app.trust = Some(ProjectTrustDescriptor {
        cwd: "/work/project".to_owned(),
        trusted: Some(trusted),
        reason: if trusted {
            "项目资源已信任"
        } else {
            "项目资源被明确设为不信任"
        }
        .to_owned(),
        resource_risk: true,
    });
    app.open_overlay(trust_overlay(&app));
    app
}

fn activate(
    app: &mut AppState,
    action: &str,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
    flow: &mut Option<SessionFlow>,
) {
    activate_workbench_action(
        app,
        action,
        pipe,
        "/tmp/session.jsonl",
        "client",
        sequence,
        flow,
    )
    .unwrap();
}

fn written_request(path: &std::path::Path) -> serde_json::Value {
    let frames = FrameDecoder::default()
        .push(&std::fs::read(path).unwrap())
        .unwrap();
    let message = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    serde_json::to_value(message.value()).unwrap()["request"].clone()
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

fn trust_response(id: &str, cwd: &str, trusted: bool) -> lystar_protocol::ServerMessage {
    server_message(serde_json::json!({
        "type": "response",
        "id": id,
        "ok": true,
        "result": {
            "cwd": cwd,
            "trusted": trusted,
            "reason": if trusted { "项目资源已信任" } else { "项目资源被明确设为不信任" },
            "resourceRisk": true
        }
    }))
}

#[test]
fn trust_confirmation_cancels_or_writes_the_leased_session_contract() {
    let mut app = active_app(false);
    app.editor.insert("保留的输入草稿");
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 0;
    let mut flow = None;
    activate(
        &mut app,
        "trust:toggle",
        &mut pipe,
        &mut sequence,
        &mut flow,
    );
    assert!(matches!(app.overlay(), Some(OverlayState::Confirm(_))));

    let mut quit = false;
    handle_key(
        &mut app,
        KeyCode::Esc,
        KeyModifiers::NONE,
        &mut pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap();
    assert!(matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "项目信任"));
    assert!(std::fs::read(&path).unwrap().is_empty());

    activate(
        &mut app,
        "trust:toggle",
        &mut pipe,
        &mut sequence,
        &mut flow,
    );
    activate(
        &mut app,
        "trust-set:true",
        &mut pipe,
        &mut sequence,
        &mut flow,
    );
    drop(pipe);
    let request = written_request(&path);
    assert_eq!(request["command"], "set_project_trust");
    assert_eq!(request["sessionPath"], "/tmp/session.jsonl");
    assert_eq!(request["leaseId"], "lease");
    assert_eq!(request["cwd"], "/work/project");
    assert_eq!(request["trusted"], true);
    assert!(app.write_pending);
    assert!(matches!(app.overlay(), Some(OverlayState::Confirm(_))));
    assert_eq!(app.editor.text(), "保留的输入草稿");
    std::fs::remove_file(path).unwrap();

    let mut app = active_app(true);
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 0;
    let mut flow = None;
    activate(
        &mut app,
        "trust:toggle",
        &mut pipe,
        &mut sequence,
        &mut flow,
    );
    activate(
        &mut app,
        "trust-set:false",
        &mut pipe,
        &mut sequence,
        &mut flow,
    );
    drop(pipe);
    assert_eq!(written_request(&path)["trusted"], false);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn trust_write_rejects_busy_parallel_pending_and_unleased_sessions() {
    let cases = ["active", "flow", "pending", "unleased"];
    for case in cases {
        let mut app = active_app(false);
        let mut flow = None;
        match case {
            "active" => {
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
            }
            "flow" => {
                flow = Some(SessionFlow::Reload {
                    id: "reload".to_owned(),
                })
            }
            "pending" => app.mark_write_pending(),
            "unleased" => app.clear_active_lease(),
            _ => unreachable!(),
        }
        let (mut pipe, path) = test_pipe_with_path();
        let mut sequence = 0;
        activate(
            &mut app,
            "trust-set:true",
            &mut pipe,
            &mut sequence,
            &mut flow,
        );
        drop(pipe);
        assert!(std::fs::read(&path).unwrap().is_empty(), "case: {case}");
        assert!(app.overlay_error.is_some(), "case: {case}");
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
fn trust_response_commits_only_the_requested_project_and_state() {
    let mut app = active_app(false);
    app.editor.insert("写入期间保留的草稿");
    let mut sequence = 0;
    let mut flow = None;
    let mut pipe = test_pipe();
    activate(
        &mut app,
        "trust-set:true",
        &mut pipe,
        &mut sequence,
        &mut flow,
    );
    let mut quit = false;
    apply_server_message(
        &mut app,
        &trust_response("set_project_trust:1", "/work/project", true),
        "/tmp/session.jsonl",
        &mut pipe,
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap();
    assert_eq!(
        app.trust.as_ref().and_then(|trust| trust.trusted),
        Some(true)
    );
    assert!(matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "项目信任"));
    assert_eq!(app.editor.text(), "写入期间保留的草稿");
    assert_eq!(app.toast.as_deref(), Some("项目信任已更新"));

    for response in [
        server_message(serde_json::json!({
            "type": "response",
            "id": "set_project_trust:1",
            "ok": false,
            "error": { "code": "trust_failed", "message": "资源重新加载失败" }
        })),
        trust_response("set_project_trust:1", "/other/project", true),
        trust_response("set_project_trust:1", "/work/project", false),
    ] {
        let mut app = active_app(false);
        app.editor.insert("失败后保留的草稿");
        let mut sequence = 0;
        let mut flow = None;
        let mut pipe = test_pipe();
        activate(
            &mut app,
            "trust-set:true",
            &mut pipe,
            &mut sequence,
            &mut flow,
        );
        let result = apply_server_message(
            &mut app,
            &response,
            "/tmp/session.jsonl",
            &mut pipe,
            "client",
            &mut sequence,
            &mut flow,
            &mut quit,
        );
        assert_eq!(
            app.trust.as_ref().and_then(|trust| trust.trusted),
            Some(false)
        );
        assert!(
            matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "项目信任")
                || matches!(app.overlay(), Some(OverlayState::Confirm(_)))
        );
        assert_eq!(app.editor.text(), "失败后保留的草稿");
        assert!(!app.write_pending);
        assert!(result.is_err() || app.overlay_error.is_some());
    }
}
