use super::*;
pub(super) fn raw_key(code: KeyCode, modifiers: KeyModifiers) -> Option<String> {
    if modifiers.intersects(KeyModifiers::HYPER | KeyModifiers::META) {
        return None;
    }
    let modifier = 1
        + u8::from(modifiers.contains(KeyModifiers::SHIFT))
        + 2 * u8::from(modifiers.contains(KeyModifiers::ALT))
        + 4 * u8::from(modifiers.contains(KeyModifiers::CONTROL))
        + 8 * u8::from(modifiers.contains(KeyModifiers::SUPER));
    let modified = modifier > 1;
    let value = match code {
        KeyCode::Char(character) if modifiers == KeyModifiers::CONTROL && character.is_ascii() => {
            let upper = character.to_ascii_uppercase() as u8;
            ((upper & 0x1f) as char).to_string()
        }
        KeyCode::Char(character) if modified => {
            format!("\x1b[{};{modifier}u", character as u32)
        }
        KeyCode::Char(character) => character.to_string(),
        KeyCode::Enter if modifiers == KeyModifiers::ALT => "\x1b\r".to_owned(),
        KeyCode::Enter if modified => format!("\x1b[13;{modifier}u"),
        KeyCode::Enter => "\r".to_owned(),
        KeyCode::BackTab => "\x1b[Z".to_owned(),
        KeyCode::Tab if modified => format!("\x1b[9;{modifier}u"),
        KeyCode::Tab => "\t".to_owned(),
        KeyCode::Backspace if modified => format!("\x1b[127;{modifier}u"),
        KeyCode::Backspace => "\x7f".to_owned(),
        KeyCode::Esc if modified => format!("\x1b[27;{modifier}u"),
        KeyCode::Esc => "\x1b".to_owned(),
        KeyCode::Up if modified => format!("\x1b[1;{modifier}A"),
        KeyCode::Up => "\x1b[A".to_owned(),
        KeyCode::Down if modified => format!("\x1b[1;{modifier}B"),
        KeyCode::Down => "\x1b[B".to_owned(),
        KeyCode::Right if modified => format!("\x1b[1;{modifier}C"),
        KeyCode::Right => "\x1b[C".to_owned(),
        KeyCode::Left if modified => format!("\x1b[1;{modifier}D"),
        KeyCode::Left => "\x1b[D".to_owned(),
        KeyCode::Home if modified => format!("\x1b[1;{modifier}H"),
        KeyCode::Home => "\x1b[H".to_owned(),
        KeyCode::End if modified => format!("\x1b[1;{modifier}F"),
        KeyCode::End => "\x1b[F".to_owned(),
        KeyCode::Insert if modified => format!("\x1b[2;{modifier}~"),
        KeyCode::Insert => "\x1b[2~".to_owned(),
        KeyCode::Delete if modified => format!("\x1b[3;{modifier}~"),
        KeyCode::Delete => "\x1b[3~".to_owned(),
        KeyCode::PageUp if modified => format!("\x1b[5;{modifier}~"),
        KeyCode::PageUp => "\x1b[5~".to_owned(),
        KeyCode::PageDown if modified => format!("\x1b[6;{modifier}~"),
        KeyCode::PageDown => "\x1b[6~".to_owned(),
        KeyCode::F(_) if modified => return None,
        KeyCode::F(number @ 1..=4) => {
            format!("\x1bO{}", ["P", "Q", "R", "S"][(number - 1) as usize])
        }
        KeyCode::F(number @ 5..=12) => format!(
            "\x1b[{}~",
            [15, 17, 18, 19, 20, 21, 23, 24][(number - 5) as usize]
        ),
        _ => return None,
    };
    Some(value)
}

pub(super) fn raw_mouse(kind: MouseEventKind, column: u16, row: u16) -> Option<String> {
    let (code, suffix) = match kind {
        MouseEventKind::Down(_) => (0, 'M'),
        MouseEventKind::Up(_) => (3, 'm'),
        MouseEventKind::Drag(_) => (32, 'M'),
        MouseEventKind::Moved => (35, 'M'),
        MouseEventKind::ScrollUp => (64, 'M'),
        MouseEventKind::ScrollDown => (65, 'M'),
        MouseEventKind::ScrollLeft => (66, 'M'),
        MouseEventKind::ScrollRight => (67, 'M'),
    };
    Some(format!(
        "\x1b[<{code};{};{}{suffix}",
        column.saturating_add(1),
        row.saturating_add(1)
    ))
}

