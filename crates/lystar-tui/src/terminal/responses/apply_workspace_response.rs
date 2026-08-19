use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) fn apply_workspace_response(
    app: &mut AppState,
    message: &ServerMessage,
    raw: &serde_json::Value,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &Option<SessionFlow>,
) -> Result<Option<bool>, TuiError> {
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("response")
        && let Some(id) = raw.get("id").and_then(serde_json::Value::as_str)
        && let Some(pending) = app.take_pending(id)
    {
        if !app.pending_workspace_is_current(&pending) {
            return Ok(Some(false));
        }
        if raw.get("ok").and_then(serde_json::Value::as_bool) == Some(false) {
            restore_auth_intent(app, &pending.intent);
            if matches!(&pending.intent, PendingIntent::TreeNavigate { .. }) {
                app.pending_editor_replace = None;
            }
            if let PendingIntent::InstructionMutation { target, .. } = &pending.intent
                && raw
                    .get("error")
                    .and_then(|value| value.get("code"))
                    .and_then(serde_json::Value::as_str)
                    == Some("instruction_conflict")
            {
                let scope = if *target == WorkbenchTarget::InstructionsProject {
                    "project"
                } else {
                    "host"
                };
                app.open_overlay(OverlayState::List(ListOverlay {
                    title: "指令冲突".to_owned(),
                    origin: OverlayOrigin::User,
                    items: vec![
                        OverlayItem {
                            label: "重新加载".to_owned(),
                            detail: "读取外部修改后的内容，不覆盖现有文件".to_owned(),
                            action: format!("instruction-conflict-reload:{scope}"),
                        },
                        OverlayItem {
                            label: "放弃保存".to_owned(),
                            detail: "保留磁盘上的外部版本".to_owned(),
                            action: "instruction-conflict-discard".to_owned(),
                        },
                    ],
                    selected: 0,
                    filter: String::new(),
                    status: "Enter 选择，Esc 返回".to_owned(),
                }));
            }
            let message = raw
                .get("error")
                .and_then(|value| value.get("message"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("工作台请求失败");
            if matches!(&pending.intent, PendingIntent::Export) {
                app.set_overlay_error(format!("导出会话失败：{message}"));
            } else {
                app.set_overlay_error(message);
            }
            return Ok(Some(false));
        }
        let result = message
            .validated_workspace_result_value(pending.request.command)
            .map_err(|error| {
                restore_auth_intent(app, &pending.intent);
                TuiError::from(error)
            })?;
        match pending.intent {
            PendingIntent::Overlay { target } => apply_workbench_result(app, target, result),
            PendingIntent::Changelog => {
                let lines = result
                    .get("lines")
                    .and_then(serde_json::Value::as_array)
                    .ok_or_else(|| TuiError::InvalidResponse("更新内容缺少渲染行".to_owned()))?
                    .iter()
                    .map(|line| {
                        line.as_str().map(str::to_owned).ok_or_else(|| {
                            TuiError::InvalidResponse("更新内容包含无效渲染行".to_owned())
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                app.replace_overlay(OverlayState::Detail(DetailOverlay {
                    title: "更新内容".to_owned(),
                    lines,
                    scroll: 0,
                    status: "Esc 返回".to_owned(),
                    link: None,
                    copy_text: None,
                }));
            }
            PendingIntent::SessionInfo => apply_session_info(app, result)?,
            PendingIntent::ForkMessages => apply_fork_messages(app, result)?,
            PendingIntent::ChangeDetail => {
                app.change_detail = Some(parse_git_diff(&result)?);
                app.change_detail_expanded = false;
                app.replace_overlay(change_detail_overlay(app));
            }
            PendingIntent::SkillMutation {
                path,
                scope,
                enabled,
                selected_key,
                filter,
            } => {
                if result.get("path").and_then(serde_json::Value::as_str) != Some(path.as_str())
                    || result.get("scope").and_then(serde_json::Value::as_str)
                        != Some(scope.as_str())
                    || result.get("enabled").and_then(serde_json::Value::as_bool) != Some(enabled)
                {
                    return Err(TuiError::InvalidResponse("技能响应与请求不一致".to_owned()));
                }
                let skills = parse_skills(&result)?;
                app.skills = skills;
                app.close_overlay();
                app.replace_overlay(skills_overlay(&app.skills, Some(&selected_key), filter));
                app.set_toast("技能启用状态已更新");
            }
            PendingIntent::TrustMutation { cwd, trusted } => {
                let trust = parse_trust(&result)?;
                if trust.cwd != cwd || trust.trusted != Some(trusted) {
                    return Err(TuiError::InvalidResponse(
                        "项目信任响应与请求不一致".to_owned(),
                    ));
                }
                app.trust = Some(trust);
                app.close_overlay();
                app.replace_overlay(trust_overlay(app));
                app.set_toast("项目信任已更新");
            }
            PendingIntent::InstructionMutation {
                target,
                file_name,
                content,
                selected_key,
                filter,
            } => {
                let instructions = parse_instructions(&result)?;
                if !instructions.iter().any(|instruction| {
                    instruction.file_name == file_name
                        && instruction.content.as_deref() == Some(content.as_str())
                }) {
                    return Err(TuiError::InvalidResponse(
                        "指令响应未包含保存内容".to_owned(),
                    ));
                }
                if target == WorkbenchTarget::InstructionsProject {
                    app.project_instructions = instructions;
                    app.close_overlay();
                    app.replace_overlay(instructions_overlay(
                        &app.project_instructions,
                        "项目",
                        Some(&selected_key),
                        filter,
                    ));
                } else {
                    app.host_instructions = instructions;
                    app.close_overlay();
                    app.replace_overlay(instructions_overlay(
                        &app.host_instructions,
                        "本机",
                        Some(&selected_key),
                        filter,
                    ));
                }
                app.set_toast("指令已保存");
            }
            PendingIntent::PackageMutation {
                source,
                scope,
                expected_present,
                close_overlay,
                selected_key,
                filter,
                toast,
            } => {
                if result.get("source").and_then(serde_json::Value::as_str) != source.as_deref()
                    || result.get("scope").and_then(serde_json::Value::as_str) != scope.as_deref()
                {
                    return Err(TuiError::InvalidResponse("包响应与请求不一致".to_owned()));
                }
                let packages =
                    parse_packages(result.get("packages").ok_or_else(|| {
                        TuiError::InvalidResponse("包响应缺少 packages".to_owned())
                    })?)?;
                if let (Some(source), Some(scope), Some(expected_present)) =
                    (&source, &scope, expected_present)
                    && packages
                        .iter()
                        .any(|package| package.source == *source && package.scope == *scope)
                        != expected_present
                {
                    return Err(TuiError::InvalidResponse("包响应未包含目标状态".to_owned()));
                }
                app.packages = packages;
                let message = result
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(&toast)
                    .to_owned();
                app.set_toast(message);
                app.pending_package_source = None;
                if close_overlay {
                    app.close_overlay();
                }
                app.replace_overlay(packages_overlay(
                    &app.packages,
                    selected_key.as_deref(),
                    filter,
                ));
            }
            PendingIntent::WorkbenchLoad {
                target,
                selected_key,
                filter,
            } => apply_workbench_load(app, target, selected_key, filter, result)?,
            PendingIntent::SubagentRead {
                parent_session_path,
                selected_key: _,
                filter: _,
            } => {
                let object = result
                    .as_object()
                    .ok_or_else(|| TuiError::InvalidResponse("Subagent 详情响应无效".to_owned()))?;
                let committed = object
                    .get("transcript")
                    .map(|value| parse_subagent(value, &parent_session_path))
                    .transpose()?;
                let live = object
                    .get("live")
                    .map(|value| parse_subagent(value, &parent_session_path))
                    .transpose()?;
                let snapshot = match (committed, live) {
                    (Some(committed), Some(live)) => {
                        crate::app::merge_subagents([committed], [live])
                            .into_iter()
                            .next()
                    }
                    (Some(snapshot), None) | (None, Some(snapshot)) => Some(snapshot),
                    (None, None) => None,
                }
                .ok_or_else(|| TuiError::InvalidResponse("Subagent 不存在或已过期".to_owned()))?;
                app.subagent_detail = Some(snapshot.clone());
                app.open_overlay(subagent_detail_overlay(&snapshot));
            }
            PendingIntent::SubagentMutation {
                parent_session_path,
                selected_key,
                filter,
                toast,
            } => {
                app.set_toast(
                    result
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or(&toast),
                );
                request_subagents(
                    app,
                    pipe,
                    sequence,
                    parent_session_path,
                    Some(selected_key),
                    filter,
                )?;
            }
            PendingIntent::ClipboardRead { insert } => {
                let clipboard = parse_clipboard(&result)?;
                if !clipboard.capability {
                    app.set_overlay_error("Host 不支持文本剪贴板");
                } else if insert {
                    if let Some(text) = clipboard.text.as_deref() {
                        app.editor.insert(text);
                        app.set_toast("已插入剪贴板文本");
                    } else {
                        app.set_toast("剪贴板没有文本");
                    }
                } else {
                    app.clipboard = Some(clipboard.clone());
                    app.replace_overlay(clipboard_overlay(&clipboard, None));
                }
            }
            PendingIntent::ClipboardBothText { generation } => {
                let clipboard = parse_clipboard(&result)?;
                if let Some(state) = app.clipboard_read.as_mut()
                    && state.generation == generation
                {
                    state.text = clipboard.capability.then_some(clipboard);
                    state.text_done = true;
                }
                finish_clipboard_both(app);
            }
            PendingIntent::ClipboardBothImage { generation } => {
                let object = result
                    .as_object()
                    .ok_or_else(|| TuiError::InvalidResponse("剪贴板图片响应无效".to_owned()))?;
                let image =
                    if object
                        .get("capability")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false)
                        && object
                            .get("available")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false)
                    {
                        Some(app.new_attachment(
                            "clipboard-image".to_owned(),
                            "clipboard".to_owned(),
                            required_string(object, "mimeType")?,
                            usize::try_from(required_u64(object, "byteLength")?).map_err(|_| {
                                TuiError::InvalidResponse("图片大小无效".to_owned())
                            })?,
                            required_string(object, "contentHash")?,
                            required_string(object, "data")?,
                        ))
                    } else {
                        None
                    };
                if let Some(state) = app.clipboard_read.as_mut()
                    && state.generation == generation
                {
                    state.image = image;
                    state.image_done = true;
                }
                finish_clipboard_both(app);
            }
            PendingIntent::ComposerCompletion {
                text,
                command_panel,
            } => {
                let is_attach_completion = text.starts_with("/attach ");
                let object = result
                    .as_object()
                    .ok_or_else(|| TuiError::InvalidResponse("补全响应无效".to_owned()))?;
                let (prefix_start, prefix_end) = if command_panel {
                    // 命令面板用 "/" 作为 Host 查询文本，但替换范围属于当前草稿。
                    (0, text.len())
                } else {
                    let prefix_start = usize::try_from(required_u64(object, "prefixStart")?)
                        .ok()
                        .and_then(|offset| utf16_offset_to_byte(&text, offset))
                        .ok_or_else(|| TuiError::InvalidResponse("补全起始位置无效".to_owned()))?;
                    let prefix_end = usize::try_from(required_u64(object, "prefixEnd")?)
                        .ok()
                        .and_then(|offset| utf16_offset_to_byte(&text, offset))
                        .ok_or_else(|| TuiError::InvalidResponse("补全结束位置无效".to_owned()))?;
                    (prefix_start, prefix_end)
                };
                let items = object
                    .get("items")
                    .and_then(serde_json::Value::as_array)
                    .ok_or_else(|| TuiError::InvalidResponse("补全响应缺少候选".to_owned()))?
                    .iter()
                    .filter_map(|item| {
                        let object = item.as_object()?;
                        let kind = object.get("kind")?.as_str()?;
                        if !matches!(
                            kind,
                            "file" | "directory" | "skill" | "prompt" | "extension" | "command"
                        ) {
                            return None;
                        }
                        Some(ComposerCompletionItem {
                            value: object.get("value")?.as_str()?.to_owned(),
                            label: object.get("label")?.as_str()?.to_owned(),
                            description: object
                                .get("description")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_owned),
                            kind: kind.to_owned(),
                        })
                    })
                    .collect::<Vec<_>>();
                if items.is_empty() {
                    app.set_toast(if command_panel {
                        "没有可用的动态命令"
                    } else if is_attach_completion {
                        "没有匹配的项目图片文件"
                    } else {
                        "没有匹配的补全"
                    });
                } else if command_panel {
                    let mut panel_items = builtin_command_panel_items();
                    panel_items.extend(items.iter().enumerate().map(|(index, item)| OverlayItem {
                        label: item.label.clone(),
                        detail: format!(
                            "扩展命令  {}",
                            item.description.clone().unwrap_or_default()
                        ),
                        action: format!("composer-completion:{index}"),
                    }));
                    app.composer_completion = Some(ComposerCompletion {
                        text,
                        prefix_start,
                        prefix_end,
                        items,
                    });
                    let overlay = OverlayState::List(ListOverlay {
                        title: "命令面板".to_owned(),
                        origin: OverlayOrigin::User,
                        items: panel_items,
                        selected: 0,
                        filter: String::new(),
                        status: "输入筛选，Enter 打开；动态命令会写入输入框".to_owned(),
                    });
                    if matches!(app.overlay(), Some(OverlayState::List(list)) if list.title == "命令面板")
                    {
                        app.replace_overlay(overlay);
                    } else {
                        app.open_overlay(overlay);
                    }
                } else {
                    app.composer_completion = Some(ComposerCompletion {
                        text,
                        prefix_start,
                        prefix_end,
                        items: items.clone(),
                    });
                    app.open_overlay(OverlayState::List(ListOverlay {
                        title: if is_attach_completion {
                            "添加图片".to_owned()
                        } else {
                            "命令补全".to_owned()
                        },
                        origin: OverlayOrigin::User,
                        items: items
                            .iter()
                            .enumerate()
                            .map(|(index, item)| OverlayItem {
                                label: item.label.clone(),
                                detail: format!(
                                    "{}{}",
                                    if item.kind == "directory" {
                                        "目录  "
                                    } else if item.kind == "file" {
                                        "文件  "
                                    } else {
                                        "命令  "
                                    },
                                    item.description.clone().unwrap_or_default()
                                ),
                                action: format!("composer-completion:{index}"),
                            })
                            .collect(),
                        selected: 0,
                        filter: String::new(),
                        status: if is_attach_completion {
                            "Enter 选择，目录会继续补全，Esc 返回".to_owned()
                        } else {
                            "Enter 选择，Esc 返回".to_owned()
                        },
                    }));
                }
            }
            PendingIntent::ProjectImage { source } => {
                let object = result
                    .as_object()
                    .ok_or_else(|| TuiError::InvalidResponse("图片响应无效".to_owned()))?;
                let mime_type = required_string(object, "mimeType")?;
                let base64 = required_string(object, "base64")?;
                let byte_length = usize::try_from(required_u64(object, "byteLength")?)
                    .map_err(|_| TuiError::InvalidResponse("图片大小无效".to_owned()))?;
                let content_hash = required_string(object, "contentHash")?;
                let name = std::path::Path::new(&source)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or(&source)
                    .to_owned();
                let attachment =
                    app.new_attachment(name, source, mime_type, byte_length, content_hash, base64);
                match app.add_attachment(attachment) {
                    Ok(true) => app.set_toast("已添加图片附件"),
                    Ok(false) => app.set_toast("图片已在附件中"),
                    Err(message) => app.set_overlay_error(message),
                }
            }
            PendingIntent::ClipboardImage => {
                let object = result
                    .as_object()
                    .ok_or_else(|| TuiError::InvalidResponse("剪贴板图片响应无效".to_owned()))?;
                if !object
                    .get("available")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
                {
                    app.set_toast("剪贴板中没有图片");
                    return Ok(Some(false));
                }
                let mime_type = required_string(object, "mimeType")?;
                let base64 = required_string(object, "data")?;
                let byte_length = usize::try_from(required_u64(object, "byteLength")?)
                    .map_err(|_| TuiError::InvalidResponse("图片大小无效".to_owned()))?;
                let content_hash = required_string(object, "contentHash")?;
                let attachment = app.new_attachment(
                    "clipboard-image".to_owned(),
                    "clipboard".to_owned(),
                    mime_type,
                    byte_length,
                    content_hash,
                    base64,
                );
                match app.add_attachment(attachment) {
                    Ok(true) => app.set_toast("已添加剪贴板图片"),
                    Ok(false) => app.set_toast("图片已在附件中"),
                    Err(message) => app.set_overlay_error(message),
                }
            }
            PendingIntent::ClipboardMutation { toast } => {
                if result
                    .get("capability")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
                {
                    app.set_toast(toast);
                } else {
                    app.set_overlay_error("Host 不支持剪贴板写入");
                }
            }
            PendingIntent::CopyLastAssistantMessage => {
                let object = result
                    .as_object()
                    .ok_or_else(|| TuiError::InvalidResponse("复制消息响应无效".to_owned()))?;
                if !object
                    .get("capability")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
                {
                    app.set_overlay_error("Host 不支持剪贴板写入");
                } else if object
                    .get("copied")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
                {
                    app.set_toast("最近一条 Agent 消息已复制到剪贴板");
                } else {
                    app.set_overlay_error("还没有可复制的 Agent 消息");
                }
            }
            PendingIntent::Export => {
                let path = result
                    .get("path")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| TuiError::InvalidResponse("导出结果缺少路径".to_owned()))?;
                app.set_toast(format!("会话已导出到：{path}"));
            }
            PendingIntent::SettingMutation {
                selected_key,
                filter,
            } => {
                app.invalidate_rich_text();
                if result
                    .get("requiresRestart")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
                {
                    app.set_toast("设置已保存，重启后生效");
                } else {
                    app.set_toast("设置已保存");
                }
                request_settings(
                    app,
                    pipe,
                    session_path,
                    sequence,
                    Some(selected_key),
                    filter,
                )?;
            }
            PendingIntent::ModelMutation {
                session_path,
                provider,
                id,
            } => apply_model_mutation_result(app, result, &session_path, &provider, &id)?,
            PendingIntent::ThinkingMutation {
                session_path,
                provider,
                id,
                level,
            } => {
                apply_thinking_mutation_result(app, result, &session_path, &provider, &id, &level)?
            }
            PendingIntent::ModelCycle {
                session_path,
                provider,
                id,
            } => apply_model_cycle_result(
                app,
                result,
                &session_path,
                provider.as_deref(),
                id.as_deref(),
            )?,
            PendingIntent::ThinkingCycle {
                session_path,
                provider,
                id,
                level,
            } => apply_thinking_cycle_result(
                app,
                result,
                &session_path,
                provider.as_deref(),
                id.as_deref(),
                &level,
            )?,
            PendingIntent::TreeMutation {
                selected_key,
                filter,
            } => {
                request_workspace(
                    app,
                    pipe,
                    sequence,
                    WorkspaceCommand::GetSessionTree,
                    serde_json::json!({ "sessionPath": session_path })
                        .as_object()
                        .cloned()
                        .unwrap_or_default(),
                    PendingIntent::WorkbenchLoad {
                        target: WorkbenchTarget::Tree,
                        selected_key: Some(selected_key),
                        filter,
                    },
                )?;
            }
            PendingIntent::TreeNavigate {
                selected_key: _,
                filter: _,
            } => {
                if result
                    .get("cancelled")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
                {
                    app.pending_editor_replace = None;
                    app.close_overlay();
                    app.set_toast("已取消分支切换");
                    return Ok(Some(false));
                }
                if let Some(text) = result.get("editorText").and_then(serde_json::Value::as_str) {
                    if app.editor.is_empty() {
                        app.editor.replace(text);
                    } else {
                        app.pending_editor_replace = Some(text.to_owned());
                        app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                            title: "替换输入草稿".to_owned(),
                            message: "分支带回了新的输入内容，确认替换当前草稿？".to_owned(),
                            confirm_action: "tree-replace-editor".to_owned(),
                            status: String::new(),
                        }));
                        return Ok(Some(false));
                    }
                }
                app.clear_overlay_transient();
                app.set_toast("已切换分支");
                return Ok(Some(true));
            }
            PendingIntent::AuthMutation {
                provider,
                auth_type,
                filter,
            } => {
                let outcome = apply_auth_models_result(
                    app,
                    pipe,
                    sequence,
                    result,
                    provider.clone(),
                    auth_type.clone(),
                    filter.clone(),
                );
                if outcome.is_err() {
                    restore_auth_overlay(
                        app,
                        if auth_type.is_some() {
                            "login"
                        } else {
                            "logout"
                        },
                        Some(&provider),
                        filter,
                    );
                }
                outcome?;
            }
            PendingIntent::AuthVerify {
                provider,
                auth_type,
                filter,
                models,
            } => {
                let outcome = apply_auth_verify_result(
                    app,
                    result,
                    &provider,
                    auth_type.as_deref(),
                    filter.clone(),
                    models,
                );
                if outcome.is_err() {
                    restore_auth_overlay(
                        app,
                        if auth_type.is_some() {
                            "login"
                        } else {
                            "logout"
                        },
                        Some(&provider),
                        filter,
                    );
                }
                outcome?;
            }
            PendingIntent::AuthList { mode, filter } => {
                let outcome = apply_auth_list_result(
                    app,
                    pipe,
                    client_instance_id,
                    sequence,
                    session_flow,
                    result,
                    &mode,
                    filter.clone(),
                );
                if outcome.is_err() {
                    restore_auth_overlay(app, &mode, None, filter);
                }
                outcome?;
            }
        }
        return Ok(Some(false));
    }
    Ok(None)
}
