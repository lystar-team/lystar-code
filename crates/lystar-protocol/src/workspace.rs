use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::{ClientMessage, ProtocolError, ServerMessage};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceCommand {
    ListSkills,
    SetSkillEnabled,
    ListProjectInstructions,
    SaveProjectInstruction,
    ListHostInstructions,
    SaveHostInstruction,
    GetGitStatus,
    GetGitDiff,
    GetCompletions,
    CheckForUpdates,
    ListSettings,
    SetSetting,
    ListModels,
    ListModelProviders,
    SetSessionModel,
    SetSessionThinking,
    ReloadResources,
    LoginModelProvider,
    LogoutModelProvider,
    GetProjectTrust,
    SetProjectTrust,
    ListPackages,
    InstallPackage,
    RemovePackage,
    UpdatePackages,
    GetSessionTree,
    GetSessionInfo,
    ListForkMessages,
    ForkSession,
    SetEntryLabel,
    NavigateSessionTree,
    ListSubagents,
    ReadSubagent,
    AbortSubagent,
    ContinueSubagent,
    ReadClipboardText,
    ReadClipboardImage,
    ReadProjectImage,
    WriteClipboardText,
    CopyLastAssistantMessage,
    ExportSession,
    GetAbout,
    GetChangelog,
    GetDiagnostics,
    RenderRichText,
    ReadImageContent,
}

impl WorkspaceCommand {
    pub fn from_wire(command: &str) -> Option<Self> {
        Some(match command {
            "list_skills" => Self::ListSkills,
            "set_skill_enabled" => Self::SetSkillEnabled,
            "list_project_instructions" => Self::ListProjectInstructions,
            "save_project_instruction" => Self::SaveProjectInstruction,
            "list_host_instructions" => Self::ListHostInstructions,
            "save_host_instruction" => Self::SaveHostInstruction,
            "get_git_status" => Self::GetGitStatus,
            "get_git_diff" => Self::GetGitDiff,
            "get_completions" => Self::GetCompletions,
            "check_for_updates" => Self::CheckForUpdates,
            "list_settings" => Self::ListSettings,
            "set_setting" => Self::SetSetting,
            "list_models" => Self::ListModels,
            "list_model_providers" => Self::ListModelProviders,
            "set_session_model" => Self::SetSessionModel,
            "set_session_thinking" => Self::SetSessionThinking,
            "reload_resources" => Self::ReloadResources,
            "login_model_provider" => Self::LoginModelProvider,
            "logout_model_provider" => Self::LogoutModelProvider,
            "get_project_trust" => Self::GetProjectTrust,
            "set_project_trust" => Self::SetProjectTrust,
            "list_packages" => Self::ListPackages,
            "install_package" => Self::InstallPackage,
            "remove_package" => Self::RemovePackage,
            "update_packages" => Self::UpdatePackages,
            "get_session_tree" => Self::GetSessionTree,
            "get_session_info" => Self::GetSessionInfo,
            "list_fork_messages" => Self::ListForkMessages,
            "fork_session" => Self::ForkSession,
            "set_entry_label" => Self::SetEntryLabel,
            "navigate_session_tree" => Self::NavigateSessionTree,
            "list_subagents" => Self::ListSubagents,
            "read_subagent" => Self::ReadSubagent,
            "abort_subagent" => Self::AbortSubagent,
            "continue_subagent" => Self::ContinueSubagent,
            "read_clipboard_text" => Self::ReadClipboardText,
            "read_clipboard_image" => Self::ReadClipboardImage,
            "read_project_image" => Self::ReadProjectImage,
            "write_clipboard_text" => Self::WriteClipboardText,
            "copy_last_assistant_message" => Self::CopyLastAssistantMessage,
            "export_session" => Self::ExportSession,
            "get_about" => Self::GetAbout,
            "get_changelog" => Self::GetChangelog,
            "get_diagnostics" => Self::GetDiagnostics,
            "render_rich_text" => Self::RenderRichText,
            "read_image_content" => Self::ReadImageContent,
            _ => return None,
        })
    }

