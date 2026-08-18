use super::*;

fn active_app() -> AppState {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/session.jsonl".to_owned(), "/work/project".to_owned());
    let mut snapshot = snapshot_value("/tmp/session.jsonl");
    snapshot["model"] = serde_json::json!({ "provider": "faux", "id": "current" });
    app.apply_active_lease(
        "lease".to_owned(),
        serde_json::from_value(snapshot).unwrap(),
    );
    app
}

fn model(provider: &str, id: &str, name: &str, authenticated: bool) -> serde_json::Value {
    serde_json::json!({
        "provider": provider,
        "id": id,
        "name": name,
        "api": "openai-completions",
        "reasoning": true,
        "input": ["text"],
        "contextWindow": 128000,
        "maxTokens": 4096,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "supportedThinkingLevels": ["off", "high"],
        "authenticated": authenticated,
        "authMethods": ["api_key"]
    })
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

fn submit_model(app: &mut AppState) -> (Vec<u8>, u64, Option<SessionFlow>) {
    app.editor.insert("/model");
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
    (bytes, sequence, flow)
}

fn apply_models(
    app: &mut AppState,
    sequence: &mut u64,
    flow: &mut Option<SessionFlow>,
    models: serde_json::Value,
) {
    let response = server_message(serde_json::json!({
        "type": "response",
        "id": "list_models:1",
        "ok": true,
        "result": models
    }));
    let mut pipe = test_pipe();
    let mut quit = false;
    apply_server_message(
        app,
        &response,
        "/tmp/session.jsonl",
        &mut pipe,
        "client",
        sequence,
        flow,
        &mut quit,
    )
    .unwrap();
}

#[test]
fn model_command_lists_models_selects_current_and_supports_search_cancel_and_empty_results() {
    let mut app = active_app();
    let (bytes, mut sequence, mut flow) = submit_model(&mut app);
    let frames = FrameDecoder::default().push(&bytes).unwrap();
    let request = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let request = serde_json::to_value(request.value()).unwrap();
    assert_eq!(
        request["request"],
        serde_json::json!({ "command": "list_models" })
    );
    assert_eq!(builtin_slash_command(" /model "), Some("model"));
    assert!(matches!(
        app.overlay(),
        Some(OverlayState::Detail(detail)) if detail.lines == ["正在读取模型"]
    ));

    apply_models(
        &mut app,
        &mut sequence,
        &mut flow,
        serde_json::json!([
            model("other", "unavailable", "未认证模型", false),
            model("faux", "current", "当前模型", true),
            model("faux", "next", "下一个模型", true)
        ]),
    );
    let Some(OverlayState::List(list)) = app.overlay() else {
        panic!("模型列表没有打开");
    };
    assert_eq!(list.title, "模型");
    assert_eq!(list.selected, 1);
    assert!(list.items[1].detail.contains("faux/current"));
    assert!(list.items[1].detail.contains("当前"));
    assert_eq!(
        list.items[0].action,
        "disabled:该模型不可用，Provider 未完成认证"
    );

    app.overlay_insert("next");
    assert_eq!(app.current_overlay_action().as_deref(), Some("model:2"));
    let mut pipe = test_pipe();
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
    assert!(app.overlay().is_none());
    assert_eq!(
        app.snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.model.as_ref())
            .map(|model| model.id.as_str()),
        Some("current")
    );

    let (bytes, mut sequence, mut flow) = submit_model(&mut app);
    assert!(!bytes.is_empty());
    apply_models(&mut app, &mut sequence, &mut flow, serde_json::json!([]));
    assert!(matches!(
        app.overlay(),
        Some(OverlayState::List(list)) if list.items.is_empty() && list.status.contains("Esc")
    ));

    let mut app = active_app();
    app.editor.insert("/model faux/next");
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
    assert!(!std::fs::read(&path).unwrap().is_empty());
    std::fs::remove_file(path).unwrap();
    apply_models(
        &mut app,
        &mut sequence,
        &mut flow,
        serde_json::json!([
            model("faux", "current", "当前模型", true),
            model("faux", "next", "下一个模型", true)
        ]),
    );
    assert!(matches!(
        app.overlay(),
        Some(OverlayState::List(list))
            if list.filter == "faux/next" && app.current_overlay_action().as_deref() == Some("model:1")
    ));
}