pub(super) fn interrupt_active_operation(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
) -> Result<(), TuiError> {
    let Some(lease_id) = app.lease_id.clone() else {
        return Ok(());
    };
    let Some(operation_id) = app.operation.as_ref().and_then(|operation| {
        matches!(
            operation.status.as_str(),
            "accepted" | "running" | "waiting_for_input"
        )
        .then(|| operation.operation_id.clone())
    }) else {
        return Ok(());
    };
    *sequence += 1;
    pipe.request(&encode_abort_operation_request(
        &format!("abort-{sequence}"),
        &operation_id,
        &lease_id,
    )?)?;
    if let Some(operation) = app.operation.as_mut()
        && operation.operation_id == operation_id
    {
        operation.status = "aborting".to_owned();
    }
    app.transcript.status = "正在停止".to_owned();
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply_extension_editor_app_action(
    app: &mut AppState,
    action: &str,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
    quit_requested: &mut bool,
) -> Result<(), TuiError> {
    let active_path = app.active_session_path().unwrap_or(session_path).to_owned();
    match action {
        "app.interrupt" => interrupt_active_operation(app, pipe, sequence)?,
        "app.clear" => app.editor.clear(),
        "app.exit" => *quit_requested = true,
        "app.clipboard.pasteImage" => {
            request_clipboard_both(app, pipe, sequence, ClipboardReadTarget::Insert)?;
        }
        "app.model.cycleForward" => cycle_model(
            app,
            pipe,
            &active_path,
            client_instance_id,
            sequence,
            session_flow,
            "forward",
        )?,
        "app.model.cycleBackward" => cycle_model(
            app,
            pipe,
            &active_path,
            client_instance_id,
            sequence,
            session_flow,
            "backward",
        )?,
        "app.model.select" => {
            open_workbench(
                app,
                "model",
                pipe,
                &active_path,
                client_instance_id,
                sequence,
                session_flow,
            )?;
        }
        "app.thinking.cycle" => cycle_thinking(
            app,
            pipe,
            &active_path,
            client_instance_id,
            sequence,
            session_flow,
        )?,
        "app.thinking.toggle" => app.toggle_thinking_visibility(),
        "app.tools.expand" => app.toggle_tool_expansion(),
        "extension_shortcut" => app.set_toast("扩展快捷键未处理"),
        "app.message.followUp" => {
            submit_custom_editor(
                app,
                pipe,
                &active_path,
                client_instance_id,
                sequence,
                true,
                session_flow,
            )?;
        }
        _ => app.set_toast("自定义编辑器动作已接收"),
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply_extension_raw_input(
    app: &mut AppState,
    data: &str,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
    quit_requested: &mut bool,
) -> Result<bool, TuiError> {
    if let Some(text) = data
        .strip_prefix("\x1b[200~")
        .and_then(|value| value.strip_suffix("\x1b[201~"))
    {
        app.editor.insert(text);
        return Ok(false);
    }
    let (code, modifiers) = match data {
        "\r" | "\n" => (KeyCode::Enter, KeyModifiers::NONE),
        "\t" => (KeyCode::Tab, KeyModifiers::NONE),
        "\x7f" => (KeyCode::Backspace, KeyModifiers::NONE),
        "\x1b" => (KeyCode::Esc, KeyModifiers::NONE),
        "\x1b[A" => (KeyCode::Up, KeyModifiers::NONE),
        "\x1b[B" => (KeyCode::Down, KeyModifiers::NONE),
        "\x1b[C" => (KeyCode::Right, KeyModifiers::NONE),
        "\x1b[D" => (KeyCode::Left, KeyModifiers::NONE),
        "\x1b[H" => (KeyCode::Home, KeyModifiers::NONE),
        "\x1b[F" => (KeyCode::End, KeyModifiers::NONE),
        "\x1b[5~" => (KeyCode::PageUp, KeyModifiers::NONE),
        "\x1b[6~" => (KeyCode::PageDown, KeyModifiers::NONE),
        "\x04" => {
            if app.editor.is_empty() {
                return handle_key(
                    app,
                    KeyCode::Char('q'),
                    KeyModifiers::NONE,
                    pipe,
                    session_path,
                    client_instance_id,
                    sequence,
                    session_flow,
                    quit_requested,
                );
            }
            app.editor.delete();
            return Ok(false);
        }
        "\x1b\r" => (KeyCode::Enter, KeyModifiers::ALT),
        value if value.len() == 1 && (1..=26).contains(&value.as_bytes()[0]) => (
            KeyCode::Char((b'a' + value.as_bytes()[0] - 1) as char),
            KeyModifiers::CONTROL,
        ),
        value if value.chars().count() == 1 => {
            let character = value.chars().next().unwrap_or_default();
            if character.is_ascii_control() {
                return Ok(false);
            }
            (KeyCode::Char(character), KeyModifiers::NONE)
        }
        _ => {
            app.editor.insert(data);
            return Ok(false);
        }
    };
    handle_key(
        app,
        code,
        modifiers,
        pipe,
        session_path,
        client_instance_id,
        sequence,
        session_flow,
        quit_requested,
    )
}

#[cfg(unix)]
pub(super) fn open_custom_editor_recovery(app: &mut AppState) {
    let Some((submitted, missing)) = app.recovery_attachment_counts() else {
        return;
    };
    app.open_overlay(OverlayState::List(ListOverlay {
        title: "恢复草稿".to_owned(),
        origin: OverlayOrigin::User,
        items: vec![
            OverlayItem {
                label: "追加".to_owned(),
                detail: "在当前光标后换行追加".to_owned(),
                action: "recovery-append".to_owned(),
            },
            OverlayItem {
                label: "替换".to_owned(),
                detail: "替换当前输入内容".to_owned(),
                action: "recovery-replace-confirm".to_owned(),
            },
            OverlayItem {
                label: "复制".to_owned(),
                detail: "复制到系统剪贴板".to_owned(),
                action: "recovery-copy".to_owned(),
            },
            OverlayItem {
                label: "丢弃".to_owned(),
                detail: "清除内存中的恢复草稿".to_owned(),
                action: "recovery-discard".to_owned(),
            },
        ],
        selected: 0,
        filter: String::new(),
        status: format!("提交时 {submitted} 张，当前缺 {missing} 张。Esc 返回，Enter 选择"),
    }));
}

#[cfg(unix)]
pub(super) fn attachment_path(text: &str) -> Option<String> {
    let path = text.strip_prefix("/attach ")?.trim();
    if path.is_empty() {
        return None;
    }
    Some(
        path.strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .unwrap_or(path)
            .to_owned(),
    )
}

#[cfg(unix)]
pub(super) fn path_command_argument(text: &str, command: &str) -> Option<String> {
    let args = text.strip_prefix(command)?.strip_prefix(' ')?.trim_start();
    if args.is_empty() {
        return None;
    }
    let first = args.chars().next()?;
    if matches!(first, '"' | '\'') {
        let rest = &args[first.len_utf8()..];
        let closing = rest.find(first)?;
        return Some(rest[..closing].to_owned());
    }
    args.split_whitespace().next().map(str::to_owned)
}

#[cfg(unix)]
pub(super) struct SubmitEditorOptions {
    follow_up: bool,
    custom_editor: bool,
}

#[cfg(unix)]
pub(super) fn submit_editor(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    follow_up: bool,
    session_flow: &mut Option<SessionFlow>,
) -> Result<(), TuiError> {
    submit_editor_with_origin(
        app,
        pipe,
        session_path,
        client_instance_id,
        sequence,
        SubmitEditorOptions {
            follow_up,
            custom_editor: false,
        },
        session_flow,
    )
}

#[cfg(unix)]
pub(super) fn submit_custom_editor(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    follow_up: bool,
    session_flow: &mut Option<SessionFlow>,
) -> Result<(), TuiError> {
    submit_editor_with_origin(
        app,
        pipe,
        session_path,
        client_instance_id,
        sequence,
        SubmitEditorOptions {
            follow_up,
            custom_editor: true,
        },
        session_flow,
    )
}

#[cfg(unix)]
pub(super) fn submit_editor_with_origin(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    options: SubmitEditorOptions,
    session_flow: &mut Option<SessionFlow>,
) -> Result<(), TuiError> {
    let Some(lease_id) = app.lease_id.clone() else {
        app.transcript.status = "正在获取会话租约".to_owned();
        return Ok(());
    };
    if matches!(session_flow.as_ref(), Some(SessionFlow::Reload { .. })) {
        app.set_overlay_error("资源重新加载正在进行");
        return Ok(());
    }
    if matches!(session_flow.as_ref(), Some(SessionFlow::Fork { .. })) {
        app.set_overlay_error("会话分叉正在进行");
        return Ok(());
    }
    if app.pending_bash_submit.is_some() {
        app.set_overlay_error("Shell 请求正在提交，请稍候");
        return Ok(());
    }
    if app.editor.text().starts_with('!') {
        return submit_bash(
            app,
            pipe,
            session_path,
            client_instance_id,
            sequence,
            session_flow,
        );
    }
    let Some(text) = app.editor.submit() else {
        return Ok(());
    };
    if let Some(path) = attachment_path(&text) {
        let cwd = app.active_session_cwd().unwrap_or_default().to_owned();
        return request_workspace(
            app,
            pipe,
            sequence,
            WorkspaceCommand::ReadProjectImage,
            serde_json::json!({ "cwd": cwd, "path": path })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            PendingIntent::ProjectImage {
                source: path.to_owned(),
            },
        );
    }
    if text.trim() == "/attachments" {
        app.open_overlay(attach_overlay(app));
        return Ok(());
    }
    let trimmed = text.trim();
    if app.operation.as_ref().is_some_and(|operation| {
        operation.operation_type == "share_session"
            && matches!(
                operation.status.as_str(),
                "accepted" | "running" | "waiting_for_input" | "aborting"
            )
    }) {
        app.set_overlay_error("正在分享会话，按 Ctrl+C 可取消");
        return Ok(());
    }
    if trimmed == "/compact" || trimmed.starts_with("/compact ") {
        let custom_instructions = trimmed
            .strip_prefix("/compact")
            .map(str::trim)
            .filter(|value| !value.is_empty());
        return request_compaction(
            app,
            pipe,
            session_path,
            client_instance_id,
            sequence,
            custom_instructions,
        );
    }
    if trimmed == "/export" || trimmed.starts_with("/export ") {
        let output_path = path_command_argument(trimmed, "/export");
        return request_export_session(
            app,
            pipe,
            session_path,
            client_instance_id,
            sequence,
            output_path.as_deref(),
        );
    }
    if trimmed == "/share" {
        return request_share_session(app, pipe, session_path, client_instance_id, sequence);
    }
    if trimmed == "/copy" {
        return request_copy_last_assistant_message(
            app,
            pipe,
            session_path,
            client_instance_id,
            sequence,
        );
    }
    if trimmed == "/name" || trimmed.starts_with("/name ") {
        return request_session_name(
            app,
            pipe,
            session_path,
            client_instance_id,
            sequence,
            session_flow,
            trimmed.strip_prefix("/name").unwrap_or_default(),
        );
    }
    if trimmed == "/import" || trimmed.starts_with("/import ") {
        let Some(input_path) = path_command_argument(trimmed, "/import") else {
            app.set_overlay_error("用法：/import <path.jsonl>");
            return Ok(());
        };
        if app.is_active_operation() || session_flow.is_some() {
            app.set_overlay_error("当前会话正在运行，不能导入");
            return Ok(());
        }
        if app.lease_id.is_none() {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(());
        }
        app.pending_session_import = Some(PendingSessionImport {
            input_path: input_path.clone(),
            cwd_override: None,
        });
        app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
            title: "导入会话".to_owned(),
            message: format!("用 {input_path} 替换当前会话？"),
            confirm_action: "session-import-confirm".to_owned(),
            status: String::new(),
        }));
        return Ok(());
    }
    if let Some(filter) = model_command_filter(&text) {
        return open_model_selector(app, pipe, sequence, session_flow, filter);
    }
    if let Some((mode, filter)) = auth_command(&text) {
        return open_auth_selector(app, pipe, sequence, session_flow, mode, filter);
    }
    if let Some(command) = builtin_slash_command(&text) {
        open_workbench(
            app,
            command,
            pipe,
            session_path,
            client_instance_id,
            sequence,
            session_flow,
        )?;
        return Ok(());
    }
    *sequence += 1;
    let request_id = format!("composer-{sequence}");
    let command = if options.follow_up {
        "follow_up"
    } else if app.is_active_operation() {
        "steer"
    } else {
        "prompt"
    };
    let attachments = app.attachments.clone();
    let images = attachments
        .iter()
        .map(|attachment| serde_json::json!({ "data": attachment.base64, "mimeType": attachment.mime_type }))
        .collect::<Vec<_>>();
    let response_id = format!("command-{sequence}");
    if options.custom_editor {
        app.begin_custom_editor_submit(
            response_id.clone(),
            crate::app::PendingCustomEditorSubmit {
                command: command.to_owned(),
                session_path: session_path.to_owned(),
                session_generation: app.session_generation,
                editor_component_generation: app
                    .active_extension_editor()
                    .map(|editor| editor.generation),
                lease_id: lease_id.clone(),
                client_instance_id: client_instance_id.to_owned(),
                client_request_id: request_id.clone(),
                text: text.clone(),
                submit_revision: app.extension_editor_revision(),
                attachments: attachments.clone(),
                started_at: Instant::now(),
                retry_count: 0,
            },
        );
    } else if !attachments.is_empty() {
        app.begin_attachment_submit(
            response_id.clone(),
            crate::app::PendingAttachmentSubmit {
                command: command.to_owned(),
                session_path: session_path.to_owned(),
                lease_id: lease_id.clone(),
                client_instance_id: client_instance_id.to_owned(),
                client_request_id: request_id.clone(),
                text: text.clone(),
                attachments,
                started_at: Instant::now(),
            },
        );
    }
    pipe.request(&encode_queue_request(
        &response_id,
        command,
        session_path,
        &lease_id,
        client_instance_id,
        &request_id,
        Some(&text),
        Some(&images),
    )?)?;
    app.transcript.status = if command == "prompt" {
        "已提交"
    } else if command == "steer" {
        "已加入引导队列"
    } else {
        "已加入后续队列"
    }
    .to_owned();
    trace(command);
    Ok(())
}