    pub fn wire(self) -> &'static str {
        match self {
            Self::ListSkills => "list_skills",
            Self::SetSkillEnabled => "set_skill_enabled",
            Self::ListProjectInstructions => "list_project_instructions",
            Self::SaveProjectInstruction => "save_project_instruction",
            Self::ListHostInstructions => "list_host_instructions",
            Self::SaveHostInstruction => "save_host_instruction",
            Self::GetGitStatus => "get_git_status",
            Self::GetGitDiff => "get_git_diff",
            Self::GetCompletions => "get_completions",
            Self::CheckForUpdates => "check_for_updates",
            Self::ListSettings => "list_settings",
            Self::SetSetting => "set_setting",
            Self::ListModels => "list_models",
            Self::ListModelProviders => "list_model_providers",
            Self::SetSessionModel => "set_session_model",
            Self::SetSessionThinking => "set_session_thinking",
            Self::ReloadResources => "reload_resources",
            Self::LoginModelProvider => "login_model_provider",
            Self::LogoutModelProvider => "logout_model_provider",
            Self::GetProjectTrust => "get_project_trust",
            Self::SetProjectTrust => "set_project_trust",
            Self::ListPackages => "list_packages",
            Self::InstallPackage => "install_package",
            Self::RemovePackage => "remove_package",
            Self::UpdatePackages => "update_packages",
            Self::GetSessionTree => "get_session_tree",
            Self::GetSessionInfo => "get_session_info",
            Self::ListForkMessages => "list_fork_messages",
            Self::ForkSession => "fork_session",
            Self::SetEntryLabel => "set_entry_label",
            Self::NavigateSessionTree => "navigate_session_tree",
            Self::ListSubagents => "list_subagents",
            Self::ReadSubagent => "read_subagent",
            Self::AbortSubagent => "abort_subagent",
            Self::ContinueSubagent => "continue_subagent",
            Self::ReadClipboardText => "read_clipboard_text",
            Self::ReadClipboardImage => "read_clipboard_image",
            Self::ReadProjectImage => "read_project_image",
            Self::WriteClipboardText => "write_clipboard_text",
            Self::CopyLastAssistantMessage => "copy_last_assistant_message",
            Self::ExportSession => "export_session",
            Self::GetAbout => "get_about",
            Self::GetChangelog => "get_changelog",
            Self::GetDiagnostics => "get_diagnostics",
            Self::RenderRichText => "render_rich_text",
            Self::ReadImageContent => "read_image_content",
        }
    }
}

impl ClientMessage {
    pub fn workspace_command(&self) -> Option<WorkspaceCommand> {
        self.json()
            .ok()?
            .get("request")?
            .get("command")?
            .as_str()
            .and_then(WorkspaceCommand::from_wire)
    }
}

