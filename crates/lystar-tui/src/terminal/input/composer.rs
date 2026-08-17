use super::*;

#[allow(clippy::too_many_arguments)]
pub(in super::super) fn handle_key(
    app: &mut AppState,
    code: KeyCode,
    modifiers: KeyModifiers,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
    quit_requested: &mut bool,
) -> Result<bool, TuiError> {
    let session_path = app.active_session_path().unwrap_or(session_path).to_owned();
    if matches!(code, KeyCode::Char('c')) && modifiers.contains(KeyModifiers::CONTROL) {
        interrupt_active_operation(app, pipe, sequence)?;
        return Ok(false);
    }
    if is_readonly_overlay(app) {
        return handle_readonly_key(app, code, modifiers, pipe, sequence);
    }
    if app.search.open {
        match code {
            KeyCode::Esc => {
                app.close_search();
                trace("search_close");
            }
            KeyCode::Enter => {
                if app.search.query.trim().is_empty() {
                    app.search.status = "请输入搜索内容".to_owned();
                } else if app.select_search_result().is_none() {
                    let query = app.search.query.clone();
                    trace("search_submit");
                    request_search(
                        app,
                        pipe,
                        &session_path,
                        &query,
                        TranscriptViewKind::Active,
                        sequence,
                    )?;
                }
            }
            KeyCode::Up => app.search.selected = app.search.selected.saturating_sub(1),
            KeyCode::Down => {
                app.search.selected =
                    (app.search.selected + 1).min(app.search.hits.len().saturating_sub(1))
            }
            KeyCode::Backspace => {
                app.search.query.pop();
                app.search.hits.clear();
            }
            KeyCode::Char(character) if !modifiers.contains(KeyModifiers::CONTROL) => {
                app.search.query.push(character)
            }
            _ => {}
        }
        return Ok(false);
    }

    if matches!(code, KeyCode::Char('p')) && modifiers.contains(KeyModifiers::CONTROL) {
        app.open_overlay(OverlayState::List(ListOverlay {
            title: "命令面板".to_owned(),
            origin: OverlayOrigin::User,
            items: [
                ("subagents", "Subagent"),
                ("clipboard", "剪贴板"),
                ("changes", "变更"),
                ("skills", "技能"),
                ("trust", "项目信任"),
                ("instructions", "指令"),
                ("packages", "包"),
                ("update", "更新检查"),
                ("new", "新建会话"),
                ("compact", "压缩上下文"),
                ("sessions", "会话"),
                ("tree", "分支树"),
                ("help", "帮助"),
                ("settings", "设置"),
                ("model", "模型"),
                ("thinking", "思考"),
                ("login", "登录"),
                ("about", "关于"),
                ("doctor", "诊断"),
            ]
            .into_iter()
            .map(|(target, detail)| OverlayItem {
                label: format!("/{target}"),
                detail: detail.to_owned(),
                action: format!("open:{target}"),
            })
            .collect(),
            selected: 0,
            filter: String::new(),
            status: "输入筛选，Enter 打开".to_owned(),
        }));
        return Ok(false);
    }

    if app.input_focus == InputFocus::Overlay {
        return handle_overlay_key(
            app,
            code,
            modifiers,
            pipe,
            &session_path,
            client_instance_id,
            sequence,
            session_flow,
        );
    }

    if matches!(code, KeyCode::Esc) {
        interrupt_active_operation(app, pipe, sequence)?;
        return Ok(false);
    }

    match code {
        KeyCode::Char('q') if app.editor.is_empty() => {
            *quit_requested = true;
            if session_flow.is_some() {
                return Ok(false);
            }
            let Some(lease_id) = app.lease_id.clone() else {
                return Ok(true);
            };
            *sequence += 1;
            let id = format!("quit-release-{sequence}");
            *session_flow = Some(SessionFlow::QuitReleasing { id: id.clone() });
            pipe.request(&encode_release_session_request(
                &id,
                &session_path,
                &lease_id,
            )?)?;
        }
        KeyCode::Char('f') if modifiers.contains(KeyModifiers::CONTROL) => {
            app.open_search();
            trace("search_open");
        }
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
        KeyCode::Char('o')
            if modifiers.contains(KeyModifiers::CONTROL)
                && app.transcript.current_tool_is_subagent() =>
        {
            open_workbench(
                app,
                "subagents",
                pipe,
                &session_path,
                client_instance_id,
                sequence,
                session_flow,
            )?;
        }
        KeyCode::Char('o') if modifiers.contains(KeyModifiers::CONTROL) => {
            app.toggle_tool_expansion()
        }
        KeyCode::Char('u') if modifiers.contains(KeyModifiers::CONTROL) => app.editor.clear(),
        KeyCode::Char('z') if modifiers.contains(KeyModifiers::CONTROL) => app.editor.undo(),
        KeyCode::Char('r') if modifiers.contains(KeyModifiers::CONTROL) => {
            if app.recovery_draft.is_some() {
                open_custom_editor_recovery(app);
            } else if let Some((id, submit)) = app.restart_timed_out_custom_editor_submit() {
                let images = submit
                    .attachments
                    .iter()
                    .map(|attachment| {
                        serde_json::json!({ "data": attachment.base64, "mimeType": attachment.mime_type })
                    })
                    .collect::<Vec<_>>();
                pipe.request(&encode_queue_request(
                    &id,
                    &submit.command,
                    &submit.session_path,
                    &submit.lease_id,
                    &submit.client_instance_id,
                    &submit.client_request_id,
                    Some(&submit.text),
                    Some(&images),
                )?)?;
                app.set_toast("正在重试提交");
            } else if let Some((id, submit)) = app.restart_timed_out_attachment_submit() {
                let images = submit
                    .attachments
                    .iter()
                    .map(|attachment| {
                        serde_json::json!({ "data": attachment.base64, "mimeType": attachment.mime_type })
                    })
                    .collect::<Vec<_>>();
                pipe.request(&encode_queue_request(
                    &id,
                    &submit.command,
                    &submit.session_path,
                    &submit.lease_id,
                    &submit.client_instance_id,
                    &submit.client_request_id,
                    Some(&submit.text),
                    Some(&images),
                )?)?;
                app.set_toast("正在重试提交");
            } else {
                app.editor.redo();
            }
        }
        KeyCode::Char('j') if modifiers.contains(KeyModifiers::CONTROL) => app.editor.insert("\n"),
        KeyCode::Tab if app.editor.text().starts_with("/attach ") => {
            request_attach_completion(app, pipe, sequence)?;
        }
        KeyCode::Enter if modifiers.contains(KeyModifiers::SHIFT) => app.editor.insert("\n"),
        KeyCode::Enter => submit_editor(
            app,
            pipe,
            &session_path,
            client_instance_id,
            sequence,
            modifiers.contains(KeyModifiers::ALT),
            session_flow,
        )?,
        KeyCode::Backspace => app.editor.backspace(),
        KeyCode::Delete => app.editor.delete(),
        KeyCode::Left => app.editor.move_left(),
        KeyCode::Right => app.editor.move_right(),
        KeyCode::Home => {
            app.editor.move_home();
            if app.editor.is_empty() {
                trace("key_home");
                app.transcript.current = 0;
                app.transcript.scroll = 0;
            }
        }
        KeyCode::End => {
            app.editor.move_end();
            if app.editor.is_empty() {
                trace("key_end");
                let last = app.transcript.cached_rounds().saturating_sub(1);
                app.transcript.current = last;
                app.transcript.scroll = last;
            }
        }
        KeyCode::Up if app.editor.at_first_visual_line_start(app.composer_width()) => {
            app.editor.history_previous();
        }
        KeyCode::Down if app.editor.at_last_visual_line(app.composer_width()) => {
            app.editor.history_next();
        }
        KeyCode::Up => app.editor.move_up(),
        KeyCode::Down => app.editor.move_down(),
        KeyCode::PageUp => {
            trace("key_page_up");
            app.transcript.scroll_by(-20);
        }
        KeyCode::PageDown => app.transcript.scroll_by(20),
        KeyCode::Char(character)
            if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
        {
            app.editor.insert(&character.to_string())
        }
        _ => {}
    }
    Ok(false)
}

pub(in super::super) fn builtin_slash_command(text: &str) -> Option<&'static str> {
    match text.trim() {
        "/subagents" => Some("subagents"),
        "/clipboard" => Some("clipboard"),
        "/changes" => Some("changes"),
        "/skills" => Some("skills"),
        "/trust" => Some("trust"),
        "/instructions" => Some("instructions"),
        "/packages" => Some("packages"),
        "/update" => Some("update"),
        "/about" => Some("about"),
        "/doctor" => Some("doctor"),
        "/help" => Some("help"),
        "/new" => Some("new"),
        "/compact" => Some("compact"),
        "/sessions" => Some("sessions"),
        "/tree" => Some("tree"),
        "/settings" => Some("settings"),
        "/model" => Some("model"),
        "/thinking" => Some("thinking"),
        "/login" => Some("login"),
        _ => None,
    }
}

#[cfg(unix)]
pub(in super::super) fn open_readonly_session(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
    path: String,
) -> Result<(), TuiError> {
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
    )?)
}
