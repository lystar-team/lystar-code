use super::*;

fn item(id: &str) -> lystar_protocol::TranscriptItem {
    lystar_protocol::TranscriptItem {
        entry_id: id.to_owned(),
        timestamp: String::new(),
        view: lystar_protocol::TranscriptViewItem::User {
            text: id.to_owned(),
            images: None,
        },
    }
}

fn page(
    items: Vec<lystar_protocol::TranscriptItem>,
    cursor: Option<&str>,
) -> lystar_protocol::TranscriptPage {
    lystar_protocol::TranscriptPage {
        items,
        previous_cursor: cursor.map(str::to_owned),
        has_more_previous: cursor.is_some(),
        transcript_generation: "g1".to_owned(),
        transcript_revision: 1,
        complete: true,
        request_context: None,
    }
}

fn snapshot_value(path: &str) -> serde_json::Value {
    serde_json::json!({
        "id": "session", "path": path, "cwd": "/tmp", "phase": "idle", "activity": "idle",
        "thinkingLevel": "off", "attached": false, "writeAccess": "owned", "revision": 1,
        "queuedSteerCount": 0, "queuedFollowUpCount": 0, "transcriptGeneration": "g1",
        "transcriptRevision": 1, "model": null
    })
}

fn test_pipe() -> ProtocolPipe {
    test_pipe_with_path().0
}

