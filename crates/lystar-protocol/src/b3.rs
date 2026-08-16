use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::{ClientMessage, ProtocolError, ServerMessage};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum B3Command {
    ListSettings,
    SetSetting,
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
    WriteClipboardText,
}

impl B3Command {
    pub fn from_wire(command: &str) -> Option<Self> {
        Some(match command {
            "list_settings" => Self::ListSettings,
            "set_setting" => Self::SetSetting,
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
            "write_clipboard_text" => Self::WriteClipboardText,
            _ => return None,
        })
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
    ListSettings(Box<crate::generated::B3ListSettingsResult>),
    SetSetting(Box<crate::generated::B3SetSettingResult>),
    GetProjectTrust(Box<crate::generated::B3GetProjectTrustResult>),
    SetProjectTrust(Box<crate::generated::B3SetProjectTrustResult>),
    ListPackages(Box<crate::generated::B3ListPackagesResult>),
    InstallPackage(Box<crate::generated::B3InstallPackageResult>),
    RemovePackage(Box<crate::generated::B3RemovePackageResult>),
    UpdatePackages(Box<crate::generated::B3UpdatePackagesResult>),
    GetSessionTree(Box<crate::generated::B3GetSessionTreeResult>),
    SetEntryLabel(Box<crate::generated::B3SetEntryLabelResult>),
    NavigateSessionTree(Box<crate::generated::B3NavigateSessionTreeResult>),
    ListSubagents(Box<crate::generated::B3ListSubagentsResult>),
    ReadSubagent(Box<crate::generated::B3ReadSubagentResult>),
    AbortSubagent(Box<crate::generated::B3AbortSubagentResult>),
    ContinueSubagent(Box<crate::generated::B3ContinueSubagentResult>),
    ReadClipboardText(Box<crate::generated::B3ReadClipboardTextResult>),
    WriteClipboardText(Box<crate::generated::B3WriteClipboardTextResult>),
}

impl ServerMessage {
    pub fn decode_b3_result(&self, command: B3Command) -> Result<B3Result, ProtocolError> {
        let raw = self.json()?;
        if raw.get("type").and_then(Value::as_str) != Some("response")
            || raw.get("ok").and_then(Value::as_bool) != Some(true)
        {
            return Err(invalid_result("expected a successful response"));
        }
        let result = raw
            .get("result")
            .ok_or_else(|| invalid_result("missing result"))?
            .clone();
        match command {
            B3Command::ListSettings => Ok(B3Result::ListSettings(decode(result)?)),
            B3Command::SetSetting => Ok(B3Result::SetSetting(decode(result)?)),
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
            B3Command::WriteClipboardText => Ok(B3Result::WriteClipboardText(decode(result)?)),
        }
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
    fn decodes_every_b3_result_against_its_command_schema() {
        let setting = json!({"id":"autocompact","label":"自动压缩","kind":"boolean","value":true,"scope":"global","readOnly":false,"restartRequired":false});
        let cases = [
            (B3Command::ListSettings, json!([setting.clone()])),
            (
                B3Command::SetSetting,
                json!({"setting":setting,"requiresRestart":false}),
            ),
            (
                B3Command::GetProjectTrust,
                json!({"cwd":"/tmp","trusted":true}),
            ),
            (
                B3Command::SetProjectTrust,
                json!({"cwd":"/tmp","trusted":false}),
            ),
            (B3Command::ListPackages, json!([])),
            (
                B3Command::InstallPackage,
                json!({"changed":true,"message":"ok"}),
            ),
            (
                B3Command::RemovePackage,
                json!({"changed":false,"message":"ok"}),
            ),
            (
                B3Command::UpdatePackages,
                json!({"changed":true,"message":"ok"}),
            ),
            (B3Command::GetSessionTree, json!([])),
            (B3Command::SetEntryLabel, json!({"changed":true})),
            (B3Command::NavigateSessionTree, json!({"cancelled":false})),
            (B3Command::ListSubagents, json!([])),
            (B3Command::ReadSubagent, json!({})),
            (
                B3Command::AbortSubagent,
                json!({"changed":true,"message":"ok"}),
            ),
            (
                B3Command::ContinueSubagent,
                json!({"changed":true,"message":"ok"}),
            ),
            (B3Command::ReadClipboardText, json!({"capability":true})),
            (
                B3Command::WriteClipboardText,
                json!({"capability":true,"changed":true}),
            ),
        ];
        for (command, result) in cases {
            assert!(response(result).decode_b3_result(command).is_ok());
        }
    }

    #[test]
    fn rejects_missing_and_unknown_b3_result_fields() {
        assert!(
            response(json!({"changed":true}))
                .decode_b3_result(B3Command::InstallPackage)
                .is_err()
        );
        assert!(
            response(json!({"capability":true,"changed":true,"extra":true}))
                .decode_b3_result(B3Command::WriteClipboardText)
                .is_err()
        );
    }
}