#[test]
fn model_selection_uses_the_leased_write_contract_and_commits_only_the_selected_model() {
    let mut app = active_app();
    let (_, mut sequence, mut flow) = submit_model(&mut app);
    apply_models(
        &mut app,
        &mut sequence,
        &mut flow,
        serde_json::json!([
            model("faux", "current", "当前模型", true),
            model("faux", "next", "下一个模型", true)
        ]),
    );
    app.move_overlay_selection(1);
    app.editor.insert("切换期间保留的草稿");
    let (mut pipe, path) = test_pipe_with_path();
    let mut quit = false;
    handle_key(
        &mut app,
        KeyCode::Enter,
        KeyModifiers::NONE,
        &mut pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap();
    drop(pipe);
    let bytes = std::fs::read(&path).unwrap();
    std::fs::remove_file(path).unwrap();
    let frames = FrameDecoder::default().push(&bytes).unwrap();
    let request = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let request = serde_json::to_value(request.value()).unwrap();
    assert_eq!(request["request"]["command"], "set_session_model");
    assert_eq!(request["request"]["sessionPath"], "/tmp/session.jsonl");
    assert_eq!(request["request"]["leaseId"], "lease");
    assert_eq!(request["request"]["clientInstanceId"], "client");
    assert_eq!(request["request"]["clientRequestId"], "model:faux:next:2");
    assert_eq!(
        request["request"]["model"],
        serde_json::json!({ "provider": "faux", "id": "next" })
    );
    assert!(app.write_pending);

    let mut snapshot = snapshot_value("/tmp/session.jsonl");
    snapshot["revision"] = serde_json::json!(2);
    snapshot["model"] = serde_json::json!({ "provider": "faux", "id": "next" });
    let response = server_message(serde_json::json!({
        "type": "response",
        "id": "set_session_model:2",
        "ok": true,
        "result": snapshot
    }));
    let mut response_pipe = test_pipe();
    apply_server_message(
        &mut app,
        &response,
        "/tmp/session.jsonl",
        &mut response_pipe,
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap();

    assert!(!app.write_pending);
    assert!(app.overlay().is_none());
    assert_eq!(
        app.snapshot.as_ref().map(|snapshot| snapshot.revision),
        Some(2)
    );
    assert_eq!(
        app.snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.model.as_ref())
            .map(|model| model.id.as_str()),
        Some("next")
    );
    assert_eq!(app.editor.text(), "切换期间保留的草稿");
    assert_eq!(app.toast.as_deref(), Some("当前模型：next"));
}

#[test]
fn model_command_rejects_running_unleased_parallel_and_concurrent_writes() {
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
    let (bytes, _, _) = submit_model(&mut app);
    assert!(bytes.is_empty());
    assert_eq!(
        app.overlay_error.as_deref(),
        Some("当前会话正在运行，不能切换模型")
    );

    let mut app = active_app();
    app.clear_active_lease();
    let (bytes, _, _) = submit_model(&mut app);
    assert!(bytes.is_empty());
    assert_eq!(app.transcript.status, "正在获取会话租约");
    let mut pipe = test_pipe();
    let mut sequence = 0;
    open_model_selector(&mut app, &mut pipe, &mut sequence, &None, String::new()).unwrap();
    assert_eq!(app.overlay_error.as_deref(), Some("尚未获取会话租约"));

    let mut app = active_app();
    let mut pipe = test_pipe();
    let mut sequence = 0;
    let flow = Some(SessionFlow::Reload {
        id: "existing".to_owned(),
    });
    open_model_selector(&mut app, &mut pipe, &mut sequence, &flow, String::new()).unwrap();
    assert_eq!(app.overlay_error.as_deref(), Some("会话操作正在进行"));

    let mut app = active_app();
    app.write_pending = true;
    open_model_selector(&mut app, &mut pipe, &mut sequence, &None, String::new()).unwrap();
    assert_eq!(app.overlay_error.as_deref(), Some("正在写入，请稍候"));
}

#[test]
fn model_failure_or_invalid_result_preserves_the_previous_model_overlay_and_draft() {
    let mut app = active_app();
    let (_, mut sequence, mut flow) = submit_model(&mut app);
    apply_models(
        &mut app,
        &mut sequence,
        &mut flow,
        serde_json::json!([
            model("faux", "current", "当前模型", true),
            model("faux", "next", "下一个模型", true)
        ]),
    );
    app.move_overlay_selection(1);
    app.editor.insert("失败后保留的草稿");
    let mut request_pipe = test_pipe();
    handle_model_action(
        &mut app,
        "model:1",
        &mut request_pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        &flow,
    )
    .unwrap();
    let failed = server_message(serde_json::json!({
        "type": "response",
        "id": "set_session_model:2",
        "ok": false,
        "error": { "code": "model_failed", "message": "Provider 拒绝切换" }
    }));
    let mut quit = false;
    apply_server_message(
        &mut app,
        &failed,
        "/tmp/session.jsonl",
        &mut request_pipe,
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap();
    assert!(!app.write_pending);
    assert!(matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "模型"));
    assert_eq!(app.overlay_error.as_deref(), Some("Provider 拒绝切换"));
    assert_eq!(app.editor.text(), "失败后保留的草稿");
    assert_eq!(
        app.snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.model.as_ref())
            .map(|model| model.id.as_str()),
        Some("current")
    );

    handle_model_action(
        &mut app,
        "model:1",
        &mut request_pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        &flow,
    )
    .unwrap();
    let mut invalid = snapshot_value("/tmp/session.jsonl");
    invalid["model"] = serde_json::json!({ "provider": "faux", "id": "next" });
    invalid["unexpected"] = serde_json::json!(true);
    let invalid = server_message(serde_json::json!({
        "type": "response",
        "id": "set_session_model:3",
        "ok": true,
        "result": invalid
    }));
    let error = apply_server_message(
        &mut app,
        &invalid,
        "/tmp/session.jsonl",
        &mut request_pipe,
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap_err();
    assert!(matches!(error, TuiError::Protocol(_)));
    assert!(!app.write_pending);
    assert_eq!(app.editor.text(), "失败后保留的草稿");
    assert_eq!(
        app.snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.model.as_ref())
            .map(|model| model.id.as_str()),
        Some("current")
    );

    handle_model_action(
        &mut app,
        "model:1",
        &mut request_pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        &flow,
    )
    .unwrap();
    let mut wrong_model = snapshot_value("/tmp/session.jsonl");
    wrong_model["model"] = serde_json::json!({ "provider": "faux", "id": "current" });
    let wrong_model = server_message(serde_json::json!({
        "type": "response",
        "id": "set_session_model:4",
        "ok": true,
        "result": wrong_model
    }));
    let error = apply_server_message(
        &mut app,
        &wrong_model,
        "/tmp/session.jsonl",
        &mut request_pipe,
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap_err();
    assert!(matches!(error, TuiError::InvalidResponse(_)));
    assert_eq!(
        app.snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.model.as_ref())
            .map(|model| model.id.as_str()),
        Some("current")
    );
}

#[test]
fn command_palette_exposes_model_selection() {
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
            if palette.items.iter().any(|item| item.label == "/model" && item.action == "open:model")
    ));
}