fn test_pipe_with_path() -> (ProtocolPipe, PathBuf) {
    let path = std::env::temp_dir().join(format!(
        "lystar-tui-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let output = std::fs::File::create(&path).unwrap();
    let (_sender, inbound) = mpsc::sync_channel(1);
    (ProtocolPipe { output, inbound }, path)
}

#[test]
fn app_interrupt_sends_one_abort_for_an_active_leased_operation() {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/current.jsonl".to_owned(), "/tmp".to_owned());
    app.lease_id = Some("lease".to_owned());
    app.input_focus = InputFocus::Overlay;
    app.operation = Some(lystar_protocol::OperationSnapshot {
        operation_id: "operation-1".to_owned(),
        client_instance_id: "client".to_owned(),
        client_request_id: "request".to_owned(),
        session_path: "/tmp/current.jsonl".to_owned(),
        operation_type: "prompt".to_owned(),
        status: "running".to_owned(),
        progress: None,
        error: None,
    });
    let (mut pipe, path) = test_pipe_with_path();
    let mut sequence = 0;
    let mut session_flow = None;
    let mut quit_requested = false;

    apply_extension_editor_app_action(
        &mut app,
        "app.interrupt",
        &mut pipe,
        "/tmp/current.jsonl",
        "client",
        &mut sequence,
        &mut session_flow,
        &mut quit_requested,
    )
    .unwrap();
    apply_extension_editor_app_action(
        &mut app,
        "app.interrupt",
        &mut pipe,
        "/tmp/current.jsonl",
        "client",
        &mut sequence,
        &mut session_flow,
        &mut quit_requested,
    )
    .unwrap();
    drop(pipe);

    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(
        bytes
            .windows(b"abort_operation".len())
            .filter(|window| *window == b"abort_operation")
            .count(),
        1
    );
    assert_eq!(
        app.operation
            .as_ref()
            .map(|operation| operation.status.as_str()),
        Some("aborting")
    );
    std::fs::remove_file(path).unwrap();
}

#[test]
fn app_interrupt_skips_missing_lease_and_terminal_operations() {
    for (lease_id, status) in [(None, "running"), (Some("lease".to_owned()), "aborted")] {
        let mut app = AppState::default();
        app.begin_active_session("/tmp/current.jsonl".to_owned(), "/tmp".to_owned());
        app.lease_id = lease_id;
        app.operation = Some(lystar_protocol::OperationSnapshot {
            operation_id: "operation-1".to_owned(),
            client_instance_id: "client".to_owned(),
            client_request_id: "request".to_owned(),
            session_path: "/tmp/current.jsonl".to_owned(),
            operation_type: "prompt".to_owned(),
            status: status.to_owned(),
            progress: None,
            error: None,
        });
        let (mut pipe, path) = test_pipe_with_path();
        let mut sequence = 0;
        let mut session_flow = None;
        let mut quit_requested = false;
        apply_extension_editor_app_action(
            &mut app,
            "app.interrupt",
            &mut pipe,
            "/tmp/current.jsonl",
            "client",
            &mut sequence,
            &mut session_flow,
            &mut quit_requested,
        )
        .unwrap();
        drop(pipe);
        assert!(
            !std::fs::read(&path)
                .unwrap()
                .windows(b"abort_operation".len())
                .any(|window| window == b"abort_operation")
        );
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
fn opens_recovery_menu_for_a_pending_custom_editor_draft() {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/current.jsonl".to_owned(), "/tmp".to_owned());
    app.extension_ui.revision = 1;
    app.editor.insert("new input");
    app.extension_ui.revision = 2;
    app.begin_custom_editor_submit(
        "recovery".to_owned(),
        crate::app::PendingCustomEditorSubmit {
            command: "prompt".to_owned(),
            session_path: "/tmp/current.jsonl".to_owned(),
            session_generation: app.session_generation,
            editor_component_generation: None,
            lease_id: "lease".to_owned(),
            client_instance_id: "client".to_owned(),
            client_request_id: "request".to_owned(),
            text: "old draft".to_owned(),
            submit_revision: 1,
            attachments: Vec::new(),
            started_at: Instant::now(),
            retry_count: 0,
        },
    );
    app.reject_custom_editor_submit("recovery");

    open_custom_editor_recovery(&mut app);

    let Some(OverlayState::List(menu)) = app.overlay() else {
        panic!("恢复草稿菜单没有打开");
    };
    assert_eq!(menu.title, "恢复草稿");
    assert_eq!(
        menu.items
            .iter()
            .map(|item| item.action.as_str())
            .collect::<Vec<_>>(),
        vec![
            "recovery-append",
            "recovery-replace-confirm",
            "recovery-copy",
            "recovery-discard",
        ]
    );
}

#[test]
fn preserves_custom_editor_alt_enter_and_control_sequences() {
    assert_eq!(
        raw_key(KeyCode::Enter, KeyModifiers::ALT),
        Some("\x1b\r".to_owned())
    );
    assert_eq!(
        raw_key(KeyCode::Char('d'), KeyModifiers::CONTROL),
        Some("\x04".to_owned())
    );
}

#[test]
fn resolves_auto_mode_from_environment_and_terminal_capability() {
    let regular = TerminalModeContext {
        stdout_tty: true,
        stdin_tty: true,
        term: Some("dumb".to_owned()),
        env_mode: None,
    };
    assert_eq!(
        resolve_terminal_mode(TerminalMode::Auto, regular),
        TerminalMode::Regular
    );
    let fullscreen = TerminalModeContext {
        stdout_tty: true,
        stdin_tty: true,
        term: Some("xterm-256color".to_owned()),
        env_mode: None,
    };
    assert_eq!(
        resolve_terminal_mode(TerminalMode::Auto, fullscreen),
        TerminalMode::Fullscreen
    );
    let env_regular = TerminalModeContext {
        stdout_tty: true,
        stdin_tty: true,
        term: Some("xterm-256color".to_owned()),
        env_mode: Some(TerminalMode::Regular),
    };
    assert_eq!(
        resolve_terminal_mode(TerminalMode::Auto, env_regular),
        TerminalMode::Regular
    );
    assert_eq!(inline_viewport_height(8), 8);
    assert_eq!(inline_viewport_height(60), 24);
}

#[test]
fn resume_hint_quotes_shell_paths_and_transcript_projection_keeps_metadata() {
    let mut hint = Vec::new();
    write_resume_hint(&mut hint, "/tmp/a'b.jsonl", None).unwrap();
    assert_eq!(
        String::from_utf8(hint).unwrap(),
        "会话已保存，可使用以下命令恢复：\nlc -r '/tmp/a'\"'\"'b.jsonl'\n"
    );
    let projected = transcript_plain_text(&lystar_protocol::TranscriptItem {
        entry_id: "tool-result".to_owned(),
        timestamp: "2026-08-16T00:00:00Z".to_owned(),
        view: TranscriptViewItem::ToolResult {
            call_id: "call-1".to_owned(),
            name: "apply_patch".to_owned(),
            status: "success".to_owned(),
            summary: "更新文件".to_owned(),
            detail: Some("diff --git a/a b/a".to_owned()),
            content_ref: Some("content_ref://tool/1".to_owned()),
            diff: None,
            images: Some(vec![lystar_protocol::TranscriptImage {
                content_ref: "content_ref://image/1".to_owned(),
                mime_type: "image/png".to_owned(),
                byte_length: 42,
                alt: Some("预览".to_owned()),
            }]),
        },
    });
    assert!(projected.contains("diff --git"));
    assert!(projected.contains("contentRef: content_ref://tool/1"));
    assert!(projected.contains("图片 image/png 42B contentRef:content_ref://image/1 alt:预览"));
}

#[test]
fn restores_raw_mode_when_entering_the_screen_fails() {
    let restored = Arc::new(AtomicBool::new(false));
    let restore = Arc::clone(&restored);
    let error = enter_terminal(
        || Ok(()),
        || Err(io::Error::other("screen failed")),
        || {
            restore.store(true, Ordering::Relaxed);
            Ok(())
        },
    )
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::Other);
    assert!(restored.load(Ordering::Relaxed));
}

#[test]
fn writes_osc8_at_the_rendered_label_without_changing_its_width() {
    let region = VisibleLink {
        column: 7,
        row: 3,
        label: "example.rs".to_owned(),
        href: "file:///tmp/example.rs".to_owned(),
    };
    let mut writer = Vec::new();
    write_visible_osc8_link(&mut writer, &region).unwrap();
    let output = String::from_utf8(writer).unwrap();
    assert!(output.starts_with("\x1b[4;8H"));
    assert!(output.contains("\x1b]8;;file:///tmp/example.rs\x1b\\example.rs\x1b]8;;\x1b\\"));
    assert!(!output.contains(">example.rs"));
}

#[test]
fn emits_real_osc8_only_for_linked_text() {
    let linked = osc8_link("file:///tmp/example.rs", "example.rs");
    assert!(linked.contains("\x1b]8;;file:///tmp/example.rs\x1b\\example.rs\x1b]8;;\x1b\\"));
    assert!(!"ordinary text".contains("\x1b]8;;"));
}

#[test]
fn rejects_control_injection_in_osc8_and_clears_extension_titles() {
    assert_eq!(osc8_link("https://example.test/\u{1b}]0;bad", "label"), "");
    assert_eq!(
        osc8_link("https://example.test/path", "label\u{1b}]0;bad\u{7}"),
        "\x1b]8;;https://example.test/path\x1b\\label]0;bad\x1b]8;;\x1b\\"
    );
    assert_eq!(
        extension_title_osc(Some("title\u{1b}]0;bad\u{7}")),
        "\x1b]0;title]0;bad\x07"
    );
    assert_eq!(extension_title_osc(None), "\x1b]0;\x07");
}

#[test]
fn intercepts_only_connected_slash_commands() {
    for (input, target) in [
        ("/help", "help"),
        (" /about ", "about"),
        ("/doctor", "doctor"),
        ("/new", "new"),
        ("/settings", "settings"),
        ("/model", "model"),
        ("/thinking", "thinking"),
        ("/login", "login"),
    ] {
        assert_eq!(builtin_slash_command(input), Some(target));
    }
    assert_eq!(builtin_slash_command("/about later"), None);
    assert_eq!(builtin_slash_command("/settings-now"), None);
}

#[test]
fn new_command_uses_project_cwd_and_refuses_active_operations() {
    let mut app = AppState::default();
    app.begin_active_session(
        "/tmp/sessions/current.jsonl".to_owned(),
        "/work/project".to_owned(),
    );
    app.lease_id = Some("lease".to_owned());
    app.editor.insert("/new");
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
    drop(pipe);

    let frames = FrameDecoder::default()
        .push(&std::fs::read(&path).unwrap())
        .unwrap();
    let message = lystar_protocol::decode_client_message(&frames[0]).unwrap();
    let request = serde_json::to_value(message.value()).unwrap();
    assert_eq!(request["request"]["command"], "create_session");
    assert_eq!(request["request"]["cwd"], "/work/project");
    assert!(matches!(
        session_flow,
        Some(SessionFlow::CreateStarting { .. })
    ));
    std::fs::remove_file(path).unwrap();

    app.operation = Some(lystar_protocol::OperationSnapshot {
        operation_id: "operation".to_owned(),
        client_instance_id: "client".to_owned(),
        client_request_id: "request".to_owned(),
        session_path: "/tmp/sessions/current.jsonl".to_owned(),
        operation_type: "prompt".to_owned(),
        status: "running".to_owned(),
        progress: None,
        error: None,
    });
    app.editor.insert("/new");
    let (mut pipe, path) = test_pipe_with_path();
    session_flow = None;
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
    drop(pipe);
    assert!(std::fs::read(&path).unwrap().is_empty());
    assert!(session_flow.is_none());
    assert_eq!(
        app.overlay_error.as_deref(),
        Some("当前会话正在运行，不能新建")
    );
    std::fs::remove_file(path).unwrap();
}

#[test]
fn builds_select_items_from_host_payload() {
    let items = ui_select_items(&serde_json::json!({
        "options": [
            {"id":"region-cn", "label":"中国", "description":"中国大陆节点"},
            {"label":"Beta", "value":"beta"},
            "alpha"
        ]
    }));
    assert_eq!(items[0].label, "中国");
    assert_eq!(items[0].detail, "中国大陆节点");
    assert_eq!(items[0].action, "ui:select:region-cn");
    assert_eq!(items[1].action, "ui:select:beta");
    assert_eq!(items[2].action, "ui:select:alpha");
}

#[test]
fn applies_readonly_pages_search_and_rejects_stale_responses() {
    let mut app = AppState::default();
    app.readonly_view = Some(ReadonlySessionView {
        path: "/tmp/readonly.jsonl".to_owned(),
        generation: 7,
        ..ReadonlySessionView::default()
    });
    app.open_overlay(readonly_overlay(app.readonly_view.as_ref().unwrap()));
    app.begin_transcript_request(
        "readonly-initial".to_owned(),
        TranscriptViewKind::Readonly,
        TranscriptRequestKind::Initial,
        "/tmp/readonly.jsonl".to_owned(),
        7,
        None,
    );
    apply_response(
        &mut app,
        &ReadOnlyResponse::TranscriptPage {
            id: "readonly-initial".to_owned(),
            page: page(vec![item("tail")], Some("older")),
        },
    )
    .unwrap();
    assert_eq!(
        app.readonly_view
            .as_ref()
            .unwrap()
            .transcript
            .cached_rounds(),
        1
    );

    let context = TranscriptRequestContext {
        generation: Some("g1".to_owned()),
        revision: Some(1),
        cursor: Some("older".to_owned()),
    };
    app.begin_transcript_request(
        "readonly-older".to_owned(),
        TranscriptViewKind::Readonly,
        TranscriptRequestKind::Older,
        "/tmp/readonly.jsonl".to_owned(),
        7,
        Some(context),
    );
    apply_response(
        &mut app,
        &ReadOnlyResponse::TranscriptPage {
            id: "readonly-older".to_owned(),
            page: page(vec![item("older")], None),
        },
    )
    .unwrap();
    assert_eq!(
        app.readonly_view
            .as_ref()
            .unwrap()
            .transcript
            .cached_rounds(),
        2
    );

    app.begin_transcript_request(
        "readonly-search".to_owned(),
        TranscriptViewKind::Readonly,
        TranscriptRequestKind::Search,
        "/tmp/readonly.jsonl".to_owned(),
        7,
        None,
    );
    apply_response(
        &mut app,
        &ReadOnlyResponse::SearchResult {
            id: "readonly-search".to_owned(),
            result: lystar_protocol::TranscriptSearchResult {
                generation: "g1".to_owned(),
                transcript_revision: 1,
                complete: true,
                hits: vec![lystar_protocol::TranscriptSearchHit {
                    entry_id: "tail".to_owned(),
                    kind: "user".to_owned(),
                    timestamp: String::new(),
                    snippet: "tail".to_owned(),
                }],
                next_cursor: None,
            },
        },
    )
    .unwrap();
    assert_eq!(app.readonly_view.as_ref().unwrap().search.hits.len(), 1);

    app.begin_transcript_request(
        "readonly-stale".to_owned(),
        TranscriptViewKind::Readonly,
        TranscriptRequestKind::Initial,
        "/tmp/readonly.jsonl".to_owned(),
        6,
        None,
    );
    apply_response(
        &mut app,
        &ReadOnlyResponse::TranscriptPage {
            id: "readonly-stale".to_owned(),
            page: page(vec![item("stale")], None),
        },
    )
    .unwrap();
    assert_eq!(
        app.readonly_view
            .as_ref()
            .unwrap()
            .transcript
            .cached_rounds(),
        2
    );
}

#[test]
fn keeps_active_events_running_behind_readonly_view() {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/active.jsonl".to_owned(), "/tmp".to_owned());
    app.transcript
        .replace_page(vec![item("before")], "g1".to_owned(), 1, None);
    app.readonly_view = Some(ReadonlySessionView {
        path: "/tmp/readonly.jsonl".to_owned(),
        generation: 1,
        ..ReadonlySessionView::default()
    });
    apply_event(
        &mut app,
        &ReadOnlyEvent::SessionProgress {
            session_path: "/tmp/active.jsonl".to_owned(),
            progress: lystar_protocol::SessionProgress::AssistantDelta {
                text: "running".to_owned(),
            },
        },
        "/tmp/active.jsonl",
    )
    .unwrap();
    assert_eq!(app.assistant_stream, "running");
    apply_event(
        &mut app,
        &ReadOnlyEvent::TranscriptCommitted {
            session_path: "/tmp/active.jsonl".to_owned(),
            transcript_generation: "g1".to_owned(),
            from_revision: 1,
            to_revision: 2,
            items: vec![lystar_protocol::TranscriptItem {
                entry_id: "after".to_owned(),
                timestamp: String::new(),
                view: TranscriptViewItem::Assistant {
                    text: "after".to_owned(),
                    images: None,
                },
            }],
        },
        "/tmp/active.jsonl",
    )
    .unwrap();
    assert_eq!(app.assistant_stream, "");
    assert_eq!(app.transcript.cached_rounds(), 2);
    assert_eq!(
        app.readonly_view
            .as_ref()
            .unwrap()
            .transcript
            .cached_rounds(),
        0
    );
}

#[test]
fn session_transitions_clear_released_leases_and_reject_stale_acquires() {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/old.jsonl".to_owned(), "/tmp".to_owned());
    let old_snapshot = serde_json::from_value(snapshot_value("/tmp/old.jsonl")).unwrap();
    app.apply_active_lease("old-lease".to_owned(), old_snapshot);
    let restore = app.restore_point();
    let target = SessionSummary {
        path: "/tmp/new.jsonl".to_owned(),
        id: "new".to_owned(),
        cwd: "/tmp".to_owned(),
        name: None,
        updated_at: 1,
        first_message: "new".to_owned(),
        activity: "idle".to_owned(),
    };
    let mut pipe = test_pipe();
    let mut sequence = 10;
    let mut quit = false;
    let mut flow = Some(SessionFlow::SwitchReleasing {
        id: "release".to_owned(),
        target: target.clone(),
        restore: restore.clone(),
    });
    apply_session_flow(
        &mut app,
        &serde_json::json!({"id":"release","ok":true,"result":{}}),
        &mut pipe,
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap();
    assert!(app.lease_id.is_none());
    assert!(app.active_session.as_ref().unwrap().lease_id.is_none());

    let mut flow = Some(SessionFlow::SwitchAcquiring {
        id: "acquire".to_owned(),
        target: target.clone(),
        restore: restore.clone(),
    });
    apply_session_flow(&mut app, &serde_json::json!({"id":"acquire","ok":true,"result":{"lease":{"leaseId":"new-lease"},"snapshot":snapshot_value("/tmp/new.jsonl")}}), &mut pipe, "client", &mut sequence, &mut flow, &mut quit).unwrap();
    assert_eq!(app.active_session_path(), Some("/tmp/new.jsonl"));
    assert_eq!(app.lease_id.as_deref(), Some("new-lease"));

    let mut flow = Some(SessionFlow::SwitchRollback {
        id: "rollback".to_owned(),
        restore: restore.clone(),
        reason: "target failed".to_owned(),
    });
    apply_session_flow(
        &mut app,
        &serde_json::json!({"id":"rollback","ok":false,"error":{"message":"old failed"}}),
        &mut pipe,
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap();
    assert!(app.active_session.is_none());
    assert!(app.lease_id.is_none());

    app.begin_active_session("/tmp/delete.jsonl".to_owned(), "/tmp".to_owned());
    let mut flow = Some(SessionFlow::DeleteRemoving {
        id: "delete".to_owned(),
        restore,
        target: None,
    });
    apply_session_flow(
        &mut app,
        &serde_json::json!({"id":"delete","ok":true,"result":{}}),
        &mut pipe,
        "client",
        &mut sequence,
        &mut flow,
        &mut quit,
    )
    .unwrap();
    assert!(app.active_session.is_none());

    app.begin_active_session("/tmp/initial.jsonl".to_owned(), "/tmp".to_owned());
    let generation = app.session_generation;
    let mut flow = Some(SessionFlow::InitialAcquiring {
        id: "expected".to_owned(),
        path: "/tmp/initial.jsonl".to_owned(),
        generation,
    });
    let outcome = apply_session_flow(&mut app, &serde_json::json!({"id":"stale","ok":true,"result":{"lease":{"leaseId":"stale"},"snapshot":snapshot_value("/tmp/initial.jsonl")}}), &mut pipe, "client", &mut sequence, &mut flow, &mut quit).unwrap();
    assert!(outcome.is_none());
    assert!(app.lease_id.is_none());

    quit = true;
    let mut flow = Some(SessionFlow::SwitchAcquiring {
        id: "quit-acquire".to_owned(),
        target,
        restore: app.restore_point(),
    });
    apply_session_flow(&mut app, &serde_json::json!({"id":"quit-acquire","ok":true,"result":{"lease":{"leaseId":"quit-lease"},"snapshot":snapshot_value("/tmp/new.jsonl")}}), &mut pipe, "client", &mut sequence, &mut flow, &mut quit).unwrap();
    assert!(matches!(flow, Some(SessionFlow::QuitReleasing { .. })));
    assert!(app.lease_id.is_none());
}

#[test]
fn reads_accepted_queue_operation_id_from_host_response() {
    assert_eq!(
        queue_operation_id(&serde_json::json!({"result":{"operationId":"operation-1"}})),
        Some("operation-1")
    );
    assert_eq!(
        queue_operation_id(
            &serde_json::json!({"result":{"operation":{"operationId":"operation-2"}}})
        ),
        Some("operation-2")
    );
    assert_eq!(queue_operation_id(&serde_json::json!({"result":{}})), None);
}

#[test]
fn renders_bounded_auth_notifications_with_copy_and_osc8_link() {
    let detail = ui_notify_detail(
        "模型认证",
        &serde_json::json!({
            "method":"auth_device_code",
            "userCode":"ABCD-EFGH",
            "verificationUri":"https://example.test/device",
            "intervalSeconds":5,
            "expiresInSeconds":600
        }),
    );
    assert_eq!(detail.copy_text.as_deref(), Some("ABCD-EFGH"));
    assert_eq!(
        detail.link.as_ref().map(|link| link.href.as_str()),
        Some("https://example.test/device")
    );
    assert!(detail.status.contains('c'));
}
