use super::*;

use apply_content_response::apply_content_response;
use apply_extension_event::apply_extension_event;
use apply_extension_input_response::apply_extension_input_response;
use apply_interaction_response::apply_interaction_response;
use apply_workspace_response::apply_workspace_response;

#[allow(clippy::too_many_arguments)]
pub(in super::super) fn apply_server_message(
    app: &mut AppState,
    message: &ServerMessage,
    session_path: &str,
    pipe: &mut ProtocolPipe,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
    quit_requested: &mut bool,
) -> Result<bool, TuiError> {
    let raw = message.json().map_err(TuiError::from)?;
    if let Some(outcome) = apply_extension_event(
        app,
        &raw,
        session_path,
        pipe,
        client_instance_id,
        sequence,
        session_flow,
        quit_requested,
    )? {
        return Ok(outcome);
    }
    if let Some(outcome) = apply_extension_input_response(
        app,
        &raw,
        session_path,
        pipe,
        client_instance_id,
        sequence,
        session_flow,
        quit_requested,
    )? {
        return Ok(outcome);
    }
    let page_response_id = (raw.get("type").and_then(serde_json::Value::as_str)
        == Some("response"))
    .then(|| raw.get("id").and_then(serde_json::Value::as_str))
    .flatten()
    .filter(|id| id.starts_with("initial-") || id.starts_with("older-"))
    .map(str::to_owned);
    if let Some(id) = &page_response_id {
        trace_id("host_response_received", id);
    }
    if let Some(SessionFlow::Reload { id }) = session_flow.as_ref()
        && raw.get("type").and_then(serde_json::Value::as_str) == Some("response")
        && raw.get("id").and_then(serde_json::Value::as_str) == Some(id.as_str())
        && raw.get("ok").and_then(serde_json::Value::as_bool) == Some(true)
        && let Err(error) =
            message.validated_workspace_result_value(WorkspaceCommand::ReloadResources)
    {
        *session_flow = None;
        app.transcript.status.clear();
        return Err(TuiError::Protocol(error));
    }
    if let Some(SessionFlow::Fork { id, .. }) = session_flow.as_ref()
        && raw.get("type").and_then(serde_json::Value::as_str) == Some("response")
        && raw.get("id").and_then(serde_json::Value::as_str) == Some(id.as_str())
        && raw.get("ok").and_then(serde_json::Value::as_bool) == Some(true)
        && let Err(error) = message.validated_workspace_result_value(WorkspaceCommand::ForkSession)
    {
        *session_flow = None;
        return Err(TuiError::Protocol(error));
    }
    if let Some(outcome) = apply_interaction_response(
        app,
        &raw,
        pipe,
        client_instance_id,
        sequence,
        session_flow,
        quit_requested,
    )? {
        return Ok(outcome);
    }
    if let Some(outcome) = apply_content_response(app, message, &raw)? {
        return Ok(outcome);
    }
    if let Some(outcome) =
        apply_workspace_response(app, message, &raw, pipe, session_path, sequence)?
    {
        return Ok(outcome);
    }
    let read_only = if let Some(id) = &page_response_id {
        trace_id("page_decode_start", id);
        let decoded = message.read_only().map_err(TuiError::from)?;
        trace_id("page_decode_end", id);
        decoded
    } else {
        message.read_only().map_err(TuiError::from)?
    };
    match read_only {
        ReadOnlyMessage::Response(response) => apply_response(app, &response),
        ReadOnlyMessage::Event(event) => {
            let active_path = app.active_session_path().unwrap_or(session_path).to_owned();
            apply_event(app, &event, &active_path)
        }
        ReadOnlyMessage::Hello | ReadOnlyMessage::HelloError { .. } => Ok(false),
    }
}
