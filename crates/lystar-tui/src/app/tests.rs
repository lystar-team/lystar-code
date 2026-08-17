use std::time::Instant;

use lystar_protocol::{
    OperationSnapshot, SessionProgress, SessionSnapshot, ToolCall, TranscriptItem,
    TranscriptViewItem,
};
use ratatui::{buffer::Buffer, layout::Rect, widgets::Widget};

use super::*;
fn user(id: &str, text: &str) -> TranscriptItem {
    TranscriptItem {
        entry_id: id.to_owned(),
        timestamp: String::new(),
        view: TranscriptViewItem::User {
            text: text.to_owned(),
            images: None,
        },
    }
}

fn assistant(id: &str, text: &str) -> TranscriptItem {
    TranscriptItem {
        entry_id: id.to_owned(),
        timestamp: String::new(),
        view: TranscriptViewItem::Assistant {
            text: text.to_owned(),
            images: None,
        },
    }
}

fn operation(status: &str) -> OperationSnapshot {
    OperationSnapshot {
        operation_id: "operation-1".to_owned(),
        client_instance_id: "client".to_owned(),
        client_request_id: "request".to_owned(),
        session_path: "/tmp/session.jsonl".to_owned(),
        operation_type: "prompt".to_owned(),
        status: status.to_owned(),
        progress: None,
        error: None,
    }
}

#[test]
fn keeps_live_tools_in_start_order_through_updates_and_end() {
    let mut app = AppState::default();
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "z-first".to_owned(),
        name: "read".to_owned(),
        summary: Some("初始摘要".to_owned()),
        diff: None,
    });
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "a-second".to_owned(),
        name: "grep".to_owned(),
        summary: Some("搜索中".to_owned()),
        diff: None,
    });
    app.apply_progress(SessionProgress::ToolUpdate {
        tool_call_id: "z-first".to_owned(),
        name: "read".to_owned(),
        summary: "部分结果".to_owned(),
        diff: None,
    });
    app.apply_progress(SessionProgress::ToolEnd {
        tool_call_id: "z-first".to_owned(),
        name: "read".to_owned(),
        status: "error".to_owned(),
        summary: "读取失败".to_owned(),
        diff: None,
    });
    app.apply_progress(SessionProgress::ToolUpdate {
        tool_call_id: "z-first".to_owned(),
        name: "read".to_owned(),
        summary: "最终错误摘要".to_owned(),
        diff: None,
    });
    app.apply_progress(SessionProgress::ToolEnd {
        tool_call_id: "a-second".to_owned(),
        name: "grep".to_owned(),
        status: "success".to_owned(),
        summary: "找到 2 处".to_owned(),
        diff: None,
    });

    let ids = app.live_tools.iter().map(|(id, _)| id).collect::<Vec<_>>();
    assert_eq!(ids, vec!["z-first", "a-second"]);
    assert_eq!(
        app.live_tools.get("z-first").map(|tool| tool.status),
        Some(LiveToolStatus::Error)
    );
    assert_eq!(
        app.live_tools
            .get("z-first")
            .map(|tool| tool.summary.as_str()),
        Some("最终错误摘要")
    );
    assert_eq!(
        app.live_tools.get("a-second").map(|tool| tool.status),
        Some(LiveToolStatus::Success)
    );

    let rendered = rendered_transcript(&app);
    assert!(
        rendered.contains("工具read错误最终错误摘要"),
        "{rendered:?}"
    );
    assert!(rendered.contains("工具grep已完成找到2处"), "{rendered:?}");
}

#[test]
fn terminal_operations_settle_live_tools_without_clearing_the_tail() {
    for (operation_status, expected_status) in [
        ("aborted", LiveToolStatus::Cancelled),
        ("interrupted", LiveToolStatus::Cancelled),
        ("failed", LiveToolStatus::Error),
    ] {
        let mut app = AppState::default();
        app.apply_progress(SessionProgress::AssistantDelta {
            text: "仍在等待持久记录".to_owned(),
        });
        app.apply_progress(SessionProgress::ToolStart {
            tool_call_id: "call".to_owned(),
            name: "write".to_owned(),
            summary: Some("写入中".to_owned()),
            diff: None,
        });

        app.apply_operation(operation(operation_status));

        assert_eq!(
            app.live_tools.get("call").map(|tool| tool.status),
            Some(expected_status)
        );
        assert_eq!(app.assistant_stream, "仍在等待持久记录");

        let mut next_operation = operation("accepted");
        next_operation.operation_id = "operation-2".to_owned();
        app.apply_operation(next_operation);
        assert!(app.live_tools.is_empty());
        assert!(app.assistant_stream.is_empty());
    }
}

