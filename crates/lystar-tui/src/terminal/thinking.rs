use super::*;

pub(super) fn open_thinking_selector(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    sequence: &mut u64,
    session_flow: &Option<SessionFlow>,
) -> Result<(), TuiError> {
    if app.is_active_operation() {
        app.set_overlay_error("当前会话正在运行，不能切换思考强度");
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
        title: "思考".to_owned(),
        lines: vec!["正在读取模型能力".to_owned()],
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
            target: WorkbenchTarget::Thinking,
            selected_key: None,
            filter: String::new(),
        },
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn handle_thinking_action(
    app: &mut AppState,
    action: &str,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &Option<SessionFlow>,
) -> Result<bool, TuiError> {
    let Some(level) = action.strip_prefix("thinking:") else {
        return Ok(false);
    };
    let model = match app.model_supports_reasoning() {
        Ok(model) => model.clone(),
        Err(reason) => {
            app.set_overlay_error(reason);
            return Ok(true);
        }
    };
    if !model
        .supported_thinking_levels
        .iter()
        .any(|candidate| candidate == level)
    {
        app.set_overlay_error("当前模型不支持此思考强度");
        return Ok(true);
    }
    if app.is_active_operation() {
        app.set_overlay_error("当前会话正在运行，不能切换思考强度");
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
    let client_request_id = format!("thinking:{level}:{}", sequence.saturating_add(1));
    app.mark_write_pending();
    request_workspace(
        app,
        pipe,
        sequence,
        WorkspaceCommand::SetSessionThinking,
        serde_json::json!({
            "sessionPath": session_path,
            "leaseId": lease_id,
            "clientInstanceId": client_instance_id,
            "clientRequestId": client_request_id,
            "level": level,
        })
        .as_object()
        .cloned()
        .unwrap_or_default(),
        PendingIntent::ThinkingMutation {
            session_path: session_path.to_owned(),
            provider: model.provider,
            id: model.id,
            level: level.to_owned(),
        },
    )?;
    Ok(true)
}

pub(super) fn apply_thinking_mutation_result(
    app: &mut AppState,
    result: serde_json::Value,
    session_path: &str,
    provider: &str,
    id: &str,
    level: &str,
) -> Result<(), TuiError> {
    let snapshot: lystar_protocol::SessionSnapshot = serde_json::from_value(result)
        .map_err(|error| TuiError::InvalidResponse(format!("会话状态响应无效: {error}")))?;
    if snapshot.path != session_path
        || snapshot.thinking_level != level
        || !snapshot
            .model
            .as_ref()
            .is_some_and(|model| model.provider == provider && model.id == id)
    {
        return Err(TuiError::InvalidResponse(
            "思考强度切换结果与当前会话、模型或所选等级不一致".to_owned(),
        ));
    }
    app.apply_snapshot(snapshot);
    app.close_overlay();
    app.set_toast(format!("思考强度：{}", thinking_level_label(level)));
    Ok(())
}
