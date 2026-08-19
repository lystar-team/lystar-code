use super::*;

fn active_app() -> AppState {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/session.jsonl".to_owned(), "/work/project".to_owned());
    let mut snapshot = snapshot_value("/tmp/session.jsonl");
    snapshot["cwd"] = serde_json::json!("/work/project");
    app.apply_active_lease(
        "lease".to_owned(),
        serde_json::from_value(snapshot).unwrap(),
    );
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

fn skill(enabled: bool) -> SkillDescriptor {
    SkillDescriptor {
        name: "demo".to_owned(),
        description: "demo skill".to_owned(),
        path: "/work/project/.pi/skills/demo/SKILL.md".to_owned(),
        source: "project".to_owned(),
        scope: "project".to_owned(),
        enabled,
        eligible: true,
    }
}

fn skill_value(enabled: bool) -> serde_json::Value {
    serde_json::json!({
        "name": "demo", "description": "demo skill",
        "path": "/work/project/.pi/skills/demo/SKILL.md",
        "baseDir": "/work/project/.pi/skills/demo", "source": "project",
        "scope": "project", "origin": "top-level", "enabled": enabled,
        "disableModelInvocation": false, "eligible": true
    })
}

fn apply(
    app: &mut AppState,
    message: &lystar_protocol::ServerMessage,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
    flow: &mut Option<SessionFlow>,
) -> Result<(), TuiError> {
    let mut quit = false;
    apply_server_message(
        app,
        message,
        "/tmp/session.jsonl",
        pipe,
        "client",
        sequence,
        flow,
        &mut quit,
    )
    .map(|_| ())
}

#[test]
fn resource_writes_send_the_active_session_control_contract() {
    let mut app = active_app();
    app.skills = vec![skill(false)];
    app.open_overlay(skills_overlay(&app.skills, Some("skill:0"), String::new()));
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 0;
    let mut flow = None;
    activate(
        &mut app,
        "skill-toggle:0:project",
        &mut pipe,
        &mut sequence,
        &mut flow,
    );
    drop(pipe);
    let request = written_request(&path);
    assert_eq!(request["command"], "set_skill_enabled");
    assert_eq!(request["sessionPath"], "/tmp/session.jsonl");
    assert_eq!(request["leaseId"], "lease");
    assert_eq!(request["cwd"], "/work/project");
    assert_eq!(request["path"], skill(false).path);
    assert_eq!(request["enabled"], true);
    assert!(app.write_pending);
    std::fs::remove_file(path).unwrap();

    let mut app = active_app();
    app.packages = vec![PackageDescriptor {
        source: "npm:demo".to_owned(),
        scope: "project".to_owned(),
        filtered: false,
        installed_path: None,
    }];
    app.open_overlay(packages_overlay(&app.packages, None, String::new()));
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 0;
    activate(
        &mut app,
        "package-remove:0",
        &mut pipe,
        &mut sequence,
        &mut flow,
    );
    drop(pipe);
    let request = written_request(&path);
    assert_eq!(request["command"], "remove_package");
    assert_eq!(request["sessionPath"], "/tmp/session.jsonl");
    assert_eq!(request["leaseId"], "lease");
    assert_eq!(request["source"], "npm:demo");
    std::fs::remove_file(path).unwrap();

    let mut app = active_app();
    app.project_instructions = vec![InstructionDescriptor {
        path: "/work/project/AGENTS.md".to_owned(),
        file_name: "AGENTS.md".to_owned(),
        exists: true,
        active: true,
        editable: true,
        content: Some("旧内容".to_owned()),
        content_hash: Some("hash".to_owned()),
    }];
    app.open_overlay(instructions_overlay(
        &app.project_instructions,
        "项目",
        None,
        String::new(),
    ));
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 0;
    activate(
        &mut app,
        "instruction:project:0",
        &mut pipe,
        &mut sequence,
        &mut flow,
    );
    if let Some(OverlayState::TextEditor(editor)) = app.overlay_mut() {
        editor.value = "新内容".to_owned();
        editor.cursor = editor.value.len();
    }
    activate(
        &mut app,
        "instruction-save:project:0",
        &mut pipe,
        &mut sequence,
        &mut flow,
    );
    drop(pipe);
    let request = written_request(&path);
    assert_eq!(request["command"], "save_project_instruction");
    assert_eq!(request["sessionPath"], "/tmp/session.jsonl");
    assert_eq!(request["leaseId"], "lease");
    assert_eq!(request["content"], "新内容");
    assert!(matches!(app.overlay(), Some(OverlayState::TextEditor(_))));
    std::fs::remove_file(path).unwrap();
}

#[test]
fn resource_writes_reject_busy_parallel_pending_and_unleased_sessions() {
    for case in ["active", "flow", "pending", "unleased"] {
        let mut app = active_app();
        app.skills = vec![skill(false)];
        app.open_overlay(skills_overlay(&app.skills, None, String::new()));
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
            "skill-toggle:0:project",
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
fn resource_responses_commit_only_the_requested_target_and_keep_failure_context() {
    let mut app = active_app();
    app.editor.insert("保留的输入草稿");
    app.skills = vec![skill(false)];
    app.open_overlay(skills_overlay(&app.skills, None, String::new()));
    let mut pipe = test_pipe();
    let mut sequence = 0;
    let mut flow = None;
    activate(
        &mut app,
        "skill-toggle:0:project",
        &mut pipe,
        &mut sequence,
        &mut flow,
    );
    apply(
        &mut app,
        &server_message(serde_json::json!({
            "type": "response", "id": "set_skill_enabled:1", "ok": true,
            "result": {
                "skills": [skill_value(true)], "diagnostics": {},
                "path": "/work/project/.pi/skills/demo/SKILL.md",
                "scope": "project", "enabled": true
            }
        })),
        &mut pipe,
        &mut sequence,
        &mut flow,
    )
    .unwrap();
    assert!(app.skills[0].enabled);
    assert_eq!(app.editor.text(), "保留的输入草稿");
    assert!(!app.write_pending);

    let mut app = active_app();
    app.editor.insert("失败后保留的草稿");
    app.skills = vec![skill(false)];
    app.open_overlay(skills_overlay(&app.skills, None, String::new()));
    let mut pipe = test_pipe();
    let mut sequence = 0;
    activate(
        &mut app,
        "skill-toggle:0:project",
        &mut pipe,
        &mut sequence,
        &mut flow,
    );
    let result = apply(
        &mut app,
        &server_message(serde_json::json!({
            "type": "response", "id": "set_skill_enabled:1", "ok": true,
            "result": {
                "skills": [skill_value(true)], "diagnostics": {},
                "path": "/other/skill.md", "scope": "project", "enabled": true
            }
        })),
        &mut pipe,
        &mut sequence,
        &mut flow,
    );
    assert!(result.is_err());
    assert!(!app.skills[0].enabled);
    assert_eq!(app.editor.text(), "失败后保留的草稿");
    assert!(matches!(app.overlay(), Some(OverlayState::List(_))));
    assert!(!app.write_pending);

    let mut app = active_app();
    app.packages = vec![PackageDescriptor {
        source: "npm:demo".to_owned(),
        scope: "project".to_owned(),
        filtered: false,
        installed_path: None,
    }];
    app.open_overlay(packages_overlay(&app.packages, None, String::new()));
    let mut pipe = test_pipe();
    let mut sequence = 0;
    activate(
        &mut app,
        "package-remove:0",
        &mut pipe,
        &mut sequence,
        &mut flow,
    );
    let result = apply(
        &mut app,
        &server_message(serde_json::json!({
            "type": "response", "id": "remove_package:1", "ok": true,
            "result": {
                "changed": true, "message": "ok", "source": "npm:demo", "scope": "project",
                "packages": [{ "source": "npm:demo", "scope": "project", "filtered": false }]
            }
        })),
        &mut pipe,
        &mut sequence,
        &mut flow,
    );
    assert!(result.is_err());
    assert_eq!(app.packages[0].source, "npm:demo");
    assert!(matches!(app.overlay(), Some(OverlayState::List(_))));
}