#[test]
fn committed_tool_result_replaces_only_the_matching_live_tool() {
    let mut app = AppState::default();
    app.transcript.replace_page(
        vec![TranscriptItem {
            entry_id: "call".to_owned(),
            timestamp: String::new(),
            view: TranscriptViewItem::ToolCall {
                calls: vec![ToolCall {
                    id: "matched".to_owned(),
                    name: "read".to_owned(),
                    summary: "文件".to_owned(),
                    href: None,
                }],
            },
        }],
        "g".to_owned(),
        1,
        None,
    );
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "matched".to_owned(),
        name: "read".to_owned(),
        summary: Some("文件".to_owned()),
        diff: None,
    });
    app.apply_progress(SessionProgress::ToolEnd {
        tool_call_id: "matched".to_owned(),
        name: "read".to_owned(),
        status: "success".to_owned(),
        summary: "done".to_owned(),
        diff: None,
    });
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "other".to_owned(),
        name: "grep".to_owned(),
        summary: Some("仍在运行".to_owned()),
        diff: None,
    });

    let committed = vec![TranscriptItem {
        entry_id: "result".to_owned(),
        timestamp: String::new(),
        view: TranscriptViewItem::ToolResult {
            call_id: "matched".to_owned(),
            name: "read".to_owned(),
            status: "success".to_owned(),
            summary: "done".to_owned(),
            detail: None,
            content_ref: None,
            diff: None,
            images: None,
        },
    }];
    assert!(
        app.transcript
            .append_committed("g", 1, 2, committed.clone())
    );
    app.clear_live_after_commit(&committed);

    assert!(app.live_tools.get("matched").is_none());
    assert_eq!(
        app.live_tools.get("other").map(|tool| tool.status),
        Some(LiveToolStatus::Running)
    );
    let rendered = rendered_transcript(&app);
    assert_eq!(rendered.matches("done").count(), 1, "{rendered:?}");
}

fn rendered_transcript(app: &AppState) -> String {
    let area = Rect::new(0, 0, 40, 8);
    let mut buffer = Buffer::empty(area);
    TranscriptView::new(app).render(area, &mut buffer);
    buffer
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>()
        .replace(' ', "")
}
#[test]
fn renders_live_thinking_before_assistant_without_protocol_labels() {
    let mut app = AppState::default();
    app.apply_progress(SessionProgress::AssistantDelta {
        text: "实时回答".to_owned(),
    });
    app.apply_progress(SessionProgress::ThinkingDelta {
        text: "正在思考\n下一步".to_owned(),
    });

    let rendered = rendered_transcript(&app);
    assert!(rendered.contains("正在思考"), "{rendered:?}");
    assert!(rendered.contains("下一步"));
    assert!(rendered.contains("实时回答"));
    assert!(rendered.find("正在思考") < rendered.find("实时回答"));
    assert!(!rendered.contains("thinking_delta"));
    assert!(!rendered.contains("assistant_delta"));
}

#[test]
fn committed_assistant_replaces_the_live_tail_without_duplication() {
    let mut app = AppState::default();
    app.transcript
        .replace_page(vec![user("user", "问题")], "g".to_owned(), 1, None);
    app.apply_progress(SessionProgress::ThinkingDelta {
        text: "临时思考".to_owned(),
    });
    app.apply_progress(SessionProgress::AssistantDelta {
        text: "已提交正文".to_owned(),
    });
    let committed = vec![assistant("assistant", "已提交正文")];
    assert!(
        app.transcript
            .append_committed("g", 1, 2, committed.clone())
    );
    app.clear_live_after_commit(&committed);

    assert!(app.thinking_stream.is_empty());
    assert!(app.assistant_stream.is_empty());
    let rendered = rendered_transcript(&app);
    assert_eq!(rendered.matches("已提交正文").count(), 1, "{rendered:?}");
    assert!(!rendered.contains("临时思考"));
}

