use super::*;

fn active_app(theme: &str) -> AppState {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/session.jsonl".to_owned(), "/work/project".to_owned());
    app.apply_active_lease(
        "lease".to_owned(),
        serde_json::from_value(snapshot_value("/tmp/session.jsonl")).unwrap(),
    );
    app.settings = parse_settings(&serde_json::json!([
        {
            "id": "theme",
            "label": "主题",
            "description": "选择界面主题",
            "kind": "string",
            "value": theme,
            "displayValue": theme,
            "options": ["dark", "light", "paper"],
            "optionLabels": ["dark", "light", "paper"],
            "scope": "global",
            "readOnly": false,
            "restartRequired": false
        },
        {
            "id": "steering-mode",
            "label": "引导消息处理",
            "kind": "enum",
            "value": "one-at-a-time",
            "displayValue": "逐条处理",
            "options": ["one-at-a-time", "all"],
            "optionLabels": ["逐条处理", "全部处理"],
            "scope": "global",
            "readOnly": false,
            "restartRequired": false
        }
    ]))
    .unwrap();
    app.open_overlay(settings_overlay(&app.settings, None, String::new()));
    app
}

fn activate(app: &mut AppState, action: &str, pipe: &mut ProtocolPipe, sequence: &mut u64) {
    let mut flow = None;
    activate_workbench_action(
        app,
        action,
        pipe,
        "/tmp/session.jsonl",
        "client",
        sequence,
        &mut flow,
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

#[test]
fn settings_show_host_labels_and_write_fixed_or_automatic_themes() {
    let mut app = active_app("dark");
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 0;

    activate(
        &mut app,
        "setting-enum:steering-mode",
        &mut pipe,
        &mut sequence,
    );
    let Some(OverlayState::List(list)) = app.overlay() else {
        panic!("枚举选项没有打开");
    };
    assert_eq!(
        list.items
            .iter()
            .map(|item| item.label.as_str())
            .collect::<Vec<_>>(),
        ["逐条处理", "全部处理"]
    );
    app.close_overlay();

    activate(&mut app, "setting-theme", &mut pipe, &mut sequence);
    activate(&mut app, "setting-theme-fixed", &mut pipe, &mut sequence);
    activate(&mut app, "setting-theme-save:2", &mut pipe, &mut sequence);
    drop(pipe);
    let request = written_request(&path);
    assert_eq!(request["command"], "set_setting");
    assert_eq!(request["id"], "theme");
    assert_eq!(request["value"], "paper");
    assert_eq!(app.overlay().map(OverlayState::title), Some("设置"));
    std::fs::remove_file(&path).unwrap();

    let mut app = active_app("light/dark");
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 0;
    activate(&mut app, "setting-theme", &mut pipe, &mut sequence);
    activate(&mut app, "setting-theme-auto", &mut pipe, &mut sequence);
    activate(&mut app, "setting-theme-light:2", &mut pipe, &mut sequence);
    activate(
        &mut app,
        "setting-theme-pair:paper:0",
        &mut pipe,
        &mut sequence,
    );
    drop(pipe);
    let request = written_request(&path);
    assert_eq!(request["value"], "paper/dark");
    assert_eq!(app.overlay().map(OverlayState::title), Some("设置"));
    std::fs::remove_file(path).unwrap();
}