pub(super) fn component_line(value: &str) -> String {
    // Parser 丢弃未知控制序列；保留原 SGR/OSC8 只供 Ratatui 的同一 parser 重新投影。
    let _ = crate::rich_text::parse_ansi_lines(&[value.to_owned()]);
    value.chars().take(524_288).collect()
}

pub(super) fn component_dimension_value(value: Option<&serde_json::Value>) -> Option<String> {
    match value? {
        serde_json::Value::Number(number) => Some(number.to_string()),
        serde_json::Value::String(value) => Some(value.clone()),
        _ => None,
    }
}

pub(super) fn component_overlay_options(
    value: Option<&serde_json::Value>,
) -> ExtensionComponentOverlayOptions {
    let Some(object) = value.and_then(serde_json::Value::as_object) else {
        return ExtensionComponentOverlayOptions::default();
    };
    ExtensionComponentOverlayOptions {
        width: component_dimension_value(object.get("width")),
        max_height: component_dimension_value(object.get("maxHeight")),
        anchor: object
            .get("anchor")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        row: component_dimension_value(object.get("row")),
        column: component_dimension_value(object.get("col")),
        overlay: object
            .get("overlay")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
    }
}

#[allow(clippy::type_complexity)]
pub(super) fn parse_component_frame(
    component_id: &str,
    value: &serde_json::Value,
) -> Result<
    (
        u64,
        Vec<String>,
        Option<(u16, u16)>,
        Vec<(u16, u16, u16)>,
        Option<(u16, u16)>,
    ),
    TuiError,
