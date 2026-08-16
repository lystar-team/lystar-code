use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::{ClientMessage, ProtocolError, ServerMessage};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum B3Command {
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
    LoginModelProvider,
    LogoutModelProvider,
    GetProjectTrust,
    SetProjectTrust,
    ListPackages,
    InstallPackage,
    RemovePackage,
    UpdatePackages,
    GetSessionTree,
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
    GetAbout,
    GetDiagnostics,
    RenderRichText,
    ReadImageContent,
}

impl B3Command {
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
            "login_model_provider" => Self::LoginModelProvider,
            "logout_model_provider" => Self::LogoutModelProvider,
            "get_project_trust" => Self::GetProjectTrust,
            "set_project_trust" => Self::SetProjectTrust,
            "list_packages" => Self::ListPackages,
            "install_package" => Self::InstallPackage,
            "remove_package" => Self::RemovePackage,
            "update_packages" => Self::UpdatePackages,
            "get_session_tree" => Self::GetSessionTree,
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
            "get_about" => Self::GetAbout,
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
            Self::LoginModelProvider => "login_model_provider",
            Self::LogoutModelProvider => "logout_model_provider",
            Self::GetProjectTrust => "get_project_trust",
            Self::SetProjectTrust => "set_project_trust",
            Self::ListPackages => "list_packages",
            Self::InstallPackage => "install_package",
            Self::RemovePackage => "remove_package",
            Self::UpdatePackages => "update_packages",
            Self::GetSessionTree => "get_session_tree",
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
            Self::GetAbout => "get_about",
            Self::GetDiagnostics => "get_diagnostics",
            Self::RenderRichText => "render_rich_text",
            Self::ReadImageContent => "read_image_content",
        }
    }
}

impl ClientMessage {
    pub fn b3_command(&self) -> Option<B3Command> {
        self.json()
            .ok()?
            .get("request")?
            .get("command")?
            .as_str()
            .and_then(B3Command::from_wire)
    }
}

#[derive(Debug)]
pub enum B3Result {
    ListSkills(crate::generated::B3ListSkillsResult),
    SetSkillEnabled(crate::generated::B3SetSkillEnabledResult),
    ListProjectInstructions(crate::generated::B3ListProjectInstructionsResult),
    SaveProjectInstruction(crate::generated::B3SaveProjectInstructionResult),
    ListHostInstructions(crate::generated::B3ListHostInstructionsResult),
    SaveHostInstruction(crate::generated::B3SaveHostInstructionResult),
    GetGitStatus(crate::generated::B3GetGitStatusResult),
    GetGitDiff(crate::generated::B3GetGitDiffResult),
    GetCompletions(crate::generated::B3GetCompletionsResult),
    CheckForUpdates(crate::generated::B3CheckForUpdatesResult),
    ListSettings(crate::generated::B3ListSettingsResult),
    SetSetting(crate::generated::B3SetSettingResult),
    ListModels(crate::generated::B3ListModelsResult),
    ListModelProviders(crate::generated::B3ListModelProvidersResult),
    SetSessionModel(crate::generated::B3SetSessionModelResult),
    SetSessionThinking(crate::generated::B3SetSessionThinkingResult),
    LoginModelProvider(crate::generated::B3LoginModelProviderResult),
    LogoutModelProvider(crate::generated::B3LogoutModelProviderResult),
    GetProjectTrust(crate::generated::B3GetProjectTrustResult),
    SetProjectTrust(crate::generated::B3SetProjectTrustResult),
    ListPackages(crate::generated::B3ListPackagesResult),
    InstallPackage(crate::generated::B3InstallPackageResult),
    RemovePackage(crate::generated::B3RemovePackageResult),
    UpdatePackages(crate::generated::B3UpdatePackagesResult),
    GetSessionTree(crate::generated::B3GetSessionTreeResult),
    SetEntryLabel(crate::generated::B3SetEntryLabelResult),
    NavigateSessionTree(crate::generated::B3NavigateSessionTreeResult),
    ListSubagents(crate::generated::B3ListSubagentsResult),
    ReadSubagent(crate::generated::B3ReadSubagentResult),
    AbortSubagent(crate::generated::B3AbortSubagentResult),
    ContinueSubagent(crate::generated::B3ContinueSubagentResult),
    ReadClipboardText(crate::generated::B3ReadClipboardTextResult),
    ReadClipboardImage(crate::generated::B3ReadClipboardImageResult),
    ReadProjectImage(crate::generated::B3ReadProjectImageResult),
    WriteClipboardText(crate::generated::B3WriteClipboardTextResult),
    GetAbout(crate::generated::B3GetAboutResult),
    GetDiagnostics(crate::generated::B3GetDiagnosticsResult),
    RenderRichText(crate::generated::B3RenderRichTextResult),
    ReadImageContent(crate::generated::B3ReadImageContentResult),
}