#[test]
fn clears_live_streams_when_switching_or_disconnecting() {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/old.jsonl".to_owned(), "/tmp".to_owned());
    app.apply_progress(SessionProgress::ThinkingDelta {
        text: "旧思考".to_owned(),
    });
    app.apply_progress(SessionProgress::AssistantDelta {
        text: "旧回答".to_owned(),
    });
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "old-tool".to_owned(),
        name: "read".to_owned(),
        summary: Some("旧会话工具".to_owned()),
        diff: None,
    });
    app.commit_session_switch(
        "/tmp/new.jsonl".to_owned(),
        "new-lease".to_owned(),
        SessionSnapshot {
            id: "new".to_owned(),
            path: "/tmp/new.jsonl".to_owned(),
            cwd: "/tmp".to_owned(),
            phase: "idle".to_owned(),
            activity: "idle".to_owned(),
            thinking_level: "off".to_owned(),
            attached: true,
            write_access: "owned".to_owned(),
            revision: 1,
            queued_steer_count: 0,
            queued_follow_up_count: 0,
            transcript_generation: "g".to_owned(),
            transcript_revision: 1,
            model: None,
        },
    );
    assert!(app.thinking_stream.is_empty());
    assert!(app.assistant_stream.is_empty());
    assert!(app.live_tools.is_empty());

    app.apply_progress(SessionProgress::AssistantDelta {
        text: "断开前回答".to_owned(),
    });
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "disconnect-tool".to_owned(),
        name: "grep".to_owned(),
        summary: Some("断开前工具".to_owned()),
        diff: None,
    });
    app.clear_connection_state("断开");
    assert!(app.assistant_stream.is_empty());
    assert!(app.live_tools.is_empty());
}

#[test]
fn extension_widget_budget_is_computed_once_and_preserves_line_order() {
    let mut app = AppState::default();
    app.extension_ui.widgets = vec![
        ExtensionWidget {
            key: "above".to_owned(),
            placement: "above".to_owned(),
            lines: vec!["a1".to_owned(), "a2".to_owned(), "a3".to_owned()],
        },
        ExtensionWidget {
            key: "below".to_owned(),
            placement: "below".to_owned(),
            lines: vec![
                "b1".to_owned(),
                "b2".to_owned(),
                "workspace".to_owned(),
                "b4".to_owned(),
            ],
        },
    ];

    assert_eq!(app.extension_widget_budget(8), 0);
    assert_eq!(app.composer_height(8), 4);
    assert_eq!(
        app.extension_widget_lines(0),
        (Vec::<&str>::new(), Vec::<&str>::new(), 7)
    );

    let (above, below, hidden) = app.extension_widget_lines(4);
    assert_eq!(above, vec!["a1", "a2", "a3"]);
    assert!(below.is_empty());
    assert_eq!(hidden, 4);
}

#[test]
fn state_merge_dedupes_sorts_and_keeps_live_snapshot() {
    let committed = SubagentDescriptor {
        parent_session_path: "/tmp/main.jsonl".to_owned(),
        run_id: "run-b".to_owned(),
        agent_id: "agent-b".to_owned(),
        name: "committed".to_owned(),
        source: "builtin".to_owned(),
        task: "task".to_owned(),
        state: "succeeded".to_owned(),
        current_action: None,
        started_at: 1,
        updated_at: 2,
        elapsed_ms: 1,
        controllable: false,
        session_file: None,
        session_cwd: None,
    };
    let mut live = committed.clone();
    live.name = "live".to_owned();
    live.state = "running".to_owned();
    live.updated_at = 4;
    let mut second = committed.clone();
    second.run_id = "run-a".to_owned();
    second.agent_id = "agent-a".to_owned();
    second.updated_at = 3;
    let snapshots = merge_subagents([committed, second], [live]);
    assert_eq!(snapshots.len(), 2);
    assert_eq!(snapshots[0].name, "live");
    assert_eq!(snapshots[0].state, "running");
    assert_eq!(snapshots[1].run_id, "run-a");
}

#[test]
fn context_copy_prefers_readonly_selection_then_active_view() {
    let mut app = AppState::default();
    app.transcript
        .replace_page(vec![user("active", "active text")], "g".to_owned(), 1, None);
    assert_eq!(
        app.context_copy_text().as_deref(),
        Some("用户  active text")
    );
    let mut readonly = ReadonlySessionView::default();
    readonly.transcript.replace_page(
        vec![user("readonly", "readonly text")],
        "g".to_owned(),
        1,
        None,
    );
    app.readonly_view = Some(readonly);
    assert_eq!(
        app.context_copy_text().as_deref(),
        Some("用户  readonly text")
    );
}

