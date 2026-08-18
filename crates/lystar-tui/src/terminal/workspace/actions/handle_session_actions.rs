use super::*;

pub(super) fn handle_session_actions(
    app: &mut AppState,
    action: &str,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
) -> Result<bool, TuiError> {
    if matches!(
        action,
        "session-import-confirm" | "session-import-cwd-confirm"
    ) {
        if app.is_active_operation() || session_flow.is_some() {
            app.set_overlay_error("当前会话正在运行，不能导入");
            return Ok(true);
        }
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(true);
        };
        let Some(pending) = app.pending_session_import.clone() else {
            app.set_overlay_error("导入请求已失效，请重新执行 /import");
            return Ok(true);
        };
        *sequence += 1;
        let id = format!("session-import-{sequence}");
        *session_flow = Some(SessionFlow::Import {
            id: id.clone(),
            input_path: pending.input_path.clone(),
        });
        let mut payload = serde_json::json!({
            "sessionPath": session_path,
            "leaseId": lease_id,
            "clientInstanceId": client_instance_id,
            "clientRequestId": format!("import:{sequence}"),
            "inputPath": pending.input_path,
        })
        .as_object()
        .cloned()
        .unwrap_or_default();
        if let Some(cwd_override) = pending.cwd_override {
            payload.insert(
                "cwdOverride".to_owned(),
                serde_json::Value::String(cwd_override),
            );
        }
        app.close_overlay();
        pipe.request(&encode_session_write_request(
            &id,
            "import_session",
            payload,
        )?)?;
        return Ok(true);
    }
    if let Some(index) = action
        .strip_prefix("session:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(target) = app.sessions.get(index).cloned() else {
            app.set_overlay_error("会话列表已刷新，请重新选择");
            return Ok(true);
        };
        if target.path == session_path {
            app.close_overlay();
            return Ok(true);
        }
        if app.is_active_operation() || session_flow.is_some() {
            app.set_overlay_error("当前会话正在运行，不能切换");
            return Ok(true);
        }
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(true);
        };
        let restore = app.restore_point();
        *sequence += 1;
        let id = format!("session-release-{sequence}");
        *session_flow = Some(SessionFlow::SwitchReleasing {
            id: id.clone(),
            target,
            restore,
        });
        pipe.request(&encode_release_session_request(
            &id,
            session_path,
            &lease_id,
        )?)?;
        return Ok(true);
    }
    if let Some(index) = action
        .strip_prefix("session-rename:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(session) = app.sessions.get(index) else {
            app.set_overlay_error("会话列表已刷新，请重新选择");
            return Ok(true);
        };
        let name = match app.overlay() {
            Some(OverlayState::TextEditor(editor)) => editor.value.clone(),
            _ => String::new(),
        };
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(true);
        };
        if session.path != session_path {
            app.set_overlay_error("只能重命名当前会话");
            return Ok(true);
        }
        *sequence += 1;
        let id = format!("session-rename-{sequence}");
        *session_flow = Some(SessionFlow::Rename {
            id: id.clone(),
            index,
            name: name.clone(),
        });
        app.close_overlay();
        pipe.request(&encode_session_write_request(
            &id,
            "rename_session",
            serde_json::json!({
                "sessionPath": session_path, "leaseId": lease_id, "name": name,
                "clientInstanceId": client_instance_id, "clientRequestId": format!("rename:{sequence}"),
            }).as_object().cloned().unwrap_or_default(),
        )?)?;
        return Ok(true);
    }
    if action == "session-delete-current" {
        if app.is_active_operation() || session_flow.is_some() {
            app.set_overlay_error("当前会话正在运行，不能删除");
            return Ok(true);
        }
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(true);
        };
        let restore = app.restore_point();
        let target = app
            .sessions
            .iter()
            .find(|session| session.path != session_path)
            .cloned();
        *sequence += 1;
        let id = format!("session-delete-release-{sequence}");
        *session_flow = Some(SessionFlow::DeleteReleasing {
            id: id.clone(),
            restore,
            target,
        });
        pipe.request(&encode_release_session_request(
            &id,
            session_path,
            &lease_id,
        )?)?;
        return Ok(true);
    }
    if action == "session-fork-current" {
        let Some(entry_id) = app.transcript.current_entry_id().map(str::to_owned) else {
            app.set_overlay_error("当前没有可分叉的记录");
            return Ok(true);
        };
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(true);
        };
        *sequence += 1;
        let id = format!("session-fork-{sequence}");
        *session_flow = Some(SessionFlow::Fork {
            id: id.clone(),
            toast: "已创建并切换分叉会话".to_owned(),
        });
        pipe.request(&encode_session_write_request(
            &id,
            "fork_session",
            serde_json::json!({
                "sessionPath": session_path, "leaseId": lease_id, "entryId": entry_id,
                "clientInstanceId": client_instance_id, "clientRequestId": format!("fork:{sequence}"),
            }).as_object().cloned().unwrap_or_default(),
        )?)?;
        return Ok(true);
    }
    if let Some(index) = action
        .strip_prefix("tree-fork:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(node) = app.tree.get(index) else {
            app.set_overlay_error("分支树已刷新，请重新选择");
            return Ok(true);
        };
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(true);
        };
        *sequence += 1;
        let id = format!("tree-fork-{sequence}");
        *session_flow = Some(SessionFlow::Fork {
            id: id.clone(),
            toast: "已创建并切换分叉会话".to_owned(),
        });
        pipe.request(&encode_session_write_request(
            &id,
            "fork_session",
            serde_json::json!({
                "sessionPath": session_path, "leaseId": lease_id, "entryId": node.id,
                "clientInstanceId": client_instance_id, "clientRequestId": format!("tree-fork:{sequence}"),
            }).as_object().cloned().unwrap_or_default(),
        )?)?;
        return Ok(true);
    }
    if let Some(index) = action
        .strip_prefix("tree-label:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(node) = app.tree.get(index).cloned() else {
            app.set_overlay_error("分支树已刷新，请重新选择");
            return Ok(true);
        };
        let label = match app.overlay() {
            Some(OverlayState::TextEditor(editor)) => editor.value.trim().to_owned(),
            _ => String::new(),
        };
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(true);
        };
        let (filter, _) = list_context(app, "分支树");
        app.close_overlay();
        app.mark_write_pending();
        let mut payload = serde_json::json!({
            "sessionPath": session_path, "leaseId": lease_id, "entryId": node.id,
            "clientInstanceId": client_instance_id, "clientRequestId": format!("tree-label:{sequence}"),
        }).as_object().cloned().unwrap_or_default();
        if !label.is_empty() {
            payload.insert("label".to_owned(), serde_json::Value::String(label));
        }
        request_workspace(
            app,
            pipe,
            sequence,
            WorkspaceCommand::SetEntryLabel,
            payload,
            PendingIntent::TreeMutation {
                selected_key: node.id,
                filter,
            },
        )?;
        return Ok(true);
    }
    if let Some(index) = action
        .strip_prefix("tree-summary:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(node) = app.tree.get(index).cloned() else {
            app.set_overlay_error("分支树已刷新，请重新选择");
            return Ok(true);
        };
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(true);
        };
        let (filter, selected_key) = list_context(app, "分支树");
        app.mark_write_pending();
        request_workspace(
            app, pipe, sequence, WorkspaceCommand::NavigateSessionTree,
            serde_json::json!({
                "sessionPath": session_path, "leaseId": lease_id, "entryId": node.id, "summarize": true,
                "clientInstanceId": client_instance_id, "clientRequestId": format!("tree-summary:{sequence}"),
            }).as_object().cloned().unwrap_or_default(),
            PendingIntent::TreeNavigate {
                selected_key: selected_key.unwrap_or(node.id),
                filter,
            },
        )?;
        return Ok(true);
    }
    if let Some(index) = action
        .strip_prefix("tree:")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let Some(node) = app.tree.get(index).cloned() else {
            app.set_overlay_error("分支树已刷新，请重新选择");
            return Ok(true);
        };
        let Some(lease_id) = app.lease_id.clone() else {
            app.set_overlay_error("尚未获取会话租约");
            return Ok(true);
        };
        if app.is_active_operation() {
            app.set_overlay_error("当前会话正在运行，不能切换分支");
            return Ok(true);
        }
        let (filter, selected_key) = list_context(app, "分支树");
        app.mark_write_pending();
        request_workspace(
            app,
            pipe,
            sequence,
            WorkspaceCommand::NavigateSessionTree,
            serde_json::json!({
                "sessionPath": session_path, "leaseId": lease_id, "entryId": node.id,
                "clientInstanceId": client_instance_id, "clientRequestId": format!("tree-navigate:{sequence}"),
            }).as_object().cloned().unwrap_or_default(),
            PendingIntent::TreeNavigate {
                selected_key: selected_key.unwrap_or(node.id),
                filter,
            },
        )?;
        return Ok(true);
    }
    Ok(false)
}
