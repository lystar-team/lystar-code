use super::*;

pub(super) fn open_fork_selector(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    sequence: &mut u64,
    session_flow: &Option<SessionFlow>,
) -> Result<(), TuiError> {
    if app.is_active_operation() {
        app.set_overlay_error("当前会话正在运行，不能分叉");
        return Ok(());
    }
    if session_flow.is_some() {
        app.set_overlay_error("会话操作正在进行");
        return Ok(());
    }
    let Some(lease_id) = app.lease_id.clone() else {
        app.set_overlay_error("尚未获取会话租约");
        return Ok(());
    };
    app.open_workspace_overlay(
        "fork",
        OverlayState::Detail(DetailOverlay {
            title: "分叉会话".to_owned(),
            lines: vec!["正在读取用户消息".to_owned()],
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
        WorkspaceCommand::ListForkMessages,
        serde_json::json!({ "sessionPath": session_path, "leaseId": lease_id })
            .as_object()
            .cloned()
            .unwrap_or_default(),
        PendingIntent::ForkMessages,
    )
}

pub(super) fn apply_fork_messages(
    app: &mut AppState,
    result: serde_json::Value,
) -> Result<(), TuiError> {
    let messages = result
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("分叉候选响应无效".to_owned()))?;
    if messages.is_empty() {
        app.close_overlay();
        app.set_toast("当前还没有可分叉的用户消息");
        return Ok(());
    }
    let items = messages
        .iter()
        .map(|message| {
            let object = message
                .as_object()
                .ok_or_else(|| TuiError::InvalidResponse("分叉候选响应无效".to_owned()))?;
            let entry_id = required_string(object, "entryId")?;
            let text = required_string(object, "text")?;
            Ok(OverlayItem {
                label: text.lines().next().unwrap_or_default().to_owned(),
                detail: "从这条用户消息之前创建新会话".to_owned(),
                action: format!("fork-message:{entry_id}"),
            })
        })
        .collect::<Result<Vec<_>, TuiError>>()?;
    let selected = items.len().saturating_sub(1);
    app.replace_overlay(OverlayState::List(ListOverlay {
        title: "分叉会话".to_owned(),
        origin: OverlayOrigin::User,
        items,
        selected,
        filter: String::new(),
        status: "Enter 分叉，Esc 取消".to_owned(),
    }));
    Ok(())
}

pub(super) fn fork_from_message(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    entry_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
) -> Result<(), TuiError> {
    if app.is_active_operation() {
        app.set_overlay_error("当前会话正在运行，不能分叉");
        return Ok(());
    }
    if session_flow.is_some() {
        app.set_overlay_error("会话操作正在进行");
        return Ok(());
    }
    let Some(lease_id) = app.lease_id.clone() else {
        app.set_overlay_error("尚未获取会话租约");
        return Ok(());
    };
    *sequence += 1;
    let id = format!("session-fork-message-{sequence}");
    *session_flow = Some(SessionFlow::Fork {
        id: id.clone(),
        toast: "已创建并切换分叉会话".to_owned(),
        restore_selected_text: true,
    });
    app.close_overlay();
    pipe.request(&encode_session_write_request(
        &id,
        "fork_session",
        serde_json::json!({
            "sessionPath": session_path,
            "leaseId": lease_id,
            "entryId": entry_id,
            "position": "before",
            "clientInstanceId": client_instance_id,
            "clientRequestId": format!("fork-message:{sequence}"),
        })
        .as_object()
        .cloned()
        .unwrap_or_default(),
    )?)
}