#[test]
fn pairs_every_tool_call_on_page_boundaries() {
    let call = TranscriptItem {
        entry_id: "call".to_owned(),
        timestamp: String::new(),
        view: TranscriptViewItem::ToolCall {
            calls: vec![
                ToolCall {
                    id: "one".to_owned(),
                    name: "read".to_owned(),
                    summary: "a".to_owned(),
                    href: None,
                },
                ToolCall {
                    id: "two".to_owned(),
                    name: "grep".to_owned(),
                    summary: "b".to_owned(),
                    href: None,
                },
            ],
        },
    };
    let result = |id: &str, call_id: &str| TranscriptItem {
        entry_id: id.to_owned(),
        timestamp: String::new(),
        view: TranscriptViewItem::ToolResult {
            call_id: call_id.to_owned(),
            name: "Tool".to_owned(),
            status: "success".to_owned(),
            summary: "done".to_owned(),
            detail: None,
            content_ref: None,
            diff: None,
            images: None,
        },
    };
    let mut window = TranscriptWindow::default();
    window.replace_page(vec![call], "g".to_owned(), 1, None);
    assert!(window.append_committed("g", 1, 2, vec![result("r1", "one"), result("r2", "two")]));
    assert_eq!(window.rounds()[0].items.len(), 3);
}
#[test]
fn clears_stream_and_search_on_reload() {
    let mut app = AppState::default();
    app.transcript.streaming_preview = Some("partial".to_owned());
    app.search.pending_jump = Some("old".to_owned());
    app.search.selected = 2;
    app.apply_progress(SessionProgress::ToolStart {
        tool_call_id: "reload-tool".to_owned(),
        name: "read".to_owned(),
        summary: Some("重载前工具".to_owned()),
        diff: None,
    });
    app.clear_for_reload("rewrite");
    assert!(app.transcript.streaming_preview.is_none());
    assert!(app.search.pending_jump.is_none());
    assert!(app.live_tools.is_empty());
    assert_eq!(app.search.selected, 0);
}
#[test]
fn bounds_rounds_items_and_bytes() {
    let mut window = TranscriptWindow::default();
    window.replace_page(
        (0..10_000)
            .map(|index| user(&format!("{index}"), &"x".repeat(1024)))
            .collect(),
        "g".to_owned(),
        1,
        Some("older".to_owned()),
    );
    let diagnostics = window.diagnostics();
    assert!(diagnostics.cached_rounds <= ROUND_CACHE_LIMIT);
    assert!(diagnostics.cached_items <= ITEM_CACHE_LIMIT);
    assert!(diagnostics.cached_utf8_bytes <= UTF8_CACHE_LIMIT);
}
#[test]
fn preserves_the_visible_anchor_when_prepending() {
    let mut window = TranscriptWindow::default();
    window.replace_page(
        vec![user("tail-1", "tail-1"), user("tail-2", "tail-2")],
        "g".to_owned(),
        1,
        Some("older".to_owned()),
    );
    window.current = 0;
    window.scroll = 0;
    window.prepend_page(vec![user("old-1", "old-1"), user("old-2", "old-2")], None);
    assert!(window.rounds()[window.current].contains("tail-1"));
    assert!(window.rounds()[window.scroll].contains("tail-1"));
}

#[test]
fn rejects_stale_previous_page_context() {
    let mut window = TranscriptWindow::default();
    window.replace_page(
        vec![user("tail", "tail")],
        "g".to_owned(),
        2,
        Some("older".to_owned()),
    );
    assert!(!window.accepts_previous_page("g", 1, Some("g"), Some(2)));
    assert!(!window.accepts_previous_page("g", 3, Some("g"), Some(2)));
    assert!(window.accepts_previous_page("g", 2, Some("g"), Some(2)));
}

#[test]
fn restores_composer_focus_after_nested_overlays() {
    let mut app = AppState::default();
    app.open_overlay(OverlayState::Detail(DetailOverlay {
        title: "一层".to_owned(),
        lines: vec![],
        scroll: 0,
        status: String::new(),
        link: None,
        copy_text: None,
    }));
    app.open_overlay(OverlayState::Detail(DetailOverlay {
        title: "二层".to_owned(),
        lines: vec![],
        scroll: 0,
        status: String::new(),
        link: None,
        copy_text: None,
    }));
    assert_eq!(app.input_focus, InputFocus::Overlay);
    app.close_overlay();
    assert_eq!(app.input_focus, InputFocus::Overlay);
    app.close_overlay();
    assert_eq!(app.input_focus, InputFocus::Composer);
}

