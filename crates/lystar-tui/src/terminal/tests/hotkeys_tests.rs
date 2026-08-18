use super::*;

#[test]
fn hotkeys_command_displays_the_active_rust_shortcuts() {
    let mut app = AppState::default();
    app.begin_active_session(
        "/tmp/sessions/current.jsonl".to_owned(),
        "/work/project".to_owned(),
    );
    app.lease_id = Some("lease".to_owned());
    app.editor.insert("/hotkeys");
    let mut pipe = test_pipe();
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

    let Some(OverlayState::Detail(detail)) = app.overlay() else {
        panic!("快捷键覆盖层没有打开");
    };
    assert_eq!(detail.title, "快捷键");
    assert_eq!(detail.status, "Esc 返回");
    assert!(detail.lines.iter().any(|line| line.contains("Ctrl+P")));
    assert!(detail.lines.iter().any(|line| line.contains("Alt+Enter")));
    assert!(
        detail
            .lines
            .iter()
            .any(|line| line.contains("Ctrl+Shift+V"))
    );
    assert!(detail.lines.iter().any(|line| line.contains("斜杠命令")));
}

#[test]
fn command_palette_exposes_hotkeys() {
    let mut app = AppState::default();
    let mut pipe = test_pipe();
    let mut sequence = 0;
    let mut session_flow = None;
    let mut quit_requested = false;

    handle_key(
        &mut app,
        KeyCode::Char('p'),
        KeyModifiers::CONTROL,
        &mut pipe,
        "/tmp/sessions/current.jsonl",
        "client",
        &mut sequence,
        &mut session_flow,
        &mut quit_requested,
    )
    .unwrap();

    let Some(OverlayState::List(palette)) = app.overlay() else {
        panic!("命令面板没有打开");
    };
    assert!(
        palette
            .items
            .iter()
            .any(|item| item.label == "/hotkeys" && item.action == "open:hotkeys")
    );
}