#[derive(Debug)]
pub enum WorkspaceResult {
    ListSkills(crate::generated::WorkspaceListSkillsResult),
    SetSkillEnabled(crate::generated::WorkspaceSetSkillEnabledResult),
    ListProjectInstructions(crate::generated::WorkspaceListProjectInstructionsResult),
    SaveProjectInstruction(crate::generated::WorkspaceSaveProjectInstructionResult),
    ListHostInstructions(crate::generated::WorkspaceListHostInstructionsResult),
    SaveHostInstruction(crate::generated::WorkspaceSaveHostInstructionResult),
    GetGitStatus(crate::generated::WorkspaceGetGitStatusResult),
    GetGitDiff(crate::generated::WorkspaceGetGitDiffResult),
    GetCompletions(crate::generated::WorkspaceGetCompletionsResult),
    CheckForUpdates(crate::generated::WorkspaceCheckForUpdatesResult),
    ListSettings(crate::generated::WorkspaceListSettingsResult),
    SetSetting(crate::generated::WorkspaceSetSettingResult),
    ListModels(crate::generated::WorkspaceListModelsResult),
    ListModelProviders(crate::generated::WorkspaceListModelProvidersResult),
    SetSessionModel(crate::generated::WorkspaceSetSessionModelResult),
    SetSessionThinking(crate::generated::WorkspaceSetSessionThinkingResult),
    ReloadResources(crate::generated::WorkspaceReloadResourcesResult),
    LoginModelProvider(crate::generated::WorkspaceLoginModelProviderResult),
    LogoutModelProvider(crate::generated::WorkspaceLogoutModelProviderResult),
    GetProjectTrust(crate::generated::WorkspaceGetProjectTrustResult),
    SetProjectTrust(crate::generated::WorkspaceSetProjectTrustResult),
    ListPackages(crate::generated::WorkspaceListPackagesResult),
    InstallPackage(crate::generated::WorkspaceInstallPackageResult),
    RemovePackage(crate::generated::WorkspaceRemovePackageResult),
    UpdatePackages(crate::generated::WorkspaceUpdatePackagesResult),
    GetSessionTree(crate::generated::WorkspaceGetSessionTreeResult),
    GetSessionInfo(crate::generated::WorkspaceGetSessionInfoResult),
    ListForkMessages(crate::generated::WorkspaceListForkMessagesResult),
    ForkSession(crate::generated::WorkspaceForkSessionResult),
    SetEntryLabel(crate::generated::WorkspaceSetEntryLabelResult),
    NavigateSessionTree(crate::generated::WorkspaceNavigateSessionTreeResult),
    ListSubagents(crate::generated::WorkspaceListSubagentsResult),
    ReadSubagent(crate::generated::WorkspaceReadSubagentResult),
    AbortSubagent(crate::generated::WorkspaceAbortSubagentResult),
    ContinueSubagent(crate::generated::WorkspaceContinueSubagentResult),
    ReadClipboardText(crate::generated::WorkspaceReadClipboardTextResult),
    ReadClipboardImage(crate::generated::WorkspaceReadClipboardImageResult),
    ReadProjectImage(crate::generated::WorkspaceReadProjectImageResult),
    WriteClipboardText(crate::generated::WorkspaceWriteClipboardTextResult),
    CopyLastAssistantMessage(crate::generated::WorkspaceCopyLastAssistantMessageResult),
    ExportSession(crate::generated::WorkspaceExportSessionResult),
    GetAbout(crate::generated::WorkspaceGetAboutResult),
    GetChangelog(crate::generated::WorkspaceGetChangelogResult),
    GetDiagnostics(crate::generated::WorkspaceGetDiagnosticsResult),
    RenderRichText(crate::generated::WorkspaceRenderRichTextResult),
    ReadImageContent(crate::generated::WorkspaceReadImageContentResult),
}

