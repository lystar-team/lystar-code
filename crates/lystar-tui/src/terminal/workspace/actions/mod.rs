use super::*;

mod handle_project_actions;
mod handle_recovery_actions;
mod handle_session_actions;
mod handle_settings_actions;

pub(in super::super) fn activate_workbench_action(
    app: &mut AppState,
    action: &str,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    client_instance_id: &str,
    sequence: &mut u64,
    session_flow: &mut Option<SessionFlow>,
) -> Result<(), TuiError> {
    if handle_recovery_actions(
        app,
        action,
        pipe,
        session_path,
        client_instance_id,
        sequence,
        session_flow,
    )? || handle_project_actions(
        app,
        action,
        pipe,
        session_path,
        client_instance_id,
        sequence,
        session_flow,
    )? || handle_session_actions(
        app,
        action,
        pipe,
        session_path,
        client_instance_id,
        sequence,
        session_flow,
    )? {
        return Ok(());
    }
    handle_settings_actions(
        app,
        action,
        pipe,
        session_path,
        client_instance_id,
        sequence,
        session_flow,
    )
}

use handle_project_actions::handle_project_actions;
use handle_recovery_actions::handle_recovery_actions;
use handle_session_actions::handle_session_actions;
use handle_settings_actions::handle_settings_actions;