#[test]
fn rejects_stale_responses_per_workspace_overlay_generation() {
    let detail = |title: &str| {
        OverlayState::Detail(DetailOverlay {
            title: title.to_owned(),
            lines: vec![],
            scroll: 0,
            status: String::new(),
            link: None,
            copy_text: None,
        })
    };
    let request = |command| WorkspaceRequest {
        command,
        payload: serde_json::Map::new(),
    };
    let mut app = AppState::default();

    app.open_workspace_overlay("changes", detail("变更"));
    app.begin_request(
        "changes-old".to_owned(),
        request(lystar_protocol::WorkspaceCommand::GetGitStatus),
        PendingIntent::WorkbenchLoad {
            target: WorkbenchTarget::Changes,
            selected_key: None,
            filter: String::new(),
        },
    );
    let changes_old = app.pending_requests.get("changes-old").unwrap().clone();
    app.replace_workspace_overlay("changes", detail("变更"));
    assert!(!app.pending_workspace_is_current(&changes_old));

    app.open_workspace_overlay("skills", detail("技能"));
    app.begin_request(
        "skills-old".to_owned(),
        request(lystar_protocol::WorkspaceCommand::ListSkills),
        PendingIntent::WorkbenchLoad {
            target: WorkbenchTarget::Skills,
            selected_key: None,
            filter: String::new(),
        },
    );
    let skills_old = app.pending_requests.get("skills-old").unwrap().clone();
    app.replace_workspace_overlay("skills", detail("技能"));
    assert!(!app.pending_workspace_is_current(&skills_old));
}

#[test]
fn filters_lists_and_edits_text_without_fake_actions() {
    let mut app = AppState::default();
    app.open_overlay(OverlayState::List(ListOverlay {
        title: "命令面板".to_owned(),
        origin: OverlayOrigin::User,
        items: vec![
            OverlayItem {
                label: "/help".to_owned(),
                detail: "帮助".to_owned(),
                action: "open:help".to_owned(),
            },
            OverlayItem {
                label: "/doctor".to_owned(),
                detail: "诊断".to_owned(),
                action: "open:doctor".to_owned(),
            },
        ],
        selected: 0,
        filter: String::new(),
        status: String::new(),
    }));
    app.overlay_insert("诊");
    assert_eq!(app.current_overlay_action().as_deref(), Some("open:doctor"));
    app.close_overlay();
    app.open_overlay(OverlayState::TextEditor(TextEditorOverlay {
        title: "输入".to_owned(),
        value: "a".to_owned(),
        cursor: 1,
        save_action: "ui:input".to_owned(),
        status: String::new(),
        secret: false,
    }));
    app.overlay_insert("中");
    app.overlay_backspace();
    assert_eq!(app.current_overlay_action().as_deref(), Some("ui:input"));
}

#[test]
fn distinguishes_recovery_sessions_q_exit_from_normal_filtering() {
    let mut app = AppState::default();
    app.open_overlay(OverlayState::List(ListOverlay {
        title: "会话".to_owned(),
        origin: OverlayOrigin::RecoverySession,
        items: vec![],
        selected: 0,
        filter: String::new(),
        status: String::new(),
    }));
    assert!(app.is_recovery_session_chooser());

    app.close_overlay();
    app.open_overlay(OverlayState::List(ListOverlay {
        title: "会话".to_owned(),
        origin: OverlayOrigin::User,
        items: vec![],
        selected: 0,
        filter: String::new(),
        status: String::new(),
    }));
    assert!(!app.is_recovery_session_chooser());
    app.overlay_insert("q");
    assert!(matches!(app.overlay(), Some(OverlayState::List(list)) if list.filter == "q"));
}

#[test]
fn scrolls_detail_and_confirms_ui_request_once() {
    let mut app = AppState::default();
    app.open_overlay(OverlayState::Detail(DetailOverlay {
        title: "详情".to_owned(),
        lines: (0..30).map(|value| value.to_string()).collect(),
        scroll: 0,
        status: String::new(),
        link: None,
        copy_text: None,
    }));
    app.overlay_page(1);
    assert_eq!(
        match app.overlay() {
            Some(OverlayState::Detail(detail)) => detail.scroll,
            _ => 0,
        },
        10
    );
    assert!(app.register_ui_request(UiRequest {
        id: "ui-1".to_owned(),
        kind: UiRequestKind::Confirm
    }));
    assert!(app.take_ui_response().is_some());
    assert!(app.take_ui_response().is_none());
    assert!(!app.register_ui_request(UiRequest {
        id: "ui-1".to_owned(),
        kind: UiRequestKind::Confirm
    }));
}