impl ServerMessage {
    pub fn decode_workspace_result(
        &self,
        command: WorkspaceCommand,
    ) -> Result<WorkspaceResult, ProtocolError> {
        let result = self.workspace_result_value()?;
        match command {
            WorkspaceCommand::ListSkills => Ok(WorkspaceResult::ListSkills(decode(result)?)),
            WorkspaceCommand::SetSkillEnabled => {
                Ok(WorkspaceResult::SetSkillEnabled(decode(result)?))
            }
            WorkspaceCommand::ListProjectInstructions => {
                Ok(WorkspaceResult::ListProjectInstructions(decode(result)?))
            }
            WorkspaceCommand::SaveProjectInstruction => {
                Ok(WorkspaceResult::SaveProjectInstruction(decode(result)?))
            }
            WorkspaceCommand::ListHostInstructions => {
                Ok(WorkspaceResult::ListHostInstructions(decode(result)?))
            }
            WorkspaceCommand::SaveHostInstruction => {
                Ok(WorkspaceResult::SaveHostInstruction(decode(result)?))
            }
            WorkspaceCommand::GetGitStatus => Ok(WorkspaceResult::GetGitStatus(decode(result)?)),
            WorkspaceCommand::GetGitDiff => Ok(WorkspaceResult::GetGitDiff(decode(result)?)),
            WorkspaceCommand::GetCompletions => {
                Ok(WorkspaceResult::GetCompletions(decode(result)?))
            }
            WorkspaceCommand::CheckForUpdates => {
                Ok(WorkspaceResult::CheckForUpdates(decode(result)?))
            }
            WorkspaceCommand::ListSettings => Ok(WorkspaceResult::ListSettings(decode(result)?)),
            WorkspaceCommand::SetSetting => Ok(WorkspaceResult::SetSetting(decode(result)?)),
            WorkspaceCommand::ListModels => Ok(WorkspaceResult::ListModels(decode(result)?)),
            WorkspaceCommand::ListModelProviders => {
                Ok(WorkspaceResult::ListModelProviders(decode(result)?))
            }
            WorkspaceCommand::SetSessionModel => {
                Ok(WorkspaceResult::SetSessionModel(decode(result)?))
            }
            WorkspaceCommand::SetSessionThinking => {
                Ok(WorkspaceResult::SetSessionThinking(decode(result)?))
            }
            WorkspaceCommand::ReloadResources => {
                Ok(WorkspaceResult::ReloadResources(decode(result)?))
            }
            WorkspaceCommand::LoginModelProvider => {
                Ok(WorkspaceResult::LoginModelProvider(decode(result)?))
            }
            WorkspaceCommand::LogoutModelProvider => {
                Ok(WorkspaceResult::LogoutModelProvider(decode(result)?))
            }
            WorkspaceCommand::GetProjectTrust => {
                Ok(WorkspaceResult::GetProjectTrust(decode(result)?))
            }
            WorkspaceCommand::SetProjectTrust => {
                Ok(WorkspaceResult::SetProjectTrust(decode(result)?))
            }
            WorkspaceCommand::ListPackages => Ok(WorkspaceResult::ListPackages(decode(result)?)),
            WorkspaceCommand::InstallPackage => {
                Ok(WorkspaceResult::InstallPackage(decode(result)?))
            }
            WorkspaceCommand::RemovePackage => Ok(WorkspaceResult::RemovePackage(decode(result)?)),
            WorkspaceCommand::UpdatePackages => {
                Ok(WorkspaceResult::UpdatePackages(decode(result)?))
            }
            WorkspaceCommand::GetSessionTree => {
                Ok(WorkspaceResult::GetSessionTree(decode(result)?))
            }
            WorkspaceCommand::GetSessionInfo => {
                Ok(WorkspaceResult::GetSessionInfo(decode(result)?))
            }
            WorkspaceCommand::ListForkMessages => {
                Ok(WorkspaceResult::ListForkMessages(decode(result)?))
            }
            WorkspaceCommand::ForkSession => Ok(WorkspaceResult::ForkSession(decode(result)?)),
            WorkspaceCommand::SetEntryLabel => Ok(WorkspaceResult::SetEntryLabel(decode(result)?)),
            WorkspaceCommand::NavigateSessionTree => {
                Ok(WorkspaceResult::NavigateSessionTree(decode(result)?))
            }
            WorkspaceCommand::ListSubagents => Ok(WorkspaceResult::ListSubagents(decode(result)?)),
            WorkspaceCommand::ReadSubagent => Ok(WorkspaceResult::ReadSubagent(decode(result)?)),
            WorkspaceCommand::AbortSubagent => Ok(WorkspaceResult::AbortSubagent(decode(result)?)),
            WorkspaceCommand::ContinueSubagent => {
                Ok(WorkspaceResult::ContinueSubagent(decode(result)?))
            }
            WorkspaceCommand::ReadClipboardText => {
                Ok(WorkspaceResult::ReadClipboardText(decode(result)?))
            }
            WorkspaceCommand::ReadClipboardImage => {
                Ok(WorkspaceResult::ReadClipboardImage(decode(result)?))
            }
            WorkspaceCommand::ReadProjectImage => {
                Ok(WorkspaceResult::ReadProjectImage(decode(result)?))
            }
            WorkspaceCommand::WriteClipboardText => {
                Ok(WorkspaceResult::WriteClipboardText(decode(result)?))
            }
            WorkspaceCommand::CopyLastAssistantMessage => {
                Ok(WorkspaceResult::CopyLastAssistantMessage(decode(result)?))
            }
            WorkspaceCommand::ExportSession => Ok(WorkspaceResult::ExportSession(decode(result)?)),
            WorkspaceCommand::GetAbout => Ok(WorkspaceResult::GetAbout(decode(result)?)),
            WorkspaceCommand::GetChangelog => Ok(WorkspaceResult::GetChangelog(decode(result)?)),
            WorkspaceCommand::GetDiagnostics => {
                Ok(WorkspaceResult::GetDiagnostics(decode(result)?))
            }
            WorkspaceCommand::RenderRichText => {
                Ok(WorkspaceResult::RenderRichText(decode(result)?))
            }
            WorkspaceCommand::ReadImageContent => {
                Ok(WorkspaceResult::ReadImageContent(decode(result)?))
            }
        }
    }