impl ServerMessage {
    pub fn decode_b3_result(&self, command: B3Command) -> Result<B3Result, ProtocolError> {
        let result = self.b3_result_value()?;
        match command {
            B3Command::ListSkills => Ok(B3Result::ListSkills(decode(result)?)),
            B3Command::SetSkillEnabled => Ok(B3Result::SetSkillEnabled(decode(result)?)),
            B3Command::ListProjectInstructions => {
                Ok(B3Result::ListProjectInstructions(decode(result)?))
            }
            B3Command::SaveProjectInstruction => {
                Ok(B3Result::SaveProjectInstruction(decode(result)?))
            }
            B3Command::ListHostInstructions => Ok(B3Result::ListHostInstructions(decode(result)?)),
            B3Command::SaveHostInstruction => Ok(B3Result::SaveHostInstruction(decode(result)?)),
            B3Command::GetGitStatus => Ok(B3Result::GetGitStatus(decode(result)?)),
            B3Command::GetGitDiff => Ok(B3Result::GetGitDiff(decode(result)?)),
            B3Command::GetCompletions => Ok(B3Result::GetCompletions(decode(result)?)),
            B3Command::CheckForUpdates => Ok(B3Result::CheckForUpdates(decode(result)?)),
            B3Command::ListSettings => Ok(B3Result::ListSettings(decode(result)?)),
            B3Command::SetSetting => Ok(B3Result::SetSetting(decode(result)?)),
            B3Command::ListModels => Ok(B3Result::ListModels(decode(result)?)),
            B3Command::ListModelProviders => Ok(B3Result::ListModelProviders(decode(result)?)),
            B3Command::SetSessionModel => Ok(B3Result::SetSessionModel(decode(result)?)),
            B3Command::SetSessionThinking => Ok(B3Result::SetSessionThinking(decode(result)?)),
            B3Command::LoginModelProvider => Ok(B3Result::LoginModelProvider(decode(result)?)),
            B3Command::LogoutModelProvider => Ok(B3Result::LogoutModelProvider(decode(result)?)),
            B3Command::GetProjectTrust => Ok(B3Result::GetProjectTrust(decode(result)?)),
            B3Command::SetProjectTrust => Ok(B3Result::SetProjectTrust(decode(result)?)),
            B3Command::ListPackages => Ok(B3Result::ListPackages(decode(result)?)),
            B3Command::InstallPackage => Ok(B3Result::InstallPackage(decode(result)?)),
            B3Command::RemovePackage => Ok(B3Result::RemovePackage(decode(result)?)),
            B3Command::UpdatePackages => Ok(B3Result::UpdatePackages(decode(result)?)),
            B3Command::GetSessionTree => Ok(B3Result::GetSessionTree(decode(result)?)),
            B3Command::SetEntryLabel => Ok(B3Result::SetEntryLabel(decode(result)?)),
            B3Command::NavigateSessionTree => Ok(B3Result::NavigateSessionTree(decode(result)?)),
            B3Command::ListSubagents => Ok(B3Result::ListSubagents(decode(result)?)),
            B3Command::ReadSubagent => Ok(B3Result::ReadSubagent(decode(result)?)),
            B3Command::AbortSubagent => Ok(B3Result::AbortSubagent(decode(result)?)),
            B3Command::ContinueSubagent => Ok(B3Result::ContinueSubagent(decode(result)?)),
            B3Command::ReadClipboardText => Ok(B3Result::ReadClipboardText(decode(result)?)),
            B3Command::ReadClipboardImage => Ok(B3Result::ReadClipboardImage(decode(result)?)),
            B3Command::ReadProjectImage => Ok(B3Result::ReadProjectImage(decode(result)?)),
            B3Command::WriteClipboardText => Ok(B3Result::WriteClipboardText(decode(result)?)),
            B3Command::GetAbout => Ok(B3Result::GetAbout(decode(result)?)),
            B3Command::GetDiagnostics => Ok(B3Result::GetDiagnostics(decode(result)?)),
            B3Command::RenderRichText => Ok(B3Result::RenderRichText(decode(result)?)),
            B3Command::ReadImageContent => Ok(B3Result::ReadImageContent(decode(result)?)),
        }
    }

    pub fn validated_b3_result_value(&self, command: B3Command) -> Result<Value, ProtocolError> {
        let _ = self.decode_b3_result(command)?;
        self.b3_result_value()
    }

    fn b3_result_value(&self) -> Result<Value, ProtocolError> {
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
        reason: format!("invalid B3 result: {}", reason.into()),
    }
}

#[cfg(test)]
mod tests {
    use ciborium::ser::into_writer;
    use serde_json::json;

    use super::*;

    fn response(result: serde_json::Value) -> ServerMessage {
        let raw: ciborium::value::Value = serde_json::from_value(json!({
            "type": "response", "id": "b3", "ok": true, "result": result,
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
                .validated_b3_result_value(B3Command::GetAbout)
                .unwrap(),
            about
        );
        assert!(
            response(json!({"productName":"LYStar Code"}))
                .validated_b3_result_value(B3Command::GetAbout)
                .is_err()
        );
        assert!(
            response(json!({"checks":[], "extra":true}))
                .validated_b3_result_value(B3Command::GetDiagnostics)
                .is_err()
        );
    }

    #[test]
    fn recognizes_only_declared_b3_commands() {
        assert_eq!(
            B3Command::from_wire("list_skills"),
            Some(B3Command::ListSkills)
        );
        assert_eq!(
            B3Command::from_wire("check_for_updates"),
            Some(B3Command::CheckForUpdates)
        );
        assert_eq!(B3Command::from_wire("get_about"), Some(B3Command::GetAbout));
        assert_eq!(
            B3Command::from_wire("get_diagnostics"),
            Some(B3Command::GetDiagnostics)
        );
        assert!(B3Command::from_wire("list_sessions").is_none());
    }
}
