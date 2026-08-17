use super::*;

pub(super) fn start_new_session(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
) -> Result<(), TuiError> {
    if app.is_active_operation() || session_flow.is_some() {
        app.set_overlay_error("当前会话正在运行，不能新建");
        return Ok(());
    }
    let Some(cwd) = app.active_session_cwd().filter(|cwd| !cwd.is_empty()) else {
        app.set_overlay_error("尚未获取项目目录");
        return Ok(());
    };
    *sequence += 1;
    let id = format!("session-create-{sequence}");
    *session_flow = Some(SessionFlow::CreateStarting {
        id: id.clone(),
        restore: app.restore_point(),
    });
    pipe.request(&encode_create_session_request(
        &id,
        cwd,
        client_instance_id,
        &format!("create:{sequence}"),
    )?)
}

pub(super) fn release_active_session(
    app: &AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
) -> Result<(), TuiError> {
    let Some(context) = &app.active_session else {
        return Ok(());
    };
    let Some(lease_id) = context.lease_id.as_deref() else {
        return Ok(());
    };
    *sequence += 1;
    pipe.request(&encode_release_session_request(
        &format!("release-on-exit-{sequence}"),
        &context.path,
        lease_id,
    )?)
}

#[cfg(unix)]
pub(super) fn request_acquire(
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
) -> Result<String, TuiError> {
    *sequence += 1;
    let id = format!("acquire-{sequence}");
    pipe.request(&encode_acquire_session_request(
        &id,
        session_path,
        client_instance_id,
    )?)?;
    Ok(id)
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
pub(super) fn request_transcript(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    cursor: Option<String>,
    replace: bool,
    context: Option<TranscriptRequestContext>,
    view: TranscriptViewKind,
    sequence: &mut u64,
) -> Result<(), TuiError> {
    *sequence += 1;
    trace("read_transcript");
    let id = format!("{}-{sequence}", if replace { "initial" } else { "older" });
    app.begin_transcript_request(
        id.clone(),
        view,
        if replace {
            TranscriptRequestKind::Initial
        } else {
            TranscriptRequestKind::Older
        },
        session_path.to_owned(),
        match view {
            TranscriptViewKind::Active => app.session_generation,
            TranscriptViewKind::Readonly => app
                .readonly_view
                .as_ref()
                .map_or(0, |readonly| readonly.generation),
        },
        context.clone(),
    );
    pipe.request(&encode_read_transcript_request(
        &id,
        session_path,
        if replace {
            INITIAL_PAGE_LIMIT
        } else {
            PAGE_LIMIT
        },
        cursor.as_deref(),
        context.as_ref(),
    )?)
}

#[cfg(unix)]
pub(super) fn request_search(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    query: &str,
    view: TranscriptViewKind,
    sequence: &mut u64,
) -> Result<(), TuiError> {
    *sequence += 1;
    trace("search_transcript");
    let id = format!("search-{sequence}");
    app.begin_transcript_request(
        id.clone(),
        view,
        TranscriptRequestKind::Search,
        session_path.to_owned(),
        match view {
            TranscriptViewKind::Active => app.session_generation,
            TranscriptViewKind::Readonly => app
                .readonly_view
                .as_ref()
                .map_or(0, |readonly| readonly.generation),
        },
        None,
    );
    pipe.request(&encode_search_transcript_request(
        &id,
        session_path,
        query,
        SEARCH_LIMIT,
    )?)
}

pub(super) fn request_extension_editor_state(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
) -> Result<(), TuiError> {
    let Some(lease_id) = app.lease_id.clone() else {
        return Ok(());
    };
    let Some((text, cursor, revision)) = app.take_editor_state_update() else {
        return Ok(());
    };
    *sequence += 1;
    pipe.request(&encode_extension_editor_state_request(
        &format!("extension-editor-{sequence}"),
        session_path,
        &lease_id,
        client_instance_id,
        &text,
        cursor,
        revision,
        Some(app.extension_ui.revision),
    )?)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn request_extension_component_input(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    component_id: &str,
    generation: u64,
    data: String,
) -> Result<bool, TuiError> {
    let Some(lease_id) = app.lease_id.as_deref() else {
        return Ok(false);
    };
    if data.is_empty()
        || data.len() > MAX_EXTENSION_INPUT_BYTES
        || app.has_pending_component_input(component_id, generation, &data)
    {
        return Ok(false);
    }
    *sequence += 1;
    let id = format!("component-input-{sequence}");
    app.pending_component_inputs.insert(
        id.clone(),
        crate::app::PendingComponentInput {
            component_id: component_id.to_owned(),
            generation,
            data: data.clone(),
            started_at: Instant::now(),
        },
    );
    trace_id("component_input_requested", &id);
    pipe.request(&encode_extension_component_input_request(
        &id,
        session_path,
        lease_id,
        client_instance_id,
        component_id,
        generation,
        &data,
    )?)?;
    Ok(true)
}

pub(super) fn request_extension_component_resize(
    app: &AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    width: u16,
    height: u16,
) -> Result<(), TuiError> {
    let Some(lease_id) = app.lease_id.as_deref() else {
        return Ok(());
    };
    *sequence += 1;
    pipe.request(&encode_extension_component_resize_request(
        &format!("component-resize-{sequence}"),
        session_path,
        lease_id,
        client_instance_id,
        width.clamp(1, 500),
        height.clamp(1, 500),
    )?)
}

pub(super) fn request_extension_component_cancel(
    app: &AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    component_id: &str,
    generation: u64,
) -> Result<(), TuiError> {
    let Some(lease_id) = app.lease_id.as_deref() else {
        return Ok(());
    };
    *sequence += 1;
    pipe.request(&encode_extension_component_cancel_request(
        &format!("component-cancel-{sequence}"),
        session_path,
        lease_id,
        client_instance_id,
        component_id,
        generation,
    )?)
}

pub(super) fn request_extension_terminal_input(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    data: String,
) -> Result<(), TuiError> {
    let Some(lease_id) = app.lease_id.as_deref() else {
        return Ok(());
    };
    if data.is_empty() || data.len() > MAX_EXTENSION_INPUT_BYTES {
        return Ok(());
    }
    *sequence += 1;
    let id = format!("extension-input-{sequence}");
    trace_id("extension_input_requested", &id);
    app.pending_terminal_inputs.insert(
        id.clone(),
        PendingTerminalInput {
            data: data.clone(),
            started_at: Instant::now(),
        },
    );
    pipe.request(&encode_extension_terminal_input_request(
        &id,
        session_path,
        lease_id,
        client_instance_id,
        &data,
    )?)
}

pub(super) fn request_workspace(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
    command: WorkspaceCommand,
    payload: serde_json::Map<String, serde_json::Value>,
    intent: PendingIntent,
) -> Result<(), TuiError> {
    *sequence += 1;
    let id = format!("{}:{sequence}", command.wire());
    let request = WorkspaceRequest { command, payload };
    app.begin_request(id.clone(), request.clone(), intent);
    pipe.request(&encode_workspace_request(
        &id,
        request.command,
        request.payload,
    )?)
}

#[cfg(unix)]
pub(super) fn visible_cached_images(app: &AppState) -> Vec<CachedImage> {
    let mut visible = app
        .attachment_preview
        .as_deref()
        .and_then(|hash| app.attachment_by_hash(hash))
        .map(|attachment| CachedImage {
            content_ref: format!("attachment:{}", attachment.id),
            mime_type: attachment.mime_type.clone(),
            byte_length: attachment.byte_length,
            base64: attachment.base64.clone(),
        })
        .into_iter()
        .collect::<Vec<_>>();
    if !visible.is_empty() {
        return visible;
    }
    visible.extend(
        app.transcript
            .rounds()
            .iter()
            .skip(app.transcript.scroll)
            .take(8)
            .flat_map(|round| round.items.iter())
            .flat_map(transcript_images)
            .filter_map(|image| app.image_cache.get(&image.content_ref).cloned()),
    );
    visible
}

#[cfg(unix)]
pub(super) fn request_visible_images(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    sequence: &mut u64,
) -> Result<bool, TuiError> {
    let pending = app
        .pending_image_requests
        .values()
        .map(|request| request.content_ref.clone())
        .collect::<Vec<_>>();
    let candidates = app
        .transcript
        .rounds()
        .iter()
        .skip(app.transcript.scroll)
        .take(8)
        .flat_map(|round| round.items.iter())
        .flat_map(transcript_images)
        .filter(|image| {
            !app.image_cache.get(&image.content_ref).is_some()
                && !pending.contains(&image.content_ref)
                && !app.failed_images.contains(&image.content_ref)
        })
        .collect::<Vec<_>>();
    let mut requested = false;
    for image in candidates {
        *sequence += 1;
        let id = format!("read-image-content-{sequence}");
        app.begin_image_request(id.clone(), image.content_ref.clone());
        pipe.request(&encode_workspace_request(
            &id,
            WorkspaceCommand::ReadImageContent,
            serde_json::json!({ "sessionPath": session_path, "contentRef": image.content_ref })
                .as_object()
                .cloned()
                .unwrap_or_default(),
        )?)?;
        requested = true;
    }
    Ok(requested)
}

#[cfg(unix)]
pub(super) fn request_visible_rich_text(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    width: u16,
    sequence: &mut u64,
) -> Result<bool, TuiError> {
    let is_streaming = app.is_active_operation();
    let pending = app
        .pending_rich_text_requests
        .values()
        .map(|request| request.key.clone())
        .collect::<Vec<_>>();
    let candidates = app
        .transcript
        .rounds()
        .iter()
        .skip(app.transcript.scroll)
        .take(8)
        .filter(|round| !round.is_tool_round())
        .filter_map(|round| {
            let item = round.items.first()?;
            let streaming =
                matches!(&item.view, TranscriptViewItem::Assistant { .. }) && is_streaming;
            let (key, message_type, text) = AppState::rich_text_key(item, width, streaming)?;
            (!app.rich_text_cache.get(&key).is_some()
                && !pending.contains(&key)
                && !app.failed_rich_text.contains(&key))
            .then(|| (key, message_type.to_owned(), text.to_owned()))
        })
        .collect::<Vec<_>>();
    let mut requested = false;
    for (key, message_type, text) in candidates {
        *sequence += 1;
        let id = format!("render-rich-text-{sequence}");
        app.begin_rich_text_request(id.clone(), key);
        pipe.request(&encode_workspace_request(
            &id,
            WorkspaceCommand::RenderRichText,
            serde_json::json!({
                "text": text,
                "width": width,
                "messageType": message_type,
                "isStreaming": is_streaming,
                "sessionPath": session_path,
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
        )?)?;
        requested = true;
    }
    Ok(requested)
}

#[cfg(unix)]
pub(super) fn request_subagents(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
    parent_session_path: String,
    selected_key: Option<String>,
    filter: String,
) -> Result<(), TuiError> {
    app.subagent_parent_path = Some(parent_session_path.clone());
    app.replace_workspace_overlay(
        format!("subagents:{parent_session_path}"),
        OverlayState::Detail(DetailOverlay {
            title: "Subagent".to_owned(),
            lines: vec!["正在读取 Subagent".to_owned()],
            scroll: 0,
            status: "请稍候".to_owned(),
            link: None,
            copy_text: None,
        }),
    );
    request_workspace(
        app,
        pipe,
        sequence,
        WorkspaceCommand::ListSubagents,
        serde_json::json!({ "sessionPath": parent_session_path })
            .as_object()
            .cloned()
            .unwrap_or_default(),
        PendingIntent::WorkbenchLoad {
            target: WorkbenchTarget::Subagents,
            selected_key,
            filter,
        },
    )
}

#[cfg(unix)]
pub(super) fn request_clipboard_read(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
    insert: bool,
) -> Result<(), TuiError> {
    request_workspace(
        app,
        pipe,
        sequence,
        WorkspaceCommand::ReadClipboardText,
        serde_json::Map::new(),
        PendingIntent::ClipboardRead { insert },
    )
}

#[cfg(unix)]
pub(super) fn request_clipboard_both(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
    target: ClipboardReadTarget,
) -> Result<(), TuiError> {
    let generation = app.begin_clipboard_read(target);
    request_workspace(
        app,
        pipe,
        sequence,
        WorkspaceCommand::ReadClipboardText,
        serde_json::Map::new(),
        PendingIntent::ClipboardBothText { generation },
    )?;
    request_workspace(
        app,
        pipe,
        sequence,
        WorkspaceCommand::ReadClipboardImage,
        serde_json::Map::new(),
        PendingIntent::ClipboardBothImage { generation },
    )
}

#[cfg(unix)]
pub(super) fn request_attach_completion(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
) -> Result<(), TuiError> {
    let text = app.editor.text().to_owned();
    let Some(cwd) = app.active_session_cwd().filter(|cwd| !cwd.is_empty()) else {
        app.set_overlay_error("尚未获取项目目录");
        return Ok(());
    };
    request_workspace(
        app,
        pipe,
        sequence,
        WorkspaceCommand::GetCompletions,
        serde_json::json!({
            "cwd": cwd,
            "sessionPath": app.active_session_path(),
            "text": text,
            "cursor": app.editor.text().encode_utf16().count(),
        })
        .as_object()
        .cloned()
        .unwrap_or_default(),
        PendingIntent::AttachCompletion { text },
    )
}

#[cfg(unix)]
pub(super) fn utf16_offset_to_byte(value: &str, offset: usize) -> Option<usize> {
    let mut units = 0;
    for (index, character) in value.char_indices() {
        if units == offset {
            return Some(index);
        }
        units = units.saturating_add(character.len_utf16());
        if units > offset {
            return None;
        }
    }
    (units == offset).then_some(value.len())
}

#[cfg(unix)]
pub(super) fn finish_clipboard_both(app: &mut AppState) {
    let Some(state) = app.clipboard_read.clone() else {
        return;
    };
    if !state.text_done || !state.image_done {
        return;
    }
    let text = state.text.and_then(|clipboard| clipboard.text);
    let image = state.image;
    match state.target {
        ClipboardReadTarget::Overlay => {
            let clipboard = ClipboardDescriptor {
                capability: true,
                text: text.clone(),
            };
            app.clipboard = Some(clipboard.clone());
            app.replace_overlay(clipboard_overlay(&clipboard, image.as_ref()));
        }
        ClipboardReadTarget::Insert => match (text, image) {
            (None, None) => app.set_toast("剪贴板没有可插入内容"),
            (Some(text), None) => {
                app.editor.insert(&text);
                app.set_toast("已插入剪贴板文本");
            }
            (None, Some(image)) => match app.add_attachment(image) {
                Ok(true) => app.set_toast("已添加剪贴板图片"),
                Ok(false) => app.set_toast("图片已在附件中"),
                Err(message) => app.set_overlay_error(message),
            },
            (Some(_), Some(_)) => {
                app.open_overlay(OverlayState::List(ListOverlay {
                    title: "选择剪贴板内容".to_owned(),
                    origin: OverlayOrigin::User,
                    items: vec![
                        OverlayItem {
                            label: "插入文本".to_owned(),
                            detail: "在当前光标位置插入文本".to_owned(),
                            action: "clipboard-select:text".to_owned(),
                        },
                        OverlayItem {
                            label: "添加图片".to_owned(),
                            detail: "添加为图片附件".to_owned(),
                            action: "clipboard-select:image".to_owned(),
                        },
                        OverlayItem {
                            label: "两者".to_owned(),
                            detail: "插入文本并添加图片".to_owned(),
                            action: "clipboard-select:both".to_owned(),
                        },
                    ],
                    selected: 0,
                    filter: String::new(),
                    status: "Enter 选择，Esc 取消".to_owned(),
                }));
            }
        },
    }
}

#[cfg(unix)]
pub(super) fn attach_overlay(app: &AppState) -> OverlayState {
    OverlayState::List(ListOverlay {
        title: "图片附件".to_owned(),
        origin: OverlayOrigin::User,
        items: app
            .attachments
            .iter()
            .enumerate()
            .map(|(index, attachment)| OverlayItem {
                label: attachment.name.clone(),
                detail: format!(
                    "{}  {}  {} B  #{}",
                    attachment.source,
                    attachment.mime_type,
                    attachment.byte_length,
                    &attachment.content_hash[..attachment.content_hash.len().min(12)]
                ),
                action: format!("attachment:{index}"),
            })
            .collect(),
        selected: 0,
        filter: String::new(),
        status: "Enter 预览  d 删除  D 清空  Esc 返回".to_owned(),
    })
}

#[cfg(unix)]
pub(super) fn request_clipboard_write(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    client_instance_id: &str,
    sequence: &mut u64,
    text: String,
    toast: &str,
) -> Result<(), TuiError> {
    if text.is_empty() {
        app.set_overlay_error("没有可写入剪贴板的文本");
        return Ok(());
    }
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
            toast: toast.to_owned(),
        },
    )
}

#[cfg(unix)]
pub(super) fn list_context(app: &AppState, title: &str) -> (String, Option<String>) {
    app.overlays
        .iter()
        .rev()
        .find_map(|overlay| match overlay {
            OverlayState::List(list) if list.title == title => (
                list.filter.clone(),
                list.items
                    .get(list.selected)
                    .map(|item| item.action.clone()),
            )
                .into(),
            _ => None,
        })
        .unwrap_or_default()
}

#[cfg(unix)]
pub(super) fn request_workspace_load(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
    target: WorkbenchTarget,
    selected_key: Option<String>,
    filter: String,
) -> Result<(), TuiError> {
    let cwd = app
        .active_session_cwd()
        .filter(|cwd| !cwd.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| TuiError::InvalidResponse("尚未获取项目目录".to_owned()))?;
    let (command, payload, title, key) = match target {
        WorkbenchTarget::Changes => (
            WorkspaceCommand::GetGitStatus,
            serde_json::json!({ "cwd": cwd })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            "变更",
            "changes",
        ),
        WorkbenchTarget::Skills => (
            WorkspaceCommand::ListSkills,
            serde_json::json!({ "cwd": cwd })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            "技能",
            "skills",
        ),
        WorkbenchTarget::Trust => (
            WorkspaceCommand::GetProjectTrust,
            serde_json::json!({ "cwd": cwd })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            "项目信任",
            "trust",
        ),
        WorkbenchTarget::InstructionsProject => (
            WorkspaceCommand::ListProjectInstructions,
            serde_json::json!({ "cwd": cwd })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            "指令 [项目]",
            "instructions:project",
        ),
        WorkbenchTarget::InstructionsHost => (
            WorkspaceCommand::ListHostInstructions,
            serde_json::Map::new(),
            "指令 [本机]",
            "instructions:host",
        ),
        WorkbenchTarget::Packages => (
            WorkspaceCommand::ListPackages,
            serde_json::json!({ "cwd": cwd })
                .as_object()
                .cloned()
                .unwrap_or_default(),
            "包",
            "packages",
        ),
        WorkbenchTarget::Update => (
            WorkspaceCommand::CheckForUpdates,
            serde_json::Map::new(),
            "更新检查",
            "update",
        ),
        _ => return Ok(()),
    };
    app.replace_workspace_overlay(
        key,
        OverlayState::Detail(DetailOverlay {
            title: title.to_owned(),
            lines: vec!["正在读取".to_owned()],
            scroll: 0,
            status: "请稍候".to_owned(),
            link: None,
            copy_text: None,
        }),
    );
    request_workspace(
        app,
        pipe,
        sequence,
        command,
        payload,
        PendingIntent::WorkbenchLoad {
            target,
            selected_key,
            filter,
        },
    )
}

pub(super) fn request_settings(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    sequence: &mut u64,
    selected_key: Option<String>,
    filter: String,
) -> Result<(), TuiError> {
    request_workspace(
        app,
        pipe,
        sequence,
        WorkspaceCommand::ListSettings,
        serde_json::json!({ "sessionPath": session_path })
            .as_object()
            .cloned()
            .unwrap_or_default(),
        PendingIntent::WorkbenchLoad {
            target: WorkbenchTarget::Settings,
            selected_key,
            filter,
        },
    )
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
pub(super) fn request_setting_write(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    id: &str,
    value: serde_json::Value,
    filter: String,
) -> Result<(), TuiError> {
    let Some(lease_id) = app.lease_id.clone() else {
        app.set_overlay_error("尚未获取会话租约");
        return Ok(());
    };
    let client_request_id = format!("setting:{id}:{}", sequence.saturating_add(1));
    app.mark_write_pending();
    request_workspace(
        app,
        pipe,
        sequence,
        WorkspaceCommand::SetSetting,
        serde_json::json!({
            "sessionPath": session_path,
            "leaseId": lease_id,
            "clientInstanceId": client_instance_id,
            "clientRequestId": client_request_id,
            "id": id,
            "value": value,
        })
        .as_object()
        .cloned()
        .unwrap_or_default(),
        PendingIntent::SettingMutation {
            selected_key: id.to_owned(),
            filter,
        },
    )
}