> {
    let object = value
        .as_object()
        .ok_or_else(|| TuiError::InvalidResponse("Extension component frame 无效".to_owned()))?;
    if object
        .get("componentId")
        .and_then(serde_json::Value::as_str)
        != Some(component_id)
    {
        return Err(TuiError::InvalidResponse(
            "Extension componentId 不匹配".to_owned(),
        ));
    }
    let revision = object
        .get("revision")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| TuiError::InvalidResponse("Extension component revision 无效".to_owned()))?;
    let width = object
        .get("width")
        .and_then(serde_json::Value::as_u64)
        .filter(|value| (1..=500).contains(value))
        .ok_or_else(|| TuiError::InvalidResponse("Extension component 宽度无效".to_owned()))?;
    let height = object
        .get("height")
        .and_then(serde_json::Value::as_u64)
        .filter(|value| (1..=500).contains(value))
        .ok_or_else(|| TuiError::InvalidResponse("Extension component 高度无效".to_owned()))?;
    let lines = object
        .get("lines")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| TuiError::InvalidResponse("Extension component 行无效".to_owned()))?
        .iter()
        .take(usize::try_from(height).unwrap_or(500))
        .map(|line| {
            line.as_str().map(component_line).ok_or_else(|| {
                TuiError::InvalidResponse("Extension component 行文本无效".to_owned())
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let cursor = object
        .get("cursor")
        .and_then(serde_json::Value::as_object)
        .and_then(|cursor| {
            Some((
                u16::try_from(cursor.get("row")?.as_u64()?).ok()?,
                u16::try_from(cursor.get("column")?.as_u64()?).ok()?,
            ))
        });
    let hit_regions = object
        .get("hitRegions")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| TuiError::InvalidResponse("Extension component 命中区无效".to_owned()))?
        .iter()
        .take(500)
        .filter_map(|region| {
            let region = region.as_object()?;
            let row = u16::try_from(region.get("row")?.as_u64()?).ok()?;
            let column = u16::try_from(region.get("column")?.as_u64()?).ok()?;
            let region_width = u16::try_from(region.get("width")?.as_u64()?).ok()?;
            (row < height as u16 && column < width as u16 && region_width > 0).then_some((
                row,
                column,
                region_width.min(width as u16 - column),
            ))
        })
        .collect();
    let desired_size = object
        .get("desiredSize")
        .and_then(serde_json::Value::as_object)
        .map(|size| {
            let desired_width = size
                .get("width")
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
                .unwrap_or(width as u16);
            let desired_height = size
                .get("height")
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
                .unwrap_or(height as u16);
            (desired_width.clamp(1, 500), desired_height.clamp(1, 500))
        });
    Ok((revision, lines, cursor, hit_regions, desired_size))
}

pub(super) fn extension_component_state(
    component_id: &str,
    generation: u64,
    placement: &str,
    visible: bool,
    overlay_options: ExtensionComponentOverlayOptions,
    frame: &serde_json::Value,
) -> Result<ExtensionComponentState, TuiError> {
    let (revision, lines, cursor, hit_regions, desired_size) =
        parse_component_frame(component_id, frame)?;
    Ok(ExtensionComponentState {
        component_id: component_id.to_owned(),
        generation,
        revision,
        placement: placement.to_owned(),
        visible,
        lines,
        cursor,
        hit_regions,
        desired_size,
        overlay_options,
    })
}

pub(super) fn extension_statuses(
    value: &serde_json::Value,
) -> Result<std::collections::BTreeMap<String, String>, TuiError> {
    value
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("Extension UI 缺少状态".to_owned()))?
        .iter()
        .map(|item| {
            Ok((
                item.get("key")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| TuiError::InvalidResponse("Extension 状态键无效".to_owned()))?
                    .to_owned(),
                item.get("text")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| TuiError::InvalidResponse("Extension 状态文本无效".to_owned()))?
                    .to_owned(),
            ))
        })
        .collect()
}

