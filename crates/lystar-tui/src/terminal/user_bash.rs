use super::*;

pub(super) fn submit_bash(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &Option<SessionFlow>,
) -> Result<(), TuiError> {
    if app.is_active_operation() || app.pending_bash_submit.is_some() || session_flow.is_some() {
        app.set_overlay_error("已有任务正在运行，请先按 Esc 取消");
        return Ok(());
    }
    if !app.attachments.is_empty() {
        app.set_overlay_error("Shell 命令不能包含图片附件");
        return Ok(());
    }
    let text = app.editor.text().trim_end().to_owned();
    let exclude_from_context = text.starts_with("!!");
    let command = text[if exclude_from_context { 2 } else { 1 }..]
        .trim()
        .to_owned();
    if command.is_empty() {
        app.set_overlay_error("请输入 Shell 命令");
        return Ok(());
    }
    let Some(lease_id) = app.lease_id.clone() else {
        app.set_overlay_error("尚未获取会话租约");
        return Ok(());
    };

    *sequence += 1;
    let response_id = format!("bash-{sequence}");
    let frame = encode_session_write_request(
        &response_id,
        "run_bash",
        serde_json::json!({
            "sessionPath": session_path,
            "leaseId": lease_id,
            "clientInstanceId": client_instance_id,
            "clientRequestId": format!("bash:{sequence}"),
            "commandText": command,
            "excludeFromContext": exclude_from_context,
        })
        .as_object()
        .cloned()
        .unwrap_or_default(),
    )?;
    let Some(submitted) = app.editor.submit() else {
        return Ok(());
    };
    app.begin_bash_submit(crate::app::PendingBashSubmit {
        response_id: response_id.clone(),
        session_path: session_path.to_owned(),
        session_generation: app.session_generation,
        text: submitted,
        operation_id: None,
    });
    if let Err(error) = pipe.request(&frame) {
        app.reject_bash_submit(&response_id);
        return Err(error);
    }
    app.transcript.status = "正在运行 Shell，按 Esc 取消".to_owned();
    trace("run_bash");
    Ok(())
}
