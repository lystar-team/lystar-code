use super::*;

pub(super) fn request_copy_last_assistant_message(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
) -> Result<(), TuiError> {
    let client_request_id = format!("copy:latest:{}", sequence.saturating_add(1));
    app.mark_write_pending();
    request_workspace(
        app,
        pipe,
        sequence,
        WorkspaceCommand::CopyLastAssistantMessage,
        serde_json::json!({
            "sessionPath": session_path,
            "clientInstanceId": client_instance_id,
            "clientRequestId": client_request_id,
        })
        .as_object()
        .cloned()
        .unwrap_or_default(),
        PendingIntent::CopyLastAssistantMessage,
    )
}
