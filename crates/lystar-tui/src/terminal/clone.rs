use super::*;

pub(super) fn clone_current_session(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
) -> Result<(), TuiError> {
    if app.is_active_operation() {
        app.set_overlay_error("当前会话正在运行，不能复制");
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
    let Some(entry_id) = app
        .snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.leaf_id.clone())
    else {
        app.set_toast("当前还没有可复制的会话内容");
        return Ok(());
    };
    *sequence += 1;
    let id = format!("session-clone-{sequence}");
    *session_flow = Some(SessionFlow::Fork {
        id: id.clone(),
        toast: "已复制为新会话".to_owned(),
    });
    pipe.request(&encode_session_write_request(
        &id,
        "fork_session",
        serde_json::json!({
            "sessionPath": session_path,
            "leaseId": lease_id,
            "entryId": entry_id,
            "position": "at",
            "clientInstanceId": client_instance_id,
            "clientRequestId": format!("clone:{sequence}"),
        })
        .as_object()
        .cloned()
        .unwrap_or_default(),
    )?)
}