    pub fn validated_workspace_result_value(
        &self,
        command: WorkspaceCommand,
    ) -> Result<Value, ProtocolError> {
        let _ = self.decode_workspace_result(command)?;
        self.workspace_result_value()
    }

    fn workspace_result_value(&self) -> Result<Value, ProtocolError> {
        let raw = self.json()?;
        if raw.get("type").and_then(Value::as_str) != Some("response")
            || raw.get("ok").and_then(Value::as_bool) != Some(true)
        {
            return Err(invalid_result("expected a successful response"));
        }
        raw.get("result")
            .cloned()
            .ok_or_else(|| invalid_result("missing result"))
    }
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T, ProtocolError> {
    serde_json::from_value(value).map_err(|error| invalid_result(error.to_string()))
}

fn invalid_result(reason: impl Into<String>) -> ProtocolError {
    ProtocolError::InvalidMessage {
        direction: "server",
        reason: format!("invalid Workspace result: {}", reason.into()),
    }
}

#[cfg(test)]
mod tests {
    use ciborium::ser::into_writer;
    use serde_json::json;

    use super::*;

    fn response(result: serde_json::Value) -> ServerMessage {
        let raw: ciborium::value::Value = serde_json::from_value(json!({
            "type": "response", "id": "workspace", "ok": true, "result": result,
        }))
        .unwrap();
        let mut bytes = Vec::new();
        into_writer(&raw, &mut bytes).unwrap();
        crate::decode_server_message(&bytes).unwrap()
    }

    #[test]
    fn validates_typed_about_and_diagnostics_results_before_exposing_json() {
        let about = json!({
            "productName":"LYStar Code", "productVersion":"0.84.2", "piVersion":"0.84.2",
            "hostVersion":"host", "protocolVersion":1, "releaseRepository":null,
            "agentDir":"/tmp/agent", "sessionsDir":"/tmp/agent/sessions", "configDirName":".pi"
        });
        assert_eq!(
            response(about.clone())
                .validated_workspace_result_value(WorkspaceCommand::GetAbout)
                .unwrap(),
            about
        );
        assert!(
            response(json!({"productName":"LYStar Code"}))
                .validated_workspace_result_value(WorkspaceCommand::GetAbout)
                .is_err()
        );
        assert!(
            response(json!({"checks":[], "extra":true}))
                .validated_workspace_result_value(WorkspaceCommand::GetDiagnostics)
                .is_err()
        );
    }

    #[test]
    fn recognizes_only_declared_workspace_commands() {
        assert_eq!(
            WorkspaceCommand::from_wire("list_skills"),
            Some(WorkspaceCommand::ListSkills)
        );
        assert_eq!(
            WorkspaceCommand::from_wire("check_for_updates"),
            Some(WorkspaceCommand::CheckForUpdates)
        );
        assert_eq!(
            WorkspaceCommand::from_wire("get_about"),
            Some(WorkspaceCommand::GetAbout)
        );
        assert_eq!(
            WorkspaceCommand::from_wire("get_changelog"),
            Some(WorkspaceCommand::GetChangelog)
        );
        assert_eq!(
            WorkspaceCommand::from_wire("get_diagnostics"),
            Some(WorkspaceCommand::GetDiagnostics)
        );
        assert_eq!(
            WorkspaceCommand::from_wire("export_session"),
            Some(WorkspaceCommand::ExportSession)
        );
        assert_eq!(
            WorkspaceCommand::from_wire("reload_resources"),
            Some(WorkspaceCommand::ReloadResources)
        );
        assert_eq!(
            WorkspaceCommand::from_wire("list_fork_messages"),
            Some(WorkspaceCommand::ListForkMessages)
        );
        assert_eq!(
            WorkspaceCommand::from_wire("get_session_info"),
            Some(WorkspaceCommand::GetSessionInfo)
        );
        assert_eq!(
            WorkspaceCommand::from_wire("fork_session"),
            Some(WorkspaceCommand::ForkSession)
        );
        assert!(WorkspaceCommand::from_wire("list_sessions").is_none());
    }
}
