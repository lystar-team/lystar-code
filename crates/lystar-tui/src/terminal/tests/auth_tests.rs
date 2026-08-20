use super::*;

fn provider(
    id: &str,
    name: &str,
    authenticated: bool,
    auth_methods: &[&str],
    auth_source: Option<&str>,
) -> serde_json::Value {
    let mut value = serde_json::json!({
        "id": id,
        "name": name,
        "authenticated": authenticated,
        "authMethods": auth_methods,
        "modelCount": 1,
        "builtIn": true,
        "custom": false
    });
    if let Some(source) = auth_source {
        value["authSource"] = serde_json::json!(source);
    }
    value
}

fn model(provider: &str, authenticated: bool) -> serde_json::Value {
    serde_json::json!({
        "provider": provider,
        "id": "model",
        "name": "Model",
        "api": "openai-completions",
        "reasoning": false,
        "input": ["text"],
        "contextWindow": 128000,
        "maxTokens": 4096,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "supportedThinkingLevels": ["off"],
        "authenticated": authenticated,
        "authMethods": ["api_key", "oauth"]
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

fn active_app() -> AppState {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/session.jsonl".to_owned(), "/work/project".to_owned());
    app.apply_active_lease(
        "lease".to_owned(),
        serde_json::from_value(snapshot_value("/tmp/session.jsonl")).unwrap(),
    );
    app
}

fn submit_auth(app: &mut AppState, text: &str) -> (Vec<u8>, u64, Option<SessionFlow>) {
    app.editor.insert(text);
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

fn apply_message(
    app: &mut AppState,
    message: lystar_protocol::ServerMessage,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
    flow: &mut Option<SessionFlow>,
) -> Result<(), TuiError> {
    let mut quit = false;
    apply_server_message(
        app,
        &message,
        "/tmp/session.jsonl",
        pipe,
        "client",
        sequence,
        flow,
        &mut quit,
    )
    .map(|_| ())
}

fn apply_provider_list(
    app: &mut AppState,
    sequence: &mut u64,
    flow: &mut Option<SessionFlow>,
    providers: serde_json::Value,
) {
    let mut pipe = test_pipe();
    apply_message(
        app,
        server_message(serde_json::json!({
            "type": "response",
            "id": "list_model_providers:1",
            "ok": true,
            "result": providers
        })),
        &mut pipe,
        sequence,
        flow,
    )
    .unwrap();
}

#[test]
fn auth_commands_list_and_filter_login_and_only_offer_stored_credentials_for_logout() {
    let mut app = active_app();
    let (bytes, mut sequence, mut flow) = submit_auth(&mut app, "/login openai");
    let frames = FrameDecoder::default().push(&bytes).unwrap();
    let request = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let request = serde_json::to_value(request.value()).unwrap();
    assert_eq!(request["request"]["command"], "list_model_providers");
    assert_eq!(
        auth_command(" /login openai "),
        Some(("login", "openai".to_owned()))
    );
    assert_eq!(auth_command("/logout"), Some(("logout", String::new())));

    apply_provider_list(
        &mut app,
        &mut sequence,
        &mut flow,
        serde_json::json!([
            provider("faux", "Faux", false, &["api_key"], None),
            provider(
                "openai",
                "OpenAI",
                true,
                &["api_key", "oauth"],
                Some("stored")
            )
        ]),
    );
    assert!(matches!(
        app.overlay(),
        Some(OverlayState::List(list)) if list.title == "OpenAI 登录方式" && list.items.len() == 2
    ));

    let mut filtered = active_app();
    let (_, mut filtered_sequence, mut filtered_flow) = submit_auth(&mut filtered, "/login open");
    apply_provider_list(
        &mut filtered,
        &mut filtered_sequence,
        &mut filtered_flow,
        serde_json::json!([
            provider("faux", "Faux", false, &["api_key"], None),
            provider("openai", "OpenAI", false, &["api_key", "oauth"], None)
        ]),
    );
    assert!(matches!(
        filtered.overlay(),
        Some(OverlayState::List(list))
            if list.title == "登录"
                && list.filter == "open"
                && filtered.current_overlay_action().as_deref() == Some("login-provider:1")
    ));

    let mut app = active_app();
    let (_, mut sequence, mut flow) = submit_auth(&mut app, "/logout");
    apply_provider_list(
        &mut app,
        &mut sequence,
        &mut flow,
        serde_json::json!([
            provider("stored", "Stored", true, &["api_key"], Some("stored")),
            provider(
                "env",
                "Environment",
                true,
                &["api_key"],
                Some("OPENAI_API_KEY")
            ),
            provider("empty", "Empty", false, &["api_key"], None)
        ]),
    );
    assert!(matches!(
        app.overlay(),
        Some(OverlayState::List(list))
            if list.title == "退出登录"
                && list.items.len() == 1
                && list.items[0].action == "auth-logout:0"
                && list.status.contains("环境变量和 models.json 不受影响")
    ));
}

#[test]
fn exact_provider_with_one_auth_method_starts_login_immediately() {
    let mut app = active_app();
    let (_, mut sequence, mut flow) = submit_auth(&mut app, "/login OpenAI");
    let (mut pipe, path) = test_pipe_with_path();
    let response = server_message(serde_json::json!({
        "type": "response",
        "id": "list_model_providers:1",
        "ok": true,
        "result": [provider("openai", "OpenAI", false, &["api_key"], None)]
    }));
    apply_message(&mut app, response, &mut pipe, &mut sequence, &mut flow).unwrap();
    drop(pipe);
    let frames = FrameDecoder::default()
        .push(&std::fs::read(&path).unwrap())
        .unwrap();
    std::fs::remove_file(path).unwrap();
    let request = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let request = serde_json::to_value(request.value()).unwrap();
    assert_eq!(request["request"]["command"], "login_model_provider");
    assert_eq!(request["request"]["provider"], "openai");
    assert_eq!(request["request"]["authType"], "api_key");
    assert!(app.write_pending);
    assert!(app.overlay().is_none());
}

#[test]
fn login_uses_journaled_provider_write_and_secret_and_oauth_ui_never_echo_credentials() {
    let mut app = active_app();
    let (_, mut sequence, mut flow) = submit_auth(&mut app, "/login");
    apply_provider_list(
        &mut app,
        &mut sequence,
        &mut flow,
        serde_json::json!([provider(
            "openai",
            "OpenAI",
            false,
            &["api_key", "oauth"],
            None
        )]),
    );
    let mut pipe = test_pipe();
    handle_auth_action(
        &mut app,
        "login-provider:0",
        &mut pipe,
        "client",
        &mut sequence,
        &flow,
    )
    .unwrap();
    assert!(matches!(
        app.overlay(),
        Some(OverlayState::List(list)) if list.title == "OpenAI 登录方式"
    ));

    let (mut request_pipe, path) = test_pipe_with_path();
    handle_auth_action(
        &mut app,
        "auth-login:0:0",
        &mut request_pipe,
        "client",
        &mut sequence,
        &flow,
    )
    .unwrap();
    drop(request_pipe);
    let bytes = std::fs::read(&path).unwrap();
    std::fs::remove_file(path).unwrap();
    let frames = FrameDecoder::default().push(&bytes).unwrap();
    let request = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let request = serde_json::to_value(request.value()).unwrap();
    assert_eq!(request["request"]["command"], "login_model_provider");
    assert_eq!(request["request"]["provider"], "openai");
    assert_eq!(request["request"]["authType"], "api_key");
    assert_eq!(request["request"]["clientInstanceId"], "client");
    assert_eq!(request["request"]["clientRequestId"], "auth:login:openai:2");
    assert!(app.write_pending);
    assert!(matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "登录"));

    let mut ui_pipe = test_pipe();
    apply_message(
        &mut app,
        server_message(serde_json::json!({
            "type": "event",
            "event": {
                "type": "ui_request",
                "id": "secret-1",
                "operationId": "models-auth:request",
                "kind": "secret",
                "title": "API Key",
                "payload": { "message": "输入 API Key" }
            }
        })),
        &mut ui_pipe,
        &mut sequence,
        &mut flow,
    )
    .unwrap();
    assert!(matches!(
        app.overlay(),
        Some(OverlayState::TextEditor(editor)) if editor.secret && editor.value.is_empty()
    ));
    assert!(!format!("{app:?}").contains("credential-secret"));

    apply_message(
        &mut app,
        server_message(serde_json::json!({
            "type": "event",
            "event": {
                "type": "ui_request",
                "id": "oauth-device",
                "operationId": "models-auth:request",
                "kind": "notify",
                "title": "模型认证",
                "payload": {
                    "method": "auth_device_code",
                    "userCode": "ABCD-EFGH",
                    "verificationUri": "https://example.test/device"
                }
            }
        })),
        &mut ui_pipe,
        &mut sequence,
        &mut flow,
    )
    .unwrap();
    assert!(matches!(
        app.overlay(),
        Some(OverlayState::TextEditor(editor)) if editor.secret && editor.value.is_empty()
    ));
    assert!(
        app.active_ui_request
            .as_ref()
            .is_some_and(|request| request.id == "secret-1")
    );
}

#[test]
fn auth_secret_submit_and_cancel_clear_rust_state_and_oauth_notifications_share_one_page() {
    let mut app = active_app();
    app.providers = parse_providers(&serde_json::json!([provider(
        "openai",
        "OpenAI",
        false,
        &["api_key", "oauth"],
        None
    )]))
    .unwrap();
    app.open_overlay(auth_overlay(&app.providers, "login", None, String::new()));
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 0;
    let mut flow = None;

    for (id, code) in [
        ("secret-submit", KeyCode::Enter),
        ("secret-cancel", KeyCode::Esc),
    ] {
        apply_message(
            &mut app,
            server_message(serde_json::json!({
                "type": "event",
                "event": {
                    "type": "ui_request",
                    "id": id,
                    "operationId": "models-auth:request",
                    "kind": "secret",
                    "title": "API Key",
                    "payload": { "message": "输入 API Key" }
                }
            })),
            &mut pipe,
            &mut sequence,
            &mut flow,
        )
        .unwrap();
        app.overlay_insert("credential-secret");
        handle_overlay_key(
            &mut app,
            code,
            KeyModifiers::NONE,
            &mut pipe,
            "/tmp/session.jsonl",
            "client",
            &mut sequence,
            &mut flow,
        )
        .unwrap();
        assert!(app.active_ui_request.is_none());
        assert!(!format!("{app:?}").contains("credential-secret"));
        assert!(matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "登录"));
    }

    let auth_depth = app.overlays.len();
    for (id, message) in [
        ("oauth-start", "正在打开浏览器"),
        ("oauth-wait", "正在等待认证"),
    ] {
        apply_message(
            &mut app,
            server_message(serde_json::json!({
                "type": "event",
                "event": {
                    "type": "ui_request",
                    "id": id,
                    "operationId": "models-auth:request",
                    "kind": "notify",
                    "title": "模型认证",
                    "payload": { "method": "auth_progress", "message": message }
                }
            })),
            &mut pipe,
            &mut sequence,
            &mut flow,
        )
        .unwrap();
    }
    assert_eq!(app.overlays.len(), auth_depth + 1);
    assert!(matches!(
        app.overlay(),
        Some(OverlayState::Detail(detail))
            if detail.lines.iter().any(|line| line.contains("正在等待认证"))
    ));

    drop(pipe);
    let frames = FrameDecoder::default()
        .push(&std::fs::read(&path).unwrap())
        .unwrap();
    std::fs::remove_file(path).unwrap();
    assert_eq!(frames.len(), 2);
    let submitted = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let submitted = serde_json::to_value(submitted.value()).unwrap();
    assert_eq!(submitted["type"], "ui_response");
    assert_eq!(submitted["id"], "secret-submit");
    assert_eq!(submitted["value"], "credential-secret");
    assert!(submitted.get("cancelled").is_none());
    let cancelled = lystar_protocol::decode_client_message(&frames[1]).unwrap();
    let cancelled = serde_json::to_value(cancelled.value()).unwrap();
    assert_eq!(cancelled["type"], "ui_response");
    assert_eq!(cancelled["id"], "secret-cancel");
    assert_eq!(cancelled["cancelled"], true);
    assert!(cancelled.get("value").is_none());
}

#[test]
fn auth_commits_models_only_after_provider_verification_and_logout_accepts_environment_fallback() {
    let mut app = active_app();
    app.providers = parse_providers(&serde_json::json!([provider(
        "openai",
        "OpenAI",
        false,
        &["api_key"],
        None
    )]))
    .unwrap();
    app.open_overlay(auth_overlay(&app.providers, "login", None, String::new()));
    let mut sequence = 1;
    let mut flow = None;
    let (mut pipe, path) = test_pipe_with_path();
    handle_auth_action(
        &mut app,
        "auth-login:0:0",
        &mut pipe,
        "client",
        &mut sequence,
        &flow,
    )
    .unwrap();
    let original_models = app.models.clone();
    apply_message(
        &mut app,
        server_message(serde_json::json!({
            "type": "response",
            "id": "login_model_provider:2",
            "ok": true,
            "result": [model("openai", true)]
        })),
        &mut pipe,
        &mut sequence,
        &mut flow,
    )
    .unwrap();
    assert_eq!(app.models, original_models);
    assert!(app.write_pending);
    drop(pipe);
    let frames = FrameDecoder::default()
        .push(&std::fs::read(&path).unwrap())
        .unwrap();
    std::fs::remove_file(path).unwrap();
    assert_eq!(frames.len(), 2);
    let verify = lystar_protocol::decode_client_message(&frames[1]).unwrap();
    assert_eq!(
        serde_json::to_value(verify.value()).unwrap()["request"]["command"],
        "list_model_providers"
    );

    let mut response_pipe = test_pipe();
    apply_message(
        &mut app,
        server_message(serde_json::json!({
            "type": "response",
            "id": "list_model_providers:3",
            "ok": true,
            "result": [provider("openai", "OpenAI", true, &["api_key"], Some("stored"))]
        })),
        &mut response_pipe,
        &mut sequence,
        &mut flow,
    )
    .unwrap();
    assert!(!app.write_pending);
    assert!(
        app.models
            .iter()
            .any(|model| model.provider == "openai" && model.configured)
    );
    assert_eq!(app.toast.as_deref(), Some("已更新 OpenAI 认证"));
    assert!(matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "登录"));

    let models = parse_models(&serde_json::json!([model("openai", true)])).unwrap();
    apply_auth_verify_result(
        &mut app,
        serde_json::json!([provider(
            "openai",
            "OpenAI",
            true,
            &["api_key"],
            Some("OPENAI_API_KEY")
        )]),
        "openai",
        None,
        String::new(),
        models,
    )
    .unwrap();
    assert_eq!(app.toast.as_deref(), Some("已删除 OpenAI 保存的凭据"));
    assert!(matches!(
        app.overlay(),
        Some(OverlayState::List(list)) if list.title == "退出登录" && list.items.is_empty()
    ));

    let previous_models = app.models.clone();
    let error = apply_auth_verify_result(
        &mut app,
        serde_json::json!([provider("openai", "OpenAI", false, &["api_key"], None)]),
        "openai",
        None,
        String::new(),
        parse_models(&serde_json::json!([model("openai", true)])).unwrap(),
    )
    .unwrap_err();
    assert!(matches!(error, TuiError::InvalidResponse(_)));
    assert_eq!(app.models, previous_models);
}

#[test]
fn oauth_wait_operation_is_owned_by_the_client_and_can_be_cancelled_without_a_session_path() {
    let mut app = active_app();
    app.write_pending = true;
    let mut sequence = 0;
    let mut flow = None;
    let (mut pipe, path) = test_pipe_with_path();
    apply_message(
        &mut app,
        server_message(serde_json::json!({
            "type": "event",
            "event": {
                "type": "operation_updated",
                "operation": {
                    "operationId": "oauth-operation",
                    "clientInstanceId": "client",
                    "clientRequestId": "auth:oauth",
                    "sessionPath": "provider:openai",
                    "type": "login_model_provider",
                    "status": "running",
                    "acceptedAt": 1,
                    "updatedAt": 2,
                    "payloadHash": "hash"
                }
            }
        })),
        &mut pipe,
        &mut sequence,
        &mut flow,
    )
    .unwrap();
    assert_eq!(
        app.operation
            .as_ref()
            .map(|operation| operation.operation_id.as_str()),
        Some("oauth-operation")
    );
    assert!(app.is_active_operation());

    apply_message(
        &mut app,
        server_message(serde_json::json!({
            "type": "event",
            "event": {
                "type": "ui_request",
                "id": "oauth-input",
                "operationId": "oauth-operation",
                "kind": "secret",
                "title": "模型认证",
                "payload": { "message": "输入认证信息" }
            }
        })),
        &mut pipe,
        &mut sequence,
        &mut flow,
    )
    .unwrap();
    apply_message(
        &mut app,
        server_message(serde_json::json!({
            "type": "event",
            "event": {
                "type": "ui_request",
                "id": "oauth-progress",
                "operationId": "oauth-operation",
                "kind": "notify",
                "title": "模型认证",
                "payload": { "method": "auth_progress", "message": "正在等待认证" }
            }
        })),
        &mut pipe,
        &mut sequence,
        &mut flow,
    )
    .unwrap();
    assert!(matches!(app.overlay(), Some(OverlayState::TextEditor(editor)) if editor.secret));

    interrupt_active_operation(&mut app, &mut pipe, &mut sequence).unwrap();
    assert_eq!(
        app.operation
            .as_ref()
            .map(|operation| operation.status.as_str()),
        Some("aborting")
    );
    drop(pipe);
    let frames = FrameDecoder::default()
        .push(&std::fs::read(&path).unwrap())
        .unwrap();
    std::fs::remove_file(path).unwrap();
    assert_eq!(frames.len(), 1);
    let abort = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let abort = serde_json::to_value(abort.value()).unwrap();
    assert_eq!(abort["request"]["command"], "abort_operation");
    assert_eq!(abort["request"]["operationId"], "oauth-operation");

    let mut final_pipe = test_pipe();
    apply_message(
        &mut app,
        server_message(serde_json::json!({
            "type": "event",
            "event": {
                "type": "operation_updated",
                "operation": {
                    "operationId": "oauth-operation",
                    "clientInstanceId": "client",
                    "clientRequestId": "auth:oauth",
                    "sessionPath": "provider:openai",
                    "type": "login_model_provider",
                    "status": "aborted",
                    "acceptedAt": 1,
                    "updatedAt": 3,
                    "payloadHash": "hash"
                }
            }
        })),
        &mut final_pipe,
        &mut sequence,
        &mut flow,
    )
    .unwrap();
    assert!(!app.write_pending);
    assert_eq!(app.toast.as_deref(), Some("登录已取消"));
}

#[test]
fn auth_failure_invalid_verification_and_concurrent_states_preserve_previous_state_and_draft() {
    let mut app = active_app();
    app.editor.insert("保留的草稿");
    app.providers = parse_providers(&serde_json::json!([provider(
        "openai",
        "OpenAI",
        false,
        &["api_key"],
        None
    )]))
    .unwrap();
    app.open_overlay(auth_overlay(
        &app.providers,
        "login",
        None,
        "openai".to_owned(),
    ));
    let previous_models = app.models.clone();
    let mut sequence = 1;
    let mut flow = None;
    let mut pipe = test_pipe();
    handle_auth_action(
        &mut app,
        "auth-login:0:0",
        &mut pipe,
        "client",
        &mut sequence,
        &flow,
    )
    .unwrap();
    apply_message(
        &mut app,
        server_message(serde_json::json!({
            "type": "response",
            "id": "login_model_provider:2",
            "ok": false,
            "error": { "code": "auth_cancelled", "message": "认证已取消" }
        })),
        &mut pipe,
        &mut sequence,
        &mut flow,
    )
    .unwrap();
    assert!(!app.write_pending);
    assert_eq!(app.models, previous_models);
    assert_eq!(app.editor.text(), "保留的草稿");
    assert!(matches!(
        app.overlay(),
        Some(OverlayState::List(list)) if list.title == "登录" && list.filter == "openai"
    ));

    let models = parse_models(&serde_json::json!([model("openai", true)])).unwrap();
    let error = apply_auth_verify_result(
        &mut app,
        serde_json::json!([provider("openai", "OpenAI", false, &["api_key"], None)]),
        "openai",
        Some("api_key"),
        String::new(),
        models,
    )
    .unwrap_err();
    assert!(matches!(error, TuiError::InvalidResponse(_)));
    assert_eq!(app.models, previous_models);
    assert_eq!(app.editor.text(), "保留的草稿");

    let mut running = active_app();
    running.operation = Some(lystar_protocol::OperationSnapshot {
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
    assert!(submit_auth(&mut running, "/login").0.is_empty());
    assert_eq!(
        running.overlay_error.as_deref(),
        Some("当前会话正在运行，不能修改认证")
    );

    let mut blocked = active_app();
    let mut blocked_pipe = test_pipe();
    let mut blocked_sequence = 0;
    blocked.write_pending = true;
    open_auth_selector(
        &mut blocked,
        &mut blocked_pipe,
        &mut blocked_sequence,
        &None,
        "login",
        String::new(),
    )
    .unwrap();
    assert_eq!(blocked.overlay_error.as_deref(), Some("正在写入，请稍候"));
    blocked.write_pending = false;
    open_auth_selector(
        &mut blocked,
        &mut blocked_pipe,
        &mut blocked_sequence,
        &Some(SessionFlow::Reload {
            id: "reload".to_owned(),
        }),
        "login",
        String::new(),
    )
    .unwrap();
    assert_eq!(blocked.overlay_error.as_deref(), Some("会话操作正在进行"));
}

#[test]
fn command_palette_and_help_expose_login_and_logout() {
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
            if palette.items.iter().any(|item| item.action == "open:login")
                && palette.items.iter().any(|item| item.action == "open:logout")
    ));
    assert_eq!(builtin_slash_command(" /logout "), Some("logout"));

    app.close_overlay();
    open_workbench(
        &mut app,
        "help",
        &mut pipe,
        "/tmp/session.jsonl",
        "client",
        &mut sequence,
        &mut flow,
    )
    .unwrap();
    assert!(matches!(
        app.overlay(),
        Some(OverlayState::Detail(detail))
            if detail.lines.iter().any(|line| line.contains("/logout 退出登录"))
    ));
}