#[test]
fn restores_session_context_after_a_failed_switch() {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/original.jsonl".to_owned(), "/tmp".to_owned());
    app.lease_id = Some("old-lease".to_owned());
    app.editor.insert("保留的草稿");
    app.open_overlay(OverlayState::Detail(DetailOverlay {
        title: "会话".to_owned(),
        lines: vec!["原有覆盖层".to_owned()],
        scroll: 0,
        status: String::new(),
        link: None,
        copy_text: None,
    }));
    let restore = app.restore_point();
    app.begin_active_session("/tmp/target.jsonl".to_owned(), "/tmp".to_owned());
    app.clear_for_reload("读取目标");
    app.restore_session(restore);
    assert_eq!(app.active_session_path(), Some("/tmp/original.jsonl"));
    assert_eq!(app.lease_id.as_deref(), Some("old-lease"));
    assert_eq!(
        app.editor.visual_lines_with_cursor(80),
        vec!["保留的草稿|".to_owned()]
    );
    assert!(matches!(app.overlay(), Some(OverlayState::Detail(_))));
}

#[test]
fn keeps_tree_actions_on_visible_nodes_after_filtering() {
    let mut app = AppState {
        tree: vec![
            SessionTreeNode {
                id: "root".to_owned(),
                parent_id: None,
                kind: "message".to_owned(),
                label: Some("根".to_owned()),
                timestamp: String::new(),
                preview: "root".to_owned(),
                is_leaf: false,
                depth: 0,
            },
            SessionTreeNode {
                id: "target".to_owned(),
                parent_id: Some("root".to_owned()),
                kind: "message".to_owned(),
                label: Some("目标".to_owned()),
                timestamp: String::new(),
                preview: "needle".to_owned(),
                is_leaf: true,
                depth: 1,
            },
            SessionTreeNode {
                id: "other".to_owned(),
                parent_id: Some("root".to_owned()),
                kind: "message".to_owned(),
                label: Some("其他".to_owned()),
                timestamp: String::new(),
                preview: "other".to_owned(),
                is_leaf: true,
                depth: 1,
            },
        ],
        ..AppState::default()
    };
    app.open_overlay(OverlayState::List(ListOverlay {
        title: "分支树".to_owned(),
        origin: OverlayOrigin::User,
        items: app
            .tree
            .iter()
            .enumerate()
            .map(|(index, node)| OverlayItem {
                label: node.label.clone().unwrap_or_default(),
                detail: node.preview.clone(),
                action: format!("tree:{index}"),
            })
            .collect(),
        selected: 1,
        filter: "needle".to_owned(),
        status: String::new(),
    }));
    assert_eq!(app.tree_visible_indices(), vec![1]);
    assert_eq!(app.current_overlay_action().as_deref(), Some("tree:1"));
    app.select_tree_visible(1, true);
    assert_eq!(app.current_overlay_action().as_deref(), Some("tree:1"));
}

#[test]
fn tracks_custom_editor_operation_from_acceptance_through_terminal_update() {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/current.jsonl".to_owned(), "/tmp".to_owned());
    app.begin_custom_editor_submit(
        "accepted".to_owned(),
        PendingCustomEditorSubmit {
            command: "prompt".to_owned(),
            session_path: "/tmp/current.jsonl".to_owned(),
            session_generation: app.session_generation,
            editor_component_generation: None,
            lease_id: "lease".to_owned(),
            client_instance_id: "client".to_owned(),
            client_request_id: "request".to_owned(),
            text: "草稿".to_owned(),
            submit_revision: 0,
            attachments: Vec::new(),
            started_at: Instant::now(),
            retry_count: 0,
        },
    );

    app.acknowledge_custom_editor_submit("accepted", "operation-1".to_owned());
    assert_eq!(
        app.operation
            .as_ref()
            .map(|operation| operation.status.as_str()),
        Some("accepted")
    );
    assert!(
        app.accepted_custom_editor_submits
            .contains_key("operation-1")
    );

    let operation = |status: &str| OperationSnapshot {
        operation_id: "operation-1".to_owned(),
        client_instance_id: "client".to_owned(),
        client_request_id: "request".to_owned(),
        session_path: "/tmp/current.jsonl".to_owned(),
        operation_type: "prompt".to_owned(),
        status: status.to_owned(),
        progress: None,
        error: None,
    };
    app.apply_operation(operation("running"));
    assert_eq!(
        app.operation
            .as_ref()
            .map(|operation| operation.status.as_str()),
        Some("running")
    );
    assert!(
        app.accepted_custom_editor_submits
            .contains_key("operation-1")
    );

    app.apply_operation(OperationSnapshot {
        operation_id: "steer-1".to_owned(),
        client_instance_id: "client".to_owned(),
        client_request_id: "steer-request".to_owned(),
        session_path: "/tmp/current.jsonl".to_owned(),
        operation_type: "steer".to_owned(),
        status: "running".to_owned(),
        progress: None,
        error: None,
    });
    assert_eq!(
        app.operation
            .as_ref()
            .map(|operation| operation.operation_id.as_str()),
        Some("operation-1")
    );

    app.apply_operation(operation("aborted"));
    assert_eq!(
        app.operation
            .as_ref()
            .map(|operation| operation.status.as_str()),
        Some("aborted")
    );
    assert!(
        !app.accepted_custom_editor_submits
            .contains_key("operation-1")
    );
}

