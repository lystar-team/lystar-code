use super::*;

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
pub(super) fn request_session_name(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
    input: &str,
) -> Result<(), TuiError> {
    let name = input.trim();
    if name.is_empty() {
        if let Some(name) = app
            .snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.name.as_deref())
        {
            app.set_toast(format!("会话名称：{name}"));
        } else {
            app.set_overlay_error("用法：/name <name>");
        }
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
    let id = format!("session-name-{sequence}");
    *session_flow = Some(SessionFlow::Name {
        id: id.clone(),
        requested_name: name.to_owned(),
    });
    pipe.request(&encode_session_write_request(
        &id,
        "rename_session",
        serde_json::json!({
            "sessionPath": session_path,
            "leaseId": lease_id,
            "name": name,
            "clientInstanceId": client_instance_id,
            "clientRequestId": format!("name:{sequence}"),
        })
        .as_object()
        .cloned()
        .unwrap_or_default(),
    )?)
}
