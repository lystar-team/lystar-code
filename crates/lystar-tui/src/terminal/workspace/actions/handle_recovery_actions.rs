use super::*;

pub(super) fn handle_recovery_actions(
    app: &mut AppState,
    action: &str,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
) -> Result<bool, TuiError> {
    if action == "recovery-append" {
        if app.append_recovery_draft() {
            app.close_overlay();
            app.set_toast("已追加恢复草稿");
        }
        return Ok(true);
    }
    if action == "recovery-replace-confirm" {
        if app.recovery_draft.is_some() {
            app.open_overlay(OverlayState::Confirm(ConfirmOverlay {
                title: "替换恢复草稿".to_owned(),
                message: "确认替换当前输入内容？".to_owned(),
                confirm_action: "recovery-replace".to_owned(),
                status: String::new(),
            }));
        }
        return Ok(true);
    }
    if action == "recovery-replace" {
        if app.replace_with_recovery_draft() {
            app.close_overlay();
            app.close_overlay();
            app.set_toast("已替换输入草稿");
        }
        return Ok(true);
    }
    if action == "recovery-copy" {
        if let Some(text) = app.recovery_draft_text().map(str::to_owned) {
            request_clipboard_write(
                app,
                pipe,
                client_instance_id,
                sequence,
                text,
                "已复制恢复草稿",
            )?;
        }
        return Ok(true);
    }
    if action == "recovery-discard" {
        if app.discard_recovery_draft() {
            app.close_overlay();
            app.set_toast("已丢弃恢复草稿");
        }
        return Ok(true);
    }
    if let Some(index) = action
        .strip_prefix("composer-completion:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(completion) = app.composer_completion.clone() else {
            app.set_overlay_error("补全结果已失效，请重试");
            return Ok(true);
        };
        let Some(item) = completion.items.get(index) else {
            app.set_overlay_error("补全项已失效，请重试");
            return Ok(true);
        };
        let next = format!(
            "{}{}{}",
            &completion.text[..completion.prefix_start],
            item.value,
            &completion.text[completion.prefix_end..]
        );
        app.editor.replace(&next);
        app.composer_completion = None;
        app.close_overlay();
        if item.kind == "directory" {
            request_attach_completion(app, pipe, sequence)?;
            return Ok(true);
        }
        if item.kind == "file" && completion.text.starts_with("/attach ") {
            let path = item.value.trim_end_matches('/').to_owned();
            app.editor.clear();
            let cwd = app.active_session_cwd().unwrap_or_default().to_owned();
            request_workspace(
                app,
                pipe,
                sequence,
                WorkspaceCommand::ReadProjectImage,
                serde_json::json!({ "cwd": cwd, "path": path })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                PendingIntent::ProjectImage {
                    source: item.value.clone(),
                },
            )?;
        }
        return Ok(true);
    }
    if let Some(index) = action
        .strip_prefix("attachment:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(attachment) = app.attachments.get(index) else {
            app.set_overlay_error("附件列表已刷新，请重新选择");
            return Ok(true);
        };
        app.attachment_preview = Some(attachment.content_hash.clone());
        app.open_overlay(OverlayState::Detail(DetailOverlay {
            title: "图片预览".to_owned(),
            lines: vec![
                format!("名称: {}", attachment.name),
                format!("来源: {}", attachment.source),
                format!("MIME: {}", attachment.mime_type),
                format!("大小: {} B", attachment.byte_length),
                format!("哈希: {}", attachment.content_hash),
                format!("[图片 {} {}]", attachment.mime_type, attachment.byte_length),
            ],
            scroll: 0,
            status: "Esc 返回".to_owned(),
            link: None,
            copy_text: None,
        }));
        return Ok(true);
    }
    if let Some(index) = action
        .strip_prefix("attachment-remove:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        if app.remove_attachment(index) {
            app.close_overlay();
            app.replace_overlay(attach_overlay(app));
            app.set_toast("已删除图片附件");
        } else {
            app.set_overlay_error("附件列表已刷新，请重新选择");
        }
        return Ok(true);
    }
    if action == "attachment-clear" {
        app.clear_attachments();
        app.close_overlay();
        app.close_overlay();
        app.set_toast("已清空图片附件");
        return Ok(true);
    }
    if let Some(target) = action.strip_prefix("clipboard-select:") {
        let Some(state) = app.clipboard_read.clone() else {
            app.set_overlay_error("剪贴板读取结果已失效");
            return Ok(true);
        };
        let text = state.text.and_then(|item| item.text);
        let image = state.image;
        if matches!(target, "text" | "both")
            && let Some(text) = text
        {
            app.editor.insert(&text);
        }
        if matches!(target, "image" | "both")
            && let Some(image) = image
        {
            match app.add_attachment(image) {
                Ok(true) => {}
                Ok(false) => app.set_toast("图片已在附件中"),
                Err(message) => app.set_overlay_error(message),
            }
        }
        app.close_overlay();
        app.set_toast(match target {
            "text" => "已插入剪贴板文本",
            "image" => "已添加剪贴板图片",
            _ => "已插入文本并添加图片",
        });
        return Ok(true);
    }
    if let Some(target) = action.strip_prefix("open:") {
        open_workbench(
            app,
            target,
            pipe,
            session_path,
            client_instance_id,
            sequence,
            session_flow,
        )?;
        return Ok(true);
    }
    if let Some(index) = action
        .strip_prefix("subagent:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(snapshot) = app.subagents.get(index).cloned() else {
            app.set_overlay_error("Subagent 列表已刷新，请重新选择");
            return Ok(true);
        };
        let filter = list_context(app, "Subagent").0;
        request_workspace(
            app,
            pipe,
            sequence,
            WorkspaceCommand::ReadSubagent,
            serde_json::json!({
                "sessionPath": snapshot.parent_session_path,
                "agentId": snapshot.agent_id,
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::SubagentRead {
                parent_session_path: snapshot.parent_session_path,
                selected_key: format!("subagent:{index}"),
                filter,
            },
        )?;
        return Ok(true);
    }
    if let Some(index) = action
        .strip_prefix("subagent-abort:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(snapshot) = app.subagents.get(index).cloned() else {
            app.set_overlay_error("Subagent 列表已刷新，请重新选择");
            return Ok(true);
        };
        if !snapshot.controllable || !subagent_running(&snapshot.state) {
            app.set_overlay_error("当前 Subagent 不能停止");
            return Ok(true);
        }
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(true);
        };
        if app.active_session_path() != Some(snapshot.parent_session_path.as_str()) {
            app.set_overlay_error("只允许控制当前会话的 Subagent");
            return Ok(true);
        }
        let filter = list_context(app, "Subagent").0;
        app.close_overlay();
        app.mark_write_pending();
        request_workspace(
            app,
            pipe,
            sequence,
            WorkspaceCommand::AbortSubagent,
            serde_json::json!({
                "sessionPath": snapshot.parent_session_path,
                "leaseId": lease_id,
                "agentId": snapshot.agent_id,
                "clientInstanceId": client_instance_id,
                "clientRequestId": format!("subagent-abort:{}:{}", snapshot.agent_id, sequence.saturating_add(1)),
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::SubagentMutation {
                parent_session_path: snapshot.parent_session_path,
                selected_key: format!("subagent:{index}"),
                filter,
                toast: "已请求停止 Subagent".to_owned(),
            },
        )?;
        return Ok(true);
    }
    if let Some(index) = action
        .strip_prefix("subagent-continue:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let text = match app.overlay() {
            Some(OverlayState::TextEditor(editor)) => editor.value.trim().to_owned(),
            _ => String::new(),
        };
        let Some(snapshot) = app.subagents.get(index).cloned() else {
            app.set_overlay_error("Subagent 列表已刷新，请重新选择");
            return Ok(true);
        };
        if subagent_running(&snapshot.state) || snapshot.session_file.is_none() {
            app.set_overlay_error("运行中的 Subagent 不能继续");
            return Ok(true);
        }
        if text.is_empty() {
            app.set_overlay_error("继续内容不能为空");
            return Ok(true);
        }
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(true);
        };
        if app.active_session_path() != Some(snapshot.parent_session_path.as_str()) {
            app.set_overlay_error("只允许控制当前会话的 Subagent");
            return Ok(true);
        }
        let filter = list_context(app, "Subagent").0;
        app.close_overlay();
        app.mark_write_pending();
        request_workspace(
            app,
            pipe,
            sequence,
            WorkspaceCommand::ContinueSubagent,
            serde_json::json!({
                "sessionPath": snapshot.parent_session_path,
                "leaseId": lease_id,
                "agentId": snapshot.agent_id,
                "text": text,
                "clientInstanceId": client_instance_id,
                "clientRequestId": format!("subagent-continue:{}:{}", snapshot.agent_id, sequence.saturating_add(1)),
            })
            .as_object()
            .cloned()
            .unwrap_or_default(),
            PendingIntent::SubagentMutation {
                parent_session_path: snapshot.parent_session_path,
                selected_key: format!("subagent:{index}"),
                filter,
                toast: "已继续 Subagent".to_owned(),
            },
        )?;
        return Ok(true);
    }
    Ok(false)
}