#[test]
fn recovers_custom_editor_drafts_without_leaking_or_readding_attachments() {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/current.jsonl".to_owned(), "/tmp".to_owned());
    let generation = app.session_generation;
    let submit = |text: &str, revision: u64, attachments: Vec<ComposerAttachment>| {
        PendingCustomEditorSubmit {
            command: "prompt".to_owned(),
            session_path: "/tmp/current.jsonl".to_owned(),
            session_generation: generation,
            editor_component_generation: None,
            lease_id: "lease-secret".to_owned(),
            client_instance_id: "client".to_owned(),
            client_request_id: "request".to_owned(),
            text: text.to_owned(),
            submit_revision: revision,
            attachments,
            started_at: Instant::now(),
            retry_count: 0,
        }
    };

    app.extension_ui.revision = 4;
    let pending = submit("恢复的草稿", 4, Vec::new());
    let debug = format!("{pending:?}");
    assert!(debug.contains("text_bytes"));
    assert!(!debug.contains("恢复的草稿"));
    assert!(!debug.contains("lease-secret"));
    app.begin_custom_editor_submit("direct".to_owned(), pending);
    app.reject_custom_editor_submit("direct");
    assert_eq!(app.editor.text(), "恢复的草稿");
    assert!(app.recovery_draft.is_none());

    app.editor.clear();
    app.begin_custom_editor_submit("changed".to_owned(), submit("不能覆盖", 4, Vec::new()));
    app.extension_ui.revision = 5;
    app.reject_custom_editor_submit("changed");
    assert!(app.editor.is_empty());
    assert!(app.recovery_draft.is_some());
    assert!(app.append_recovery_draft());
    assert_eq!(app.editor.text(), "\n不能覆盖");

    app.editor.clear();
    let attachment = app.new_attachment(
        "submitted.png".to_owned(),
        "submitted.png".to_owned(),
        "image/png".to_owned(),
        1,
        "submitted-hash".to_owned(),
        "secret-base64".to_owned(),
    );
    assert_eq!(app.add_attachment(attachment.clone()), Ok(true));
    let missing_submit = submit("附件草稿", 5, vec![attachment]);
    let debug = format!("{missing_submit:?}");
    assert!(!debug.contains("附件草稿"));
    assert!(!debug.contains("secret-base64"));
    app.begin_custom_editor_submit("missing".to_owned(), missing_submit);
    assert!(app.remove_attachment(0));
    app.extension_ui.revision = 6;
    app.reject_custom_editor_submit("missing");
    assert!(app.attachments.is_empty());
    assert_eq!(app.recovery_attachment_counts(), Some((1, 1)));

    let attachment = app.new_attachment(
        "success.png".to_owned(),
        "success.png".to_owned(),
        "image/png".to_owned(),
        1,
        "success-hash".to_owned(),
        "success-base64".to_owned(),
    );
    assert_eq!(app.add_attachment(attachment.clone()), Ok(true));
    app.begin_custom_editor_submit(
        "accepted".to_owned(),
        submit("接受后失败", 5, vec![attachment.clone()]),
    );
    app.acknowledge_custom_editor_submit("accepted", "operation-1".to_owned());
    assert!(app.pending_custom_editor_submits.is_empty());
    assert_eq!(app.attachments, vec![attachment]);
    app.settle_custom_editor_operation("operation-1", "failed");
    assert!(app.recovery_draft.is_some());
    app.begin_active_session("/tmp/other.jsonl".to_owned(), "/tmp".to_owned());
    assert!(app.recovery_draft.is_none());
}