pub(super) fn extension_widgets(
    value: &serde_json::Value,
) -> Result<Vec<ExtensionWidget>, TuiError> {
    value
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("Extension UI 缺少小部件".to_owned()))?
        .iter()
        .map(|item| {
            Ok(ExtensionWidget {
                key: item
                    .get("key")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| TuiError::InvalidResponse("Extension 小部件键无效".to_owned()))?
                    .to_owned(),
                placement: item
                    .get("placement")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        TuiError::InvalidResponse("Extension 小部件位置无效".to_owned())
                    })?
                    .to_owned(),
                lines: item
                    .get("lines")
                    .and_then(serde_json::Value::as_array)
                    .ok_or_else(|| {
                        TuiError::InvalidResponse("Extension 小部件内容无效".to_owned())
                    })?
                    .iter()
                    .map(|line| {
                        line.as_str().map(str::to_owned).ok_or_else(|| {
                            TuiError::InvalidResponse("Extension 小部件行无效".to_owned())
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            })
        })
        .collect()
}

pub(super) fn extension_state(value: &serde_json::Value) -> Result<ExtensionUiState, TuiError> {
    let object = value
        .as_object()
        .ok_or_else(|| TuiError::InvalidResponse("Extension UI 状态无效".to_owned()))?;
    let statuses = extension_statuses(
        object
            .get("statuses")
            .ok_or_else(|| TuiError::InvalidResponse("Extension UI 缺少状态".to_owned()))?,
    )?;
    let widgets = extension_widgets(
        object
            .get("widgets")
            .ok_or_else(|| TuiError::InvalidResponse("Extension UI 缺少小部件".to_owned()))?,
    )?;
    let indicator = object
        .get("workingIndicator")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| TuiError::InvalidResponse("Extension UI 缺少指示器".to_owned()))?;
    Ok(ExtensionUiState {
        revision: object
            .get("revision")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        statuses,
        widgets,
        working_message: object
            .get("workingMessage")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        working_visible: object
            .get("workingVisible")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
        working_frames: indicator
            .get("frames")
            .and_then(serde_json::Value::as_array)
            .map(|frames| {
                frames
                    .iter()
                    .filter_map(|frame| frame.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
        working_interval_ms: indicator
            .get("intervalMs")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(120)
            .max(16),
        hidden_thinking_label: object
            .get("hiddenThinkingLabel")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        title: object
            .get("title")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        terminal_input_listener_count: object
            .get("terminalInputListenerCount")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        extension_shortcut_count: object
            .get("extensionShortcutCount")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        components: std::collections::BTreeMap::new(),
    })
}

pub(super) fn apply_extension_delta(
    app: &mut AppState,
    value: &serde_json::Value,
) -> Result<(), TuiError> {
    let object = value
        .as_object()
        .ok_or_else(|| TuiError::InvalidResponse("Extension UI 增量无效".to_owned()))?;
    let revision = object
        .get("revision")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if revision < app.extension_ui.revision {
        return Ok(());
    }
    let mut state = app.extension_ui.clone();
    state.revision = revision;
    if let Some(statuses) = object.get("statuses") {
        state.statuses = extension_statuses(statuses)?;
    }
    if let Some(widgets) = object.get("widgets") {
        state.widgets = extension_widgets(widgets)?;
    }
    if let Some(message) = object.get("workingMessage") {
        state.working_message = message.as_str().map(str::to_owned);
    }
    if let Some(visible) = object
        .get("workingVisible")
        .and_then(serde_json::Value::as_bool)
    {
        state.working_visible = visible;
    }
    if let Some(indicator) = object.get("workingIndicator") {
        let parsed = extension_state(&serde_json::json!({
            "revision": revision, "statuses": [], "widgets": [], "workingMessage": state.working_message,
            "workingVisible": state.working_visible, "workingIndicator": indicator,
            "hiddenThinkingLabel": state.hidden_thinking_label, "title": state.title,
            "terminalInputListenerCount": state.terminal_input_listener_count,
            "extensionShortcutCount": state.extension_shortcut_count,
        }))?;
        state.working_frames = parsed.working_frames;
        state.working_interval_ms = parsed.working_interval_ms;
    }
    if let Some(label) = object.get("hiddenThinkingLabel") {
        state.hidden_thinking_label = label.as_str().map(str::to_owned);
    }
    if let Some(title) = object.get("title") {
        state.title = title.as_str().map(str::to_owned);
    }
    if let Some(count) = object
        .get("terminalInputListenerCount")
        .and_then(serde_json::Value::as_u64)
    {
        state.terminal_input_listener_count = count;
    }
    if let Some(count) = object
        .get("extensionShortcutCount")
        .and_then(serde_json::Value::as_u64)
    {
        state.extension_shortcut_count = count;
    }
    app.apply_extension_ui_snapshot(state);
    Ok(())
}

pub(super) fn extension_title_osc(title: Option<&str>) -> String {
    let sanitized = title.map(sanitize_terminal_text).unwrap_or_default();
    format!("\x1b]0;{sanitized}\x07")
}

pub(super) fn write_extension_title(title: Option<&str>) {
    let _ = io::stdout().write_all(extension_title_osc(title).as_bytes());
    let _ = io::stdout().flush();
}

#[allow(clippy::too_many_arguments)]
pub(super) fn queue_operation_id(raw: &serde_json::Value) -> Option<&str> {
    raw.get("result")
        .and_then(|result| {
            result.get("operationId").or_else(|| {
                result
                    .get("operation")
                    .and_then(|operation| operation.get("operationId"))
            })
        })
        .and_then(serde_json::Value::as_str)
}
