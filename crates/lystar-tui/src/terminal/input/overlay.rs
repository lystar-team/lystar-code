use super::*;

#[allow(clippy::too_many_arguments)]
pub(in super::super) fn handle_overlay_key(
    app: &mut AppState,
    code: KeyCode,
    modifiers: KeyModifiers,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
) -> Result<bool, TuiError> {
    if matches!(code, KeyCode::Char('q'))
        && !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
        && app.is_recovery_session_chooser()
    {
        return Ok(true);
    }
    match code {
        KeyCode::Esc => {
            if let Some(request) = app.take_ui_response() {
                pipe.request(&encode_ui_response(&request.id, None, None, Some(true))?)?;
                app.set_toast("已取消输入");
            }
            if matches!(app.overlay(), Some(OverlayState::Detail(detail)) if detail.title == "会话只读")
            {
                app.readonly_view = None;
                app.invalidate_transcript_requests(TranscriptViewKind::Readonly);
            }
            if matches!(app.overlay(), Some(OverlayState::Detail(detail)) if detail.title == "图片预览")
            {
                app.attachment_preview = None;
            }
            app.close_overlay();
        }
        KeyCode::Up => app.move_overlay_selection(-1),
        KeyCode::Down => app.move_overlay_selection(1),
        KeyCode::PageUp => app.overlay_page(-1),
        KeyCode::PageDown => app.overlay_page(1),
        KeyCode::Home => app.overlay_home_end(false),
        KeyCode::End => app.overlay_home_end(true),
        KeyCode::Char('V') if modifiers.contains(KeyModifiers::CONTROL) => {
            request_clipboard_both(app, pipe, sequence, ClipboardReadTarget::Insert)?;
        }
        KeyCode::Char('v') if modifiers.contains(KeyModifiers::CONTROL | KeyModifiers::SHIFT) => {
            request_clipboard_both(app, pipe, sequence, ClipboardReadTarget::Insert)?;
        }
        KeyCode::Char('v') if modifiers.contains(KeyModifiers::CONTROL) => {
            request_clipboard_read(app, pipe, sequence, true)?;
        }
        KeyCode::Char('y') if modifiers.contains(KeyModifiers::CONTROL) => {
            if let Some(text) = app.context_copy_text() {
                request_clipboard_write(
                    app,
                    pipe,
                    client_instance_id,
                    sequence,
                    text,
                    "已复制上下文",
                )?;
            } else {
                app.set_overlay_error("当前没有可复制的文本");
            }
        }
        KeyCode::Char('r')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "Subagent")
                && app.timed_out_workspace_request().is_none() =>
        {
            let filter = match app.overlay() {
                Some(OverlayState::List(list)) => list.filter.clone(),
                _ => String::new(),
            };
            let parent = app
                .subagent_parent_path
                .clone()
                .unwrap_or_else(|| session_path.to_owned());
            request_subagents(app, pipe, sequence, parent, None, filter)?;
        }
        KeyCode::Char('a')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "Subagent") =>
        {
            if let Some(index) = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("subagent:"))
                .and_then(|value| value.parse::<usize>().ok())
                && let Some(snapshot) = app.subagents.get(index)
            {
                if !snapshot.controllable || !subagent_running(&snapshot.state) {
                    app.set_overlay_error("当前 Subagent 不能停止");
                } else if app.active_session_path() != Some(snapshot.parent_session_path.as_str()) {
                    app.set_overlay_error("只允许控制当前会话的 Subagent");
                } else {
                    app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                        title: "停止 Subagent".to_owned(),
                        message: format!("确认停止 {}？", snapshot.name),
                        confirm_action: format!("subagent-abort:{index}"),
                        status: String::new(),
                    }));
                }
            }
        }
        KeyCode::Char('c')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "Subagent") =>
        {
            if let Some(index) = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("subagent:"))
                .and_then(|value| value.parse::<usize>().ok())
                && let Some(snapshot) = app.subagents.get(index)
            {
                if subagent_running(&snapshot.state) || snapshot.session_file.is_none() {
                    app.set_overlay_error("运行中的或无持久会话的 Subagent 不能继续");
                } else if app.active_session_path() != Some(snapshot.parent_session_path.as_str()) {
                    app.set_overlay_error("只允许控制当前会话的 Subagent");
                } else {
                    app.open_overlay(OverlayState::TextEditor(TextEditorOverlay {
                        title: format!("继续 {}", snapshot.name),
                        value: String::new(),
                        cursor: 0,
                        save_action: format!("subagent-continue:{index}"),
                        status: "Enter 继续，Shift+Enter 换行，Esc 取消".to_owned(),
                        secret: false,
                    }));
                }
            }
        }
        KeyCode::Char('i')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::Detail(detail)) if detail.title == "剪贴板") =>
        {
            if let Some(text) = app
                .clipboard
                .as_ref()
                .and_then(|clipboard| clipboard.text.as_deref())
            {
                app.editor.insert(text);
                app.set_toast("已插入剪贴板文本");
            } else {
                app.set_overlay_error("剪贴板没有文本");
            }
        }
        KeyCode::Char('w')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::Detail(detail)) if detail.title == "剪贴板") =>
        {
            request_clipboard_write(
                app,
                pipe,
                client_instance_id,
                sequence,
                app.editor.text().to_owned(),
                "已写入剪贴板",
            )?;
        }
        KeyCode::Char('v')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::Detail(detail)) if detail.title == "Subagent 详情") =>
        {
            if let Some(path) = app
                .subagent_detail
                .as_ref()
                .and_then(|snapshot| snapshot.session_file.clone())
            {
                open_readonly_session(app, pipe, sequence, session_flow, path)?;
            } else {
                app.set_overlay_error("Subagent 没有持久 Session");
            }
        }
        KeyCode::Enter if matches!(app.overlay(), Some(OverlayState::Detail(detail)) if detail.title == "Subagent 详情") => {
            if let Some(path) = app
                .subagent_detail
                .as_ref()
                .and_then(|snapshot| snapshot.session_file.clone())
            {
                app.open_workspace_overlay(
                    format!("subagents:{path}"),
                    OverlayState::Detail(DetailOverlay {
                        title: "Subagent".to_owned(),
                        lines: vec!["正在读取嵌套 Subagent".to_owned()],
                        scroll: 0,
                        status: "请稍候".to_owned(),
                        link: None,
                        copy_text: None,
                    }),
                );
                request_subagents(app, pipe, sequence, path, None, String::new())?;
            } else {
                app.set_overlay_error("Subagent 没有持久 Session");
            }
        }
        KeyCode::Tab if matches!(app.overlay(), Some(OverlayState::List(list)) if list.title.starts_with("变更 [")) =>
        {
            app.changes_tab = match app.changes_tab {
                ChangesTab::Staged => ChangesTab::Unstaged,
                ChangesTab::Unstaged => ChangesTab::All,
                ChangesTab::All => ChangesTab::Staged,
            };
            let filter = match app.overlay() {
                Some(OverlayState::List(list)) => list.filter.clone(),
                _ => String::new(),
            };
            app.replace_overlay(changes_overlay(app, None, filter));
        }
        KeyCode::Tab if matches!(app.overlay(), Some(OverlayState::List(list)) if list.title.starts_with("指令 [")) =>
        {
            let filter = match app.overlay() {
                Some(OverlayState::List(list)) => list.filter.clone(),
                _ => String::new(),
            };
            let target = if matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "指令 [项目]")
            {
                WorkbenchTarget::InstructionsHost
            } else {
                WorkbenchTarget::InstructionsProject
            };
            request_workspace_load(app, pipe, sequence, target, None, filter)?;
        }
        KeyCode::Char('o')
            if modifiers.contains(KeyModifiers::CONTROL)
                && matches!(app.overlay(), Some(OverlayState::Detail(detail)) if detail.title == "变更详情") =>
        {
            app.change_detail_expanded = !app.change_detail_expanded;
            app.replace_overlay(change_detail_overlay(app));
        }
        KeyCode::Char('r')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title.starts_with("变更 [")) =>
        {
            let filter = match app.overlay() {
                Some(OverlayState::List(list)) => list.filter.clone(),
                _ => String::new(),
            };
            request_workspace_load(app, pipe, sequence, WorkbenchTarget::Changes, None, filter)?;
        }
        KeyCode::Char('r')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "技能") =>
        {
            let filter = match app.overlay() {
                Some(OverlayState::List(list)) => list.filter.clone(),
                _ => String::new(),
            };
            request_workspace_load(app, pipe, sequence, WorkbenchTarget::Skills, None, filter)?;
        }
        KeyCode::Char('r')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title.starts_with("指令 [")) =>
        {
            let (target, filter) = match app.overlay() {
                Some(OverlayState::List(list)) => (
                    if list.title == "指令 [项目]" {
                        WorkbenchTarget::InstructionsProject
                    } else {
                        WorkbenchTarget::InstructionsHost
                    },
                    list.filter.clone(),
                ),
                _ => (WorkbenchTarget::InstructionsProject, String::new()),
            };
            request_workspace_load(app, pipe, sequence, target, None, filter)?;
        }
        KeyCode::Char('r')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "包") =>
        {
            let filter = match app.overlay() {
                Some(OverlayState::List(list)) => list.filter.clone(),
                _ => String::new(),
            };
            request_workspace_load(app, pipe, sequence, WorkbenchTarget::Packages, None, filter)?;
        }
        KeyCode::Char('r')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::Detail(detail)) if detail.title == "更新检查") =>
        {
            request_workspace_load(
                app,
                pipe,
                sequence,
                WorkbenchTarget::Update,
                None,
                String::new(),
            )?;
        }
        KeyCode::Char('t')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "项目信任") =>
        {
            activate_workbench_action(
                app,
                "trust:toggle",
                pipe,
                session_path,
                client_instance_id,
                sequence,
                session_flow,
            )?;
        }
        KeyCode::Char('i')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "包") =>
        {
            app.open_overlay(OverlayState::TextEditor(TextEditorOverlay {
                title: "安装包来源".to_owned(),
                value: String::new(),
                cursor: 0,
                save_action: "package-install-source".to_owned(),
                status: "Enter 选择作用域，Shift+Enter 换行，Esc 取消".to_owned(),
                secret: false,
            }));
        }
        KeyCode::Char('d')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "图片附件") =>
        {
            if let Some(index) = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("attachment:"))
                .and_then(|value| value.parse::<usize>().ok())
            {
                app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                    title: "删除图片附件".to_owned(),
                    message: "确认删除当前图片附件？".to_owned(),
                    confirm_action: format!("attachment-remove:{index}"),
                    status: String::new(),
                }));
            }
        }
        KeyCode::Char('D')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "图片附件") =>
        {
            if app.attachments.is_empty() {
                app.set_toast("没有可清空的图片附件");
            } else {
                app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                    title: "清空图片附件".to_owned(),
                    message: "确认清空全部图片附件？".to_owned(),
                    confirm_action: "attachment-clear".to_owned(),
                    status: String::new(),
                }));
            }
        }
        KeyCode::Char('d')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "包") =>
        {
            if let Some(index) = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("package:"))
                .and_then(|value| value.parse::<usize>().ok())
            {
                app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                    title: "删除包".to_owned(),
                    message: "确认移除当前包配置？".to_owned(),
                    confirm_action: format!("package-remove:{index}"),
                    status: String::new(),
                }));
            }
        }
        KeyCode::Char('u')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "包") =>
        {
            if let Some(action) = app.current_overlay_action() {
                activate_workbench_action(
                    app,
                    &format!("package-update:{action}"),
                    pipe,
                    session_path,
                    client_instance_id,
                    sequence,
                    session_flow,
                )?;
            }
        }
        KeyCode::Char('U')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "包") =>
        {
            activate_workbench_action(
                app,
                "package-update-all",
                pipe,
                session_path,
                client_instance_id,
                sequence,
                session_flow,
            )?;
        }
        KeyCode::Left => app.overlay_move_left(),
        KeyCode::Right => app.overlay_move_right(),
        KeyCode::Enter if modifiers.contains(KeyModifiers::SHIFT) => app.overlay_insert_newline(),
        KeyCode::Tab => {}
        KeyCode::Char('d') if modifiers == KeyModifiers::CONTROL => {
            set_tree_filter(app, TreeFilter::Default);
        }
        KeyCode::Char('t') if modifiers == KeyModifiers::CONTROL => {
            set_tree_filter(app, TreeFilter::NoTools);
        }
        KeyCode::Char('u') if modifiers == KeyModifiers::CONTROL => {
            set_tree_filter(app, TreeFilter::UserOnly);
        }
        KeyCode::Char('l') if modifiers == KeyModifiers::CONTROL => {
            set_tree_filter(app, TreeFilter::LabeledOnly);
        }
        KeyCode::Char('a') if modifiers == KeyModifiers::CONTROL => {
            set_tree_filter(app, TreeFilter::All);
        }

        KeyCode::Char('r')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && !app
                    .current_overlay_action()
                    .as_deref()
                    .is_some_and(|action| action.starts_with("session:")) =>
        {
            if let Some((id, request)) = app.restart_timed_out_workspace_request() {
                pipe.request(&encode_workspace_request(
                    &id,
                    request.command,
                    request.payload,
                )?)?;
                app.set_toast("正在重试请求");
            } else {
                app.overlay_insert("r");
            }
        }
        KeyCode::Char('c') if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => {
            if let Some(text) = app.overlay_copy_text() {
                let client_request_id = format!("clipboard:{}", sequence.saturating_add(1));
                app.mark_write_pending();
                request_workspace(
                    app,
                    pipe,
                    sequence,
                    WorkspaceCommand::WriteClipboardText,
                    serde_json::json!({
                        "text": text,
                        "clientInstanceId": client_instance_id,
                        "clientRequestId": client_request_id,
                    })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                    PendingIntent::ClipboardMutation {
                        toast: "设备码已复制".to_owned(),
                    },
                )?;
            } else {
                app.overlay_insert("c");
            }
        }
        KeyCode::Char('n')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "会话") =>
        {
            if app.is_active_operation() || session_flow.is_some() {
                app.set_overlay_error("当前会话正在运行，不能切换");
            } else {
                *sequence += 1;
                let id = format!("session-create-{sequence}");
                *session_flow = Some(SessionFlow::CreateStarting {
                    id: id.clone(),
                    restore: app.restore_point(),
                });
                pipe.request(&encode_create_session_request(
                    &id,
                    session_path,
                    client_instance_id,
                    &format!("create:{sequence}"),
                )?)?;
            }
        }
        KeyCode::Char('n')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "分支树") =>
        {
            app.select_tree_visible(1, true);
        }
        KeyCode::Char('p')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "分支树") =>
        {
            app.select_tree_visible(-1, true);
        }
        KeyCode::Char('v') if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => {
            if let Some(index) = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("session:"))
                .and_then(|value| value.parse::<usize>().ok())
                && let Some(session) = app.sessions.get(index)
            {
                let path = session.path.clone();
                let generation = app
                    .readonly_view
                    .as_ref()
                    .map_or(1, |readonly| readonly.generation.saturating_add(1));
                *sequence += 1;
                let id = format!("readonly-initial-{sequence}");
                *session_flow = Some(SessionFlow::Readonly {
                    id: id.clone(),
                    path: path.clone(),
                    replace: true,
                    generation,
                });
                app.readonly_view = Some(ReadonlySessionView {
                    path: path.clone(),
                    generation,
                    status: "正在读取".to_owned(),
                    ..ReadonlySessionView::default()
                });
                app.open_overlay(OverlayState::Detail(DetailOverlay {
                    title: "会话只读".to_owned(),
                    lines: vec!["正在读取".to_owned()],
                    scroll: 0,
                    status: "只读".to_owned(),
                    link: None,
                    copy_text: None,
                }));
                app.begin_transcript_request(
                    id.clone(),
                    TranscriptViewKind::Readonly,
                    TranscriptRequestKind::Initial,
                    path.clone(),
                    generation,
                    None,
                );
                pipe.request(&encode_read_transcript_request(
                    &id,
                    &path,
                    INITIAL_PAGE_LIMIT,
                    None,
                    None,
                )?)?;
            } else if let Some(index) = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("tree:"))
                .and_then(|value| value.parse::<usize>().ok())
            {
                let path = session_path.to_owned();
                let generation = app
                    .readonly_view
                    .as_ref()
                    .map_or(1, |readonly| readonly.generation.saturating_add(1));
                *sequence += 1;
                let id = format!("readonly-initial-{sequence}");
                *session_flow = Some(SessionFlow::Readonly {
                    id: id.clone(),
                    path: path.clone(),
                    replace: true,
                    generation,
                });
                app.readonly_view = Some(ReadonlySessionView {
                    path: path.clone(),
                    generation,
                    status: format!(
                        "定位 {}",
                        app.tree
                            .get(index)
                            .map(|node| node.id.as_str())
                            .unwrap_or_default()
                    ),
                    ..ReadonlySessionView::default()
                });
                app.open_overlay(OverlayState::Detail(DetailOverlay {
                    title: "会话只读".to_owned(),
                    lines: vec!["正在读取".to_owned()],
                    scroll: 0,
                    status: "只读".to_owned(),
                    link: None,
                    copy_text: None,
                }));
                app.begin_transcript_request(
                    id.clone(),
                    TranscriptViewKind::Readonly,
                    TranscriptRequestKind::Initial,
                    path.clone(),
                    generation,
                    None,
                );
                pipe.request(&encode_read_transcript_request(
                    &id,
                    &path,
                    INITIAL_PAGE_LIMIT,
                    None,
                    None,
                )?)?;
            } else {
                app.overlay_insert("v");
            }
        }
        KeyCode::Char('r')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && app
                    .current_overlay_action()
                    .as_deref()
                    .is_some_and(|action| action.starts_with("session:")) =>
        {
            let index = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("session:"))
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            if let Some(session) = app.sessions.get(index) {
                let value = session
                    .name
                    .clone()
                    .unwrap_or_else(|| session.first_message.clone());
                app.open_overlay(OverlayState::TextEditor(TextEditorOverlay {
                    title: "重命名会话".to_owned(),
                    cursor: value.len(),
                    value,
                    save_action: format!("session-rename:{index}"),
                    status: "Enter 保存，Esc 返回".to_owned(),
                    secret: false,
                }));
            }
        }
        KeyCode::Char('f') if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => {
            if app
                .current_overlay_action()
                .as_deref()
                .is_some_and(|action| action.starts_with("session:"))
            {
                app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                    title: "分叉会话".to_owned(),
                    message: "确认从当前选中记录创建并切换会话？".to_owned(),
                    confirm_action: "session-fork-current".to_owned(),
                    status: String::new(),
                }));
            } else if let Some(index) = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("tree:"))
                .and_then(|value| value.parse::<usize>().ok())
            {
                app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                    title: "分叉会话".to_owned(),
                    message: "确认从分支树选中记录创建并切换会话？".to_owned(),
                    confirm_action: format!("tree-fork:{index}"),
                    status: String::new(),
                }));
            } else {
                app.overlay_insert("f");
            }
        }
        KeyCode::Char('l')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && app
                    .current_overlay_action()
                    .as_deref()
                    .is_some_and(|action| action.starts_with("tree:")) =>
        {
            let index = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("tree:"))
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            if let Some(node) = app.tree.get(index) {
                let value = node.label.clone().unwrap_or_default();
                app.open_overlay(OverlayState::TextEditor(TextEditorOverlay {
                    title: "编辑标签".to_owned(),
                    cursor: value.len(),
                    value,
                    save_action: format!("tree-label:{index}"),
                    status: "留空可清除标签，Enter 保存".to_owned(),
                    secret: false,
                }));
            }
        }
        KeyCode::Char('s')
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                && app
                    .current_overlay_action()
                    .as_deref()
                    .is_some_and(|action| action.starts_with("tree:")) =>
        {
            let index = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("tree:"))
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                title: "摘要跳转".to_owned(),
                message: "跳转前生成分支摘要？".to_owned(),
                confirm_action: format!("tree-summary:{index}"),
                status: String::new(),
            }));
        }
        KeyCode::Char('d') if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => {
            if let Some(index) = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("session:"))
                .and_then(|value| value.parse::<usize>().ok())
                && app
                    .sessions
                    .get(index)
                    .is_some_and(|session| Some(session.path.as_str()) == app.active_session_path())
            {
                app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                    title: "删除会话".to_owned(),
                    message: "确认删除当前会话？".to_owned(),
                    confirm_action: "session-delete-current".to_owned(),
                    status: String::new(),
                }));
            } else if let Some(index) = app
                .current_overlay_action()
                .as_deref()
                .and_then(|action| action.strip_prefix("login-provider:"))
                .and_then(|value| value.parse::<usize>().ok())
                && let Some(provider) = app.providers.get(index)
            {
                app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                    title: "退出登录".to_owned(),
                    message: format!("确认退出 {}？", provider.name),
                    confirm_action: format!("auth-logout:{index}"),
                    status: "d 仅在登录列表可用".to_owned(),
                }));
            } else {
                app.overlay_insert("d");
            }
        }
        KeyCode::Backspace => app.overlay_backspace(),
        KeyCode::Enter => {
            if let Some(action) = app.current_overlay_action() {
                activate_workbench_action(
                    app,
                    &action,
                    pipe,
                    session_path,
                    client_instance_id,
                    sequence,
                    session_flow,
                )?;
            }
        }
        KeyCode::Char(value)
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
        {
            app.overlay_insert(&value.to_string())
        }
        _ => {}
    }
    Ok(false)
}

#[cfg(unix)]
pub(in super::super) fn set_tree_filter(app: &mut AppState, tree_filter: TreeFilter) {
    let Some(OverlayState::List(list)) = app.overlay() else {
        return;
    };
    if list.title != "分支树" {
        return;
    }
    let filter = list.filter.clone();
    let selected_key = list
        .items
        .get(list.selected)
        .and_then(|item| item.action.strip_prefix("tree:"))
        .and_then(|index| index.parse::<usize>().ok())
        .and_then(|index| app.tree.get(index))
        .map(|node| node.id.clone());
    app.tree_filter = tree_filter;
    app.replace_overlay(tree_overlay(
        &app.tree,
        selected_key.as_deref(),
        filter,
        tree_filter,
    ));
}