#[test]
fn bounds_dedupes_and_keeps_new_composer_attachments_after_submit() {
    let mut app = AppState::default();
    let attachment = app.new_attachment(
        "sample.png".to_owned(),
        "sample.png".to_owned(),
        "image/png".to_owned(),
        4,
        "hash".to_owned(),
        "secret-image".to_owned(),
    );
    assert_eq!(app.add_attachment(attachment.clone()), Ok(true));
    assert_eq!(app.add_attachment(attachment.clone()), Ok(false));
    assert!(!format!("{attachment:?}").contains("secret-image"));
    app.begin_attachment_submit(
        "request".to_owned(),
        PendingAttachmentSubmit {
            command: "prompt".to_owned(),
            session_path: "/tmp/session.jsonl".to_owned(),
            lease_id: "lease".to_owned(),
            client_instance_id: "client".to_owned(),
            client_request_id: "request".to_owned(),
            text: "prompt".to_owned(),
            attachments: vec![attachment],
            started_at: Instant::now(),
        },
    );
    let later = app.new_attachment(
        "later.png".to_owned(),
        "later.png".to_owned(),
        "image/png".to_owned(),
        4,
        "later-hash".to_owned(),
        "later-image".to_owned(),
    );
    assert_eq!(app.add_attachment(later.clone()), Ok(true));
    app.acknowledge_attachment_submit("request");
    assert_eq!(app.attachments, vec![later]);
}

#[test]
fn tracks_transcript_requests_per_view_path_and_generation() {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/active.jsonl".to_owned(), "/tmp".to_owned());
    app.begin_transcript_request(
        "active-1".to_owned(),
        TranscriptViewKind::Active,
        TranscriptRequestKind::Initial,
        "/tmp/active.jsonl".to_owned(),
        app.session_generation,
        None,
    );
    app.readonly_view = Some(ReadonlySessionView {
        path: "/tmp/readonly.jsonl".to_owned(),
        generation: 7,
        ..ReadonlySessionView::default()
    });
    app.begin_transcript_request(
        "readonly-1".to_owned(),
        TranscriptViewKind::Readonly,
        TranscriptRequestKind::Search,
        "/tmp/readonly.jsonl".to_owned(),
        7,
        None,
    );
    app.invalidate_transcript_requests(TranscriptViewKind::Readonly);
    assert!(app.pending_transcript_requests.contains_key("active-1"));
    assert!(!app.pending_transcript_requests.contains_key("readonly-1"));
}
#[test]
fn clears_connection_lease_without_discarding_retryable_request() {
    let mut app = AppState::default();
    app.begin_active_session("/tmp/session.jsonl".to_owned(), "/tmp".to_owned());
    app.lease_id = Some("lease".to_owned());
    app.active_session.as_mut().unwrap().lease_id = Some("lease".to_owned());
    app.begin_request(
        "pending".to_owned(),
        WorkspaceRequest {
            command: lystar_protocol::WorkspaceCommand::GetAbout,
            payload: serde_json::Map::new(),
        },
        PendingIntent::Overlay {
            target: "关于".to_owned(),
        },
    );
    app.clear_connection_state("断线");
    assert!(app.lease_id.is_none());
    assert!(app.active_session.as_ref().unwrap().lease_id.is_none());
    assert!(app.pending_requests.contains_key("pending"));
    assert_eq!(app.disconnected.as_deref(), Some("断线"));
}

#[test]
fn keeps_parallel_pending_requests_and_rejects_closed_overlay_responses() {
    let mut app = AppState::default();
    app.open_workspace_overlay(
        "skills",
        OverlayState::Detail(DetailOverlay {
            title: "技能".to_owned(),
            lines: vec![],
            scroll: 0,
            status: String::new(),
            link: None,
            copy_text: None,
        }),
    );
    app.begin_request(
        "first".to_owned(),
        WorkspaceRequest {
            command: lystar_protocol::WorkspaceCommand::ListSkills,
            payload: serde_json::Map::new(),
        },
        PendingIntent::WorkbenchLoad {
            target: WorkbenchTarget::Skills,
            selected_key: None,
            filter: String::new(),
        },
    );
    app.open_workspace_overlay(
        "trust",
        OverlayState::Detail(DetailOverlay {
            title: "项目信任".to_owned(),
            lines: vec![],
            scroll: 0,
            status: String::new(),
            link: None,
            copy_text: None,
        }),
    );
    app.begin_request(
        "second".to_owned(),
        WorkspaceRequest {
            command: lystar_protocol::WorkspaceCommand::GetProjectTrust,
            payload: serde_json::Map::new(),
        },
        PendingIntent::WorkbenchLoad {
            target: WorkbenchTarget::Trust,
            selected_key: None,
            filter: String::new(),
        },
    );
    let first = app.take_pending("first").unwrap();
    let second = app.take_pending("second").unwrap();
    assert!(!app.pending_workspace_is_current(&first));
    assert!(app.pending_workspace_is_current(&second));
    app.close_overlay();
    assert!(!app.pending_workspace_is_current(&second));
    app.clear_overlay_transient();
    assert!(app.pending_requests.is_empty());
    assert!(app.overlays.is_empty());
    assert_eq!(app.input_focus, InputFocus::Composer);
}
