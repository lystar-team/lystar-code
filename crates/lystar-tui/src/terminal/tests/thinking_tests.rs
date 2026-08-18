use super::*;

fn active_app(level: &str) -> AppState {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/session.jsonl".to_owned(), "/work/project".to_owned());
    let mut snapshot = snapshot_value("/tmp/session.jsonl");
    snapshot["model"] = serde_json::json!({ "provider": "faux", "id": "reasoning" });
    snapshot["thinkingLevel"] = serde_json::json!(level);
    app.apply_active_lease(
        "lease".to_owned(),
        serde_json::from_value(snapshot).unwrap(),
    );
    app
}

fn model(
    provider: &str,
    id: &str,
    reasoning: bool,
    authenticated: bool,
    levels: &[&str],
) -> serde_json::Value {
    serde_json::json!({
        "provider": provider,
        "id": id,
        "name": id,
        "api": "openai-completions",
        "reasoning": reasoning,
        "input": ["text"],
        "contextWindow": 128000,
        "maxTokens": 4096,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "supportedThinkingLevels": levels,
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

fn submit_thinking(app: &mut AppState) -> (Vec<u8>, u64, Option<SessionFlow>) {
    app.editor.insert("/thinking");
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
fn thinking_command_lists_only_supported_levels_selects_current_and_cancels() {
    let mut app = active_app("medium");
    let (bytes, mut sequence, mut flow) = submit_thinking(&mut app);
    let frames = FrameDecoder::default().push(&bytes).unwrap();
    let request = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let request = serde_json::to_value(request.value()).unwrap();
    assert_eq!(
        request["request"],
        serde_json::json!({ "command": "list_models" })
    );
    assert!(matches!(
        app.overlay(),
        Some(OverlayState::Detail(detail)) if detail.lines == ["正在读取模型能力"]
    ));

    apply_models(
        &mut app,
        &mut sequence,
        &mut flow,
        serde_json::json!([
            model("faux", "reasoning", true, true, &["off", "medium", "high"]),
            model("faux", "other", true, true, &["off", "max"])
        ]),
    );
    let Some(OverlayState::List(list)) = app.overlay() else {
        panic!("思考强度列表没有打开");
    };
    assert_eq!(list.title, "思考");
    assert_eq!(list.selected, 1);
    assert_eq!(
        list.items
            .iter()
            .map(|item| item.action.as_str())
            .collect::<Vec<_>>(),
        ["thinking:off", "thinking:medium", "thinking:high"]
    );
    assert!(list.items[1].detail.contains("约 8k tokens"));
    assert!(list.items[1].detail.contains("当前"));
    assert!(!list.items.iter().any(|item| item.action == "thinking:max"));

    app.editor.insert("取消后保留的草稿");
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
    assert_eq!(app.editor.text(), "取消后保留的草稿");
    assert_eq!(
        app.snapshot
            .as_ref()
            .map(|snapshot| snapshot.thinking_level.as_str()),
        Some("medium")
    );
}

#[test]
fn thinking_selection_uses_the_leased_write_contract_and_commits_the_requested_level() {
    let mut app = active_app("off");
    let (_, mut sequence, mut flow) = submit_thinking(&mut app);
    apply_models(
        &mut app,
        &mut sequence,
        &mut flow,
        serde_json::json!([model("faux", "reasoning", true, true, &["off", "high"])]),
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
    assert_eq!(request["request"]["command"], "set_session_thinking");
    assert_eq!(request["request"]["sessionPath"], "/tmp/session.jsonl");
    assert_eq!(request["request"]["leaseId"], "lease");
    assert_eq!(request["request"]["clientInstanceId"], "client");
    assert_eq!(request["request"]["clientRequestId"], "thinking:high:2");
    assert_eq!(request["request"]["level"], "high");
    assert!(app.write_pending);

    let mut snapshot = snapshot_value("/tmp/session.jsonl");
    snapshot["revision"] = serde_json::json!(2);
    snapshot["model"] = serde_json::json!({ "provider": "faux", "id": "reasoning" });
    snapshot["thinkingLevel"] = serde_json::json!("high");
    let response = server_message(serde_json::json!({
        "type": "response",
        "id": "set_session_thinking:2",
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
        app.snapshot
            .as_ref()
            .map(|snapshot| snapshot.thinking_level.as_str()),
        Some("high")
    );
    assert_eq!(app.editor.text(), "切换期间保留的草稿");
    assert_eq!(app.toast.as_deref(), Some("思考强度：高"));
}

#[test]
fn thinking_command_rejects_running_unleased_parallel_and_concurrent_writes() {
    let mut app = active_app("off");
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
    let (bytes, _, _) = submit_thinking(&mut app);
    assert!(bytes.is_empty());
    assert_eq!(
        app.overlay_error.as_deref(),
        Some("当前会话正在运行，不能切换思考强度")
    );

    let mut app = active_app("off");
    app.clear_active_lease();
    let (bytes, _, _) = submit_thinking(&mut app);
    assert!(bytes.is_empty());
    assert_eq!(app.transcript.status, "正在获取会话租约");
    let mut pipe = test_pipe();
    let mut sequence = 0;
    open_thinking_selector(&mut app, &mut pipe, &mut sequence, &None).unwrap();
    assert_eq!(app.overlay_error.as_deref(), Some("尚未获取会话租约"));

    let mut app = active_app("off");
    let flow = Some(SessionFlow::Reload {
        id: "existing".to_owned(),
    });
    open_thinking_selector(&mut app, &mut pipe, &mut sequence, &flow).unwrap();
    assert_eq!(app.overlay_error.as_deref(), Some("会话操作正在进行"));

    let mut app = active_app("off");
    app.write_pending = true;
    open_thinking_selector(&mut app, &mut pipe, &mut sequence, &None).unwrap();
    assert_eq!(app.overlay_error.as_deref(), Some("正在写入，请稍候"));

    let mut app = active_app("off");
    app.models = parse_models(&serde_json::json!([model(
        "faux",
        "reasoning",
        true,
        true,
        &["off", "high"]
    )]))
    .unwrap();
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
    assert!(
        handle_thinking_action(
            &mut app,
            "thinking:high",
            &mut pipe,
            "/tmp/session.jsonl",
            "client",
            &mut sequence,
            &None,
        )
        .unwrap()
    );
    assert_eq!(
        app.overlay_error.as_deref(),
        Some("当前会话正在运行，不能切换思考强度")
    );
    app.operation = None;
    app.clear_active_lease();
    handle_thinking_action(
        &mut app,
        "thinking:high",
        &mut pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        &None,
    )
    .unwrap();
    assert_eq!(app.overlay_error.as_deref(), Some("尚未获取会话租约"));
}

#[test]
fn thinking_overlay_reports_missing_auth_and_non_reasoning_models() {
    for (catalog, message) in [
        (
            serde_json::json!([model("faux", "reasoning", true, false, &["off", "high"])]),
            "当前模型未完成认证",
        ),
        (
            serde_json::json!([model("faux", "reasoning", false, true, &["off"])]),
            "当前模型不支持思考强度",
        ),
        (
            serde_json::json!([model("faux", "reasoning", true, true, &[])]),
            "当前模型没有可用思考强度",
        ),
        (serde_json::json!([]), "当前模型不可用或未完成认证"),
    ] {
        let mut app = active_app("off");
        let (_, mut sequence, mut flow) = submit_thinking(&mut app);
        apply_models(&mut app, &mut sequence, &mut flow, catalog);
        assert!(matches!(
            app.overlay(),
            Some(OverlayState::List(list))
                if list.items.len() == 1
                    && list.items[0].action == format!("disabled:{message}")
        ));
    }
}

#[test]
fn thinking_failure_or_invalid_result_preserves_state_and_all_entry_points_share_the_selector() {
    let mut app = active_app("off");
    let (_, mut sequence, mut flow) = submit_thinking(&mut app);
    apply_models(
        &mut app,
        &mut sequence,
        &mut flow,
        serde_json::json!([model("faux", "reasoning", true, true, &["off", "high"])]),
    );
    app.editor.insert("失败后保留的草稿");
    let mut pipe = test_pipe();
    handle_thinking_action(
        &mut app,
        "thinking:high",
        &mut pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        &flow,
    )
    .unwrap();
    let mut broadcast = snapshot_value("/tmp/session.jsonl");
    broadcast["model"] = serde_json::json!({ "provider": "faux", "id": "reasoning" });
    broadcast["thinkingLevel"] = serde_json::json!("high");
    apply_event(
        &mut app,
        &ReadOnlyEvent::SessionSnapshot {
            snapshot: serde_json::from_value(broadcast).unwrap(),
        },
        "/tmp/session.jsonl",
    )
    .unwrap();
    assert_eq!(
        app.snapshot
            .as_ref()
            .map(|snapshot| snapshot.thinking_level.as_str()),
        Some("off")
    );

    let failed = server_message(serde_json::json!({
        "type": "response",
        "id": "set_session_thinking:2",
        "ok": false,
        "error": { "code": "thinking_failed", "message": "Provider 拒绝切换" }
    }));
    let mut quit = false;
    apply_server_message(
        &mut app,
        &failed,
        "/tmp/session.jsonl",
        &mut pipe,
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap();
    assert!(!app.write_pending);
    assert!(matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "思考"));
    assert_eq!(app.overlay_error.as_deref(), Some("Provider 拒绝切换"));
    assert_eq!(app.editor.text(), "失败后保留的草稿");
    assert_eq!(
        app.snapshot
            .as_ref()
            .map(|snapshot| snapshot.thinking_level.as_str()),
        Some("off")
    );

    handle_thinking_action(
        &mut app,
        "thinking:high",
        &mut pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        &flow,
    )
    .unwrap();
    let mut invalid = snapshot_value("/tmp/session.jsonl");
    invalid["model"] = serde_json::json!({ "provider": "faux", "id": "reasoning" });
    invalid["thinkingLevel"] = serde_json::json!("high");
    invalid["unexpected"] = serde_json::json!(true);
    let invalid = server_message(serde_json::json!({
        "type": "response",
        "id": "set_session_thinking:3",
        "ok": true,
        "result": invalid
    }));
    let error = apply_server_message(
        &mut app,
        &invalid,
        "/tmp/session.jsonl",
        &mut pipe,
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap_err();
    assert!(matches!(error, TuiError::Protocol(_)));
    assert!(!app.write_pending);

    handle_thinking_action(
        &mut app,
        "thinking:high",
        &mut pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        &flow,
    )
    .unwrap();
    let mut wrong = snapshot_value("/tmp/session.jsonl");
    wrong["model"] = serde_json::json!({ "provider": "faux", "id": "reasoning" });
    wrong["thinkingLevel"] = serde_json::json!("off");
    let wrong = server_message(serde_json::json!({
        "type": "response",
        "id": "set_session_thinking:4",
        "ok": true,
        "result": wrong
    }));
    let error = apply_server_message(
        &mut app,
        &wrong,
        "/tmp/session.jsonl",
        &mut pipe,
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
            .map(|snapshot| snapshot.thinking_level.as_str()),
        Some("off")
    );
    assert_eq!(app.editor.text(), "失败后保留的草稿");

    for (path, provider, id) in [
        ("/tmp/other.jsonl", "faux", "reasoning"),
        ("/tmp/session.jsonl", "other", "reasoning"),
    ] {
        let mut result = snapshot_value(path);
        result["model"] = serde_json::json!({ "provider": provider, "id": id });
        result["thinkingLevel"] = serde_json::json!("high");
        assert!(matches!(
            apply_thinking_mutation_result(
                &mut app,
                result,
                "/tmp/session.jsonl",
                "faux",
                "reasoning",
                "high",
            ),
            Err(TuiError::InvalidResponse(_))
        ));
    }

    let mut palette_app = AppState::default();
    let mut palette_flow = None;
    handle_key(
        &mut palette_app,
        KeyCode::Char('p'),
        KeyModifiers::CONTROL,
        &mut pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        &mut palette_flow,
        &mut quit,
    )
    .unwrap();
    assert!(matches!(
        palette_app.overlay(),
        Some(OverlayState::List(palette))
            if palette.items.iter().any(|item| item.label == "/thinking" && item.action == "open:thinking")
    ));

    let mut shortcut_app = active_app("off");
    apply_extension_editor_app_action(
        &mut shortcut_app,
        "app.thinking.toggle",
        &mut pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        &mut None,
        &mut quit,
    )
    .unwrap();
    assert!(matches!(
        shortcut_app.overlay(),
        Some(OverlayState::Detail(detail)) if detail.lines == ["正在读取模型能力"]
    ));
}
