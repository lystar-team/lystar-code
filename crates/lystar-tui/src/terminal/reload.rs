use super::*;

pub(super) fn reload_resources(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
) -> Result<(), TuiError> {
    if app.is_active_operation() {
        app.set_overlay_error("当前会话正在运行，不能重新加载");
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
    let id = format!("session-reload-{sequence}");
    *session_flow = Some(SessionFlow::Reload { id: id.clone() });
    app.transcript.status = "正在重新加载 Extension、Skill、Prompt、Theme 和上下文文件".to_owned();
    pipe.request(&encode_session_write_request(
        &id,
        "reload_resources",
        serde_json::json!({
            "sessionPath": session_path,
            "leaseId": lease_id,
            "clientInstanceId": client_instance_id,
            "clientRequestId": format!("reload:{sequence}"),
        })
        .as_object()
        .cloned()
        .unwrap_or_default(),
    )?)
}
