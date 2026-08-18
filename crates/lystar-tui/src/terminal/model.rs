use super::*;

pub(super) fn open_model_selector(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
    session_flow: &Option<SessionFlow>,
    filter: String,
) -> Result<(), TuiError> {
    if app.is_active_operation() {
        app.set_overlay_error("当前会话正在运行，不能切换模型");
        return Ok(());
    }
    if session_flow.is_some() {
        app.set_overlay_error("会话操作正在进行");
        return Ok(());
    }
    if app.write_pending {
        app.set_overlay_error("正在写入，请稍候");
        return Ok(());
    }
    if app.lease_id.is_none() {
        app.set_overlay_error("尚未获取会话租约");
        return Ok(());
    }
    app.open_overlay(OverlayState::Detail(DetailOverlay {
        title: "模型".to_owned(),
        lines: vec!["正在读取模型".to_owned()],
        scroll: 0,
        status: "请稍候".to_owned(),
        link: None,
        copy_text: None,
    }));
    request_workspace(
        app,
        pipe,
        sequence,
        WorkspaceCommand::ListModels,
        serde_json::Map::new(),
        PendingIntent::WorkbenchLoad {
            target: WorkbenchTarget::Model,
            selected_key: None,
            filter,
        },
    )
}

pub(super) fn model_command_filter(text: &str) -> Option<String> {
    let command = text.trim();
    if command == "/model" {
        return Some(String::new());
    }
    command
        .strip_prefix("/model ")
        .map(str::trim)
        .filter(|filter| !filter.is_empty())
        .map(str::to_owned)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn handle_model_action(
    app: &mut AppState,
    action: &str,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &Option<SessionFlow>,
) -> Result<bool, TuiError> {
    let Some(index) = action
        .strip_prefix("model:")
        .and_then(|value| value.parse::<usize>().ok())
    else {
        return Ok(false);
    };
    let Some(model) = app.models.get(index).cloned() else {
        app.set_overlay_error("模型列表已刷新，请重新选择");
        return Ok(true);
    };
    if !model.configured {
        app.set_overlay_error("该模型不可用：Provider 未完成认证");
        return Ok(true);
    }
    if app.is_active_operation() {
        app.set_overlay_error("当前会话正在运行，不能切换模型");
        return Ok(true);
    }
    if session_flow.is_some() {
        app.set_overlay_error("会话操作正在进行");
        return Ok(true);
    }
    if app.write_pending {
        app.set_overlay_error("正在写入，请稍候");
        return Ok(true);
    }
    let Some(lease_id) = app.lease_id.clone() else {
        app.set_overlay_error("尚未获取会话租约");
        return Ok(true);
    };
    let client_request_id = format!(
        "model:{}:{}:{}",
        model.provider,
        model.id,
        sequence.saturating_add(1)
    );
    app.mark_write_pending();
    request_workspace(
        app,
        pipe,
        sequence,
        WorkspaceCommand::SetSessionModel,
        serde_json::json!({
            "sessionPath": session_path,
            "leaseId": lease_id,
            "clientInstanceId": client_instance_id,
            "clientRequestId": client_request_id,
            "model": { "provider": model.provider, "id": model.id },
        })
        .as_object()
        .cloned()
        .unwrap_or_default(),
        PendingIntent::ModelMutation {
            session_path: session_path.to_owned(),
            provider: model.provider,
            id: model.id,
        },
    )?;
    Ok(true)
}

pub(super) fn apply_model_mutation_result(
    app: &mut AppState,
    result: serde_json::Value,
    session_path: &str,
    provider: &str,
    id: &str,
) -> Result<(), TuiError> {
    let snapshot: lystar_protocol::SessionSnapshot = serde_json::from_value(result)
        .map_err(|error| TuiError::InvalidResponse(format!("会话状态响应无效: {error}")))?;
    if snapshot.path != session_path
        || !snapshot
            .model
            .as_ref()
            .is_some_and(|model| model.provider == provider && model.id == id)
    {
        return Err(TuiError::InvalidResponse(
            "模型切换结果与当前会话或所选模型不一致".to_owned(),
        ));
    }
    app.apply_snapshot(snapshot);
    app.close_overlay();
    app.set_toast(format!("当前模型：{id}"));
    Ok(())
}
