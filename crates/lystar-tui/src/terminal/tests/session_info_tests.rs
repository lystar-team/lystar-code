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

#[test]
fn session_command_requests_core_information_and_displays_the_complete_view() {
    let mut app = active_app();
    app.editor.insert("/session");
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

    let frames = FrameDecoder::default()
        .push(&std::fs::read(&path).unwrap())
        .unwrap();
    let request = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let request = serde_json::to_value(request.value()).unwrap();
    assert_eq!(request["request"]["command"], "get_session_info");
    assert_eq!(request["request"]["sessionPath"], "/tmp/session.jsonl");
    assert_eq!(request["request"]["leaseId"], "lease");
    assert!(matches!(
        app.overlay(),
        Some(OverlayState::Detail(detail)) if detail.lines == ["正在读取会话信息"]
    ));

    let response = server_message(serde_json::json!({
        "type": "response",
        "id": "get_session_info:1",
        "ok": true,
        "result": {
            "name": null,
            "sessionFile": null,
            "sessionId": "session-id",
            "messages": {"total": 4, "user": 1, "agent": 1, "toolCalls": 1, "toolResults": 1},
            "tokens": {"input": 1234, "output": 321, "cacheRead": 2000, "cacheWrite": 100, "total": 3655},
            "cost": 1.25,
            "usageBreakdown": [
                {"key": "openrouter/model-a", "cost": 1.0, "tokens": 3000},
                {"key": "Tools/summaries", "cost": 0.25, "tokens": 655}
            ],
            "cacheWaste": {"missedTokens": 2048, "missedCost": 0.02, "missCount": 2}
        }
    }));
    let mut response_pipe = test_pipe();
    let mut quit = false;
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

    let Some(OverlayState::Detail(detail)) = app.overlay() else {
        panic!("会话信息覆盖层没有打开");
    };
    assert_eq!(detail.title, "会话信息");
    assert_eq!(detail.status, "Esc 返回");
    assert!(detail.lines.contains(&"文件： 仅存于内存".to_owned()));
    assert!(
        detail
            .lines
            .contains(&"工具： 1 次调用，1 次返回".to_owned())
    );
    assert!(detail.lines.contains(&"输入： 3,334".to_owned()));
    assert!(
        detail
            .lines
            .contains(&"  缓存命中： 2,000 （60.0%）".to_owned())
    );
    assert!(detail.lines.contains(&"合计： $1.250".to_owned()));
    assert!(
        detail
            .lines
            .contains(&"  openrouter/model-a: $1.000 （3K Token）".to_owned())
    );
    assert!(
        detail
            .lines
            .contains(&"Cache 重复计费： $0.020 （2,048 Token，2 次未命中）".to_owned())
    );
    std::fs::remove_file(path).unwrap();
}

#[test]
fn session_command_requires_a_lease_and_rejects_invalid_results() {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/session.jsonl".to_owned(), "/work/project".to_owned());
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 0;
    request_session_info(&mut app, &mut pipe, "/tmp/session.jsonl", &mut sequence).unwrap();
    drop(pipe);
    assert!(std::fs::read(&path).unwrap().is_empty());
    assert_eq!(app.overlay_error.as_deref(), Some("尚未获取会话租约"));
    std::fs::remove_file(path).unwrap();

    let mut app = active_app();
    let mut pipe = test_pipe();
    request_session_info(&mut app, &mut pipe, "/tmp/session.jsonl", &mut sequence).unwrap();
    let invalid = server_message(serde_json::json!({
        "type": "response",
        "id": "get_session_info:1",
        "ok": true,
        "result": {
            "name": null,
            "sessionFile": null,
            "sessionId": "session-id",
            "messages": {"total": -1, "user": 0, "agent": 0, "toolCalls": 0, "toolResults": 0},
            "tokens": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
            "cost": 0,
            "usageBreakdown": [],
            "cacheWaste": {"missedTokens": 0, "missedCost": 0, "missCount": 0}
        }
    }));
    let mut flow = None;
    let mut quit = false;
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

    request_session_info(&mut app, &mut pipe, "/tmp/session.jsonl", &mut sequence).unwrap();
    let failed = server_message(serde_json::json!({
        "type": "response",
        "id": "get_session_info:2",
        "ok": false,
        "error": {"code": "session_info_failed", "message": "无法读取会话信息"}
    }));
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
    assert_eq!(app.overlay_error.as_deref(), Some("无法读取会话信息"));
}

#[test]
fn session_information_uses_the_same_compact_token_units_as_the_typescript_view() {
    assert_eq!(format_tokens(999), "999");
    assert_eq!(format_tokens(1_230), "1.23K");
    assert_eq!(format_tokens(100_000), "100K");
    assert_eq!(format_tokens(1_000_000), "1M");
}

#[test]
fn command_palette_exposes_session_information() {
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

    let Some(OverlayState::List(palette)) = app.overlay() else {
        panic!("命令面板没有打开");
    };
    assert!(
        palette
            .items
            .iter()
            .any(|item| item.label == "/session" && item.action == "open:session")
    );
}
