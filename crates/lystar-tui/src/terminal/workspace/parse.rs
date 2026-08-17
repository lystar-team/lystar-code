use super::*;

pub(in super::super) fn parse_sessions(
    value: &serde_json::Value,
) -> Result<Vec<SessionSummary>, TuiError> {
    value
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("会话响应不是列表".to_owned()))?
        .iter()
        .map(|entry| {
            let object = entry
                .as_object()
                .ok_or_else(|| TuiError::InvalidResponse("会话条目无效".to_owned()))?;
            Ok(SessionSummary {
                path: required_string(object, "path")?,
                id: required_string(object, "id")?,
                cwd: required_string(object, "cwd")?,
                name: object
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                updated_at: object
                    .get("updatedAt")
                    .and_then(serde_json::Value::as_u64)
                    .ok_or_else(|| TuiError::InvalidResponse("会话缺少 updatedAt".to_owned()))?,
                first_message: required_string(object, "firstMessage")?,
                activity: required_string(object, "activity")?,
            })
        })
        .collect()
}

pub(in super::super) fn parse_git_status(
    value: &serde_json::Value,
) -> Result<GitStatusDescriptor, TuiError> {
    let object = value
        .as_object()
        .ok_or_else(|| TuiError::InvalidResponse("变更响应无效".to_owned()))?;
    let files = object
        .get("files")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| TuiError::InvalidResponse("变更响应缺少 files".to_owned()))?
        .iter()
        .map(|entry| {
            let entry = entry
                .as_object()
                .ok_or_else(|| TuiError::InvalidResponse("变更条目无效".to_owned()))?;
            Ok::<GitFileDescriptor, TuiError>(GitFileDescriptor {
                path: required_string(entry, "path")?,
                original_path: entry
                    .get("originalPath")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                index_status: required_string(entry, "indexStatus")?,
                worktree_status: required_string(entry, "worktreeStatus")?,
                staged: required_bool(entry, "staged")?,
                unstaged: required_bool(entry, "unstaged")?,
                untracked: required_bool(entry, "untracked")?,
                conflicted: required_bool(entry, "conflicted")?,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(GitStatusDescriptor {
        root: required_string(object, "root")?,
        branch: object
            .get("branch")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        upstream: object
            .get("upstream")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        ahead: required_u64(object, "ahead")?,
        behind: required_u64(object, "behind")?,
        files,
    })
}

pub(in super::super) fn parse_git_diff(
    value: &serde_json::Value,
) -> Result<GitDiffDescriptor, TuiError> {
    let object = value
        .as_object()
        .ok_or_else(|| TuiError::InvalidResponse("Diff 响应无效".to_owned()))?;
    Ok(GitDiffDescriptor {
        path: object
            .get("path")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        staged: required_bool(object, "staged")?,
        diff: required_string(object, "diff")?,
        additions: required_u64(object, "additions")?,
        deletions: required_u64(object, "deletions")?,
    })
}

pub(in super::super) fn parse_skills(
    value: &serde_json::Value,
) -> Result<Vec<SkillDescriptor>, TuiError> {
    value
        .get("skills")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| TuiError::InvalidResponse("技能响应缺少 skills".to_owned()))?
        .iter()
        .map(|entry| {
            let entry = entry
                .as_object()
                .ok_or_else(|| TuiError::InvalidResponse("技能条目无效".to_owned()))?;
            Ok(SkillDescriptor {
                name: required_string(entry, "name")?,
                description: required_string(entry, "description")?,
                path: required_string(entry, "path")?,
                source: required_string(entry, "source")?,
                scope: required_string(entry, "scope")?,
                enabled: required_bool(entry, "enabled")?,
                eligible: required_bool(entry, "eligible")?,
            })
        })
        .collect()
}

pub(in super::super) fn parse_instructions(
    value: &serde_json::Value,
) -> Result<Vec<InstructionDescriptor>, TuiError> {
    value
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("指令响应不是列表".to_owned()))?
        .iter()
        .map(|entry| {
            let entry = entry
                .as_object()
                .ok_or_else(|| TuiError::InvalidResponse("指令条目无效".to_owned()))?;
            Ok(InstructionDescriptor {
                path: required_string(entry, "path")?,
                file_name: required_string(entry, "fileName")?,
                exists: required_bool(entry, "exists")?,
                active: required_bool(entry, "active")?,
                editable: required_bool(entry, "editable")?,
                content: entry
                    .get("content")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                content_hash: entry
                    .get("contentHash")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
            })
        })
        .collect()
}

pub(in super::super) fn parse_trust(
    value: &serde_json::Value,
) -> Result<ProjectTrustDescriptor, TuiError> {
    let object = value
        .as_object()
        .ok_or_else(|| TuiError::InvalidResponse("信任响应无效".to_owned()))?;
    Ok(ProjectTrustDescriptor {
        cwd: required_string(object, "cwd")?,
        trusted: match object.get("trusted") {
            Some(serde_json::Value::Bool(value)) => Some(*value),
            Some(serde_json::Value::Null) => None,
            _ => return Err(TuiError::InvalidResponse("信任状态无效".to_owned())),
        },
        reason: required_string(object, "reason")?,
        resource_risk: required_bool(object, "resourceRisk")?,
    })
}

pub(in super::super) fn parse_packages(
    value: &serde_json::Value,
) -> Result<Vec<PackageDescriptor>, TuiError> {
    value
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("包响应不是列表".to_owned()))?
        .iter()
        .map(|entry| {
            let entry = entry
                .as_object()
                .ok_or_else(|| TuiError::InvalidResponse("包条目无效".to_owned()))?;
            Ok(PackageDescriptor {
                source: required_string(entry, "source")?,
                scope: required_string(entry, "scope")?,
                filtered: required_bool(entry, "filtered")?,
                installed_path: entry
                    .get("installedPath")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
            })
        })
        .collect()
}

pub(in super::super) fn parse_update(
    value: &serde_json::Value,
) -> Result<UpdateDescriptor, TuiError> {
    let object = value
        .as_object()
        .ok_or_else(|| TuiError::InvalidResponse("更新响应无效".to_owned()))?;
    Ok(UpdateDescriptor {
        current_version: required_string(object, "currentVersion")?,
        latest_version: object
            .get("latestVersion")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        status: required_string(object, "status")?,
        url: object
            .get("url")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        note: object
            .get("note")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        install_blocked_reason: required_string(object, "installBlockedReason")?,
    })
}

pub(in super::super) fn parse_tree(
    value: &serde_json::Value,
) -> Result<Vec<SessionTreeNode>, TuiError> {
    value
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("分支树响应不是列表".to_owned()))?
        .iter()
        .map(|entry| {
            let object = entry
                .as_object()
                .ok_or_else(|| TuiError::InvalidResponse("分支树条目无效".to_owned()))?;
            Ok(SessionTreeNode {
                id: required_string(object, "id")?,
                parent_id: object
                    .get("parentId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                kind: required_string(object, "kind")?,
                label: object
                    .get("label")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                timestamp: required_string(object, "timestamp")?,
                preview: required_string(object, "preview")?,
                is_leaf: object
                    .get("isLeaf")
                    .and_then(serde_json::Value::as_bool)
                    .ok_or_else(|| TuiError::InvalidResponse("分支树缺少 isLeaf".to_owned()))?,
                depth: usize::try_from(
                    object
                        .get("depth")
                        .and_then(serde_json::Value::as_u64)
                        .ok_or_else(|| TuiError::InvalidResponse("分支树缺少 depth".to_owned()))?,
                )
                .map_err(|_| TuiError::InvalidResponse("分支树 depth 无效".to_owned()))?,
            })
        })
        .collect()
}

pub(in super::super) fn readonly_overlay(view: &ReadonlySessionView) -> OverlayState {
    let mut lines = vec![format!("只读  {}", view.path)];
    if view.search.open {
        lines.push(format!("搜索: {}", view.search.query));
        lines.push(view.search.status.clone());
    }
    lines.extend(view.transcript.rounds().iter().flat_map(|round| {
        let mut lines = vec![round.summary()];
        if round.expanded {
            lines.extend(round.detail_lines());
        }
        lines
    }));
    OverlayState::Detail(DetailOverlay {
        title: "会话只读".to_owned(),
        lines,
        scroll: 0,
        status: if view.search.open {
            "Enter 搜索或跳转  Esc 关闭搜索".to_owned()
        } else {
            format!("只读  {}  Ctrl+F 搜索  Esc 返回", view.status)
        },
        link: None,
        copy_text: None,
    })
}

pub(in super::super) fn parse_settings(
    value: &serde_json::Value,
) -> Result<Vec<SettingDescriptor>, TuiError> {
    value
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("设置响应不是列表".to_owned()))?
        .iter()
        .map(|entry| {
            let object = entry
                .as_object()
                .ok_or_else(|| TuiError::InvalidResponse("设置条目无效".to_owned()))?;
            Ok(SettingDescriptor {
                id: required_string(object, "id")?,
                label: required_string(object, "label")?,
                description: object
                    .get("description")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                kind: required_string(object, "kind")?,
                value: object
                    .get("value")
                    .cloned()
                    .ok_or_else(|| TuiError::InvalidResponse("设置缺少 value".to_owned()))?,
                display_value: required_string(object, "displayValue")?,
                options: object
                    .get("options")
                    .and_then(serde_json::Value::as_array)
                    .map(|options| {
                        options
                            .iter()
                            .filter_map(serde_json::Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default(),
                minimum: object.get("minimum").and_then(serde_json::Value::as_i64),
                maximum: object.get("maximum").and_then(serde_json::Value::as_i64),
                scope: required_string(object, "scope")?,
                read_only: object
                    .get("readOnly")
                    .and_then(serde_json::Value::as_bool)
                    .ok_or_else(|| TuiError::InvalidResponse("设置缺少 readOnly".to_owned()))?,
                restart_required: object
                    .get("restartRequired")
                    .and_then(serde_json::Value::as_bool)
                    .ok_or_else(|| {
                        TuiError::InvalidResponse("设置缺少 restartRequired".to_owned())
                    })?,
            })
        })
        .collect()
}

pub(in super::super) fn parse_models(
    value: &serde_json::Value,
) -> Result<Vec<ModelDescriptor>, TuiError> {
    value
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("模型响应不是列表".to_owned()))?
        .iter()
        .map(|entry| {
            let object = entry
                .as_object()
                .ok_or_else(|| TuiError::InvalidResponse("模型条目无效".to_owned()))?;
            Ok(ModelDescriptor {
                provider: required_string(object, "provider")?,
                id: required_string(object, "id")?,
                name: required_string(object, "name")?,
                reasoning: object
                    .get("reasoning")
                    .and_then(serde_json::Value::as_bool)
                    .ok_or_else(|| TuiError::InvalidResponse("模型缺少 reasoning".to_owned()))?,
                input: required_string_array(object, "input")?,
                context_window: object
                    .get("contextWindow")
                    .and_then(serde_json::Value::as_u64)
                    .ok_or_else(|| {
                        TuiError::InvalidResponse("模型缺少 contextWindow".to_owned())
                    })?,
                configured: object
                    .get("authenticated")
                    .and_then(serde_json::Value::as_bool)
                    .ok_or_else(|| {
                        TuiError::InvalidResponse("模型缺少 authenticated".to_owned())
                    })?,
                supported_thinking_levels: required_string_array(
                    object,
                    "supportedThinkingLevels",
                )?,
            })
        })
        .collect()
}

pub(in super::super) fn parse_providers(
    value: &serde_json::Value,
) -> Result<Vec<ProviderDescriptor>, TuiError> {
    value
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("Provider 响应不是列表".to_owned()))?
        .iter()
        .map(|entry| {
            let object = entry
                .as_object()
                .ok_or_else(|| TuiError::InvalidResponse("Provider 条目无效".to_owned()))?;
            Ok(ProviderDescriptor {
                id: required_string(object, "id")?,
                name: required_string(object, "name")?,
                configured: object
                    .get("authenticated")
                    .and_then(serde_json::Value::as_bool)
                    .ok_or_else(|| {
                        TuiError::InvalidResponse("Provider 缺少 authenticated".to_owned())
                    })?,
                auth_methods: required_string_array(object, "authMethods")?,
                auth_source: object
                    .get("authSource")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                model_count: object
                    .get("modelCount")
                    .and_then(serde_json::Value::as_u64)
                    .ok_or_else(|| {
                        TuiError::InvalidResponse("Provider 缺少 modelCount".to_owned())
                    })?,
            })
        })
        .collect()
}

pub(in super::super) fn parse_subagents(
    value: &serde_json::Value,
    parent_session_path: &str,
) -> Result<Vec<SubagentDescriptor>, TuiError> {
    let snapshots = value
        .as_array()
        .ok_or_else(|| TuiError::InvalidResponse("Subagent 响应不是列表".to_owned()))?
        .iter()
        .map(|entry| parse_subagent(entry, parent_session_path))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(snapshots)
}

pub(in super::super) fn parse_subagent(
    value: &serde_json::Value,
    parent_session_path: &str,
) -> Result<SubagentDescriptor, TuiError> {
    let object = value
        .as_object()
        .ok_or_else(|| TuiError::InvalidResponse("Subagent 条目无效".to_owned()))?;
    let session = object.get("session").and_then(serde_json::Value::as_object);
    Ok(SubagentDescriptor {
        parent_session_path: parent_session_path.to_owned(),
        run_id: required_string(object, "runId")?,
        agent_id: required_string(object, "agentId")?,
        name: required_string(object, "agent")?,
        source: required_string(object, "agentSource")?,
        task: required_string(object, "task")?,
        state: required_string(object, "state")?,
        current_action: object
            .get("currentAction")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        started_at: required_u64(object, "startedAt")?,
        updated_at: required_u64(object, "updatedAt")?,
        elapsed_ms: required_u64(object, "elapsedMs")?,
        controllable: required_bool(object, "controllable")?,
        session_file: session
            .and_then(|value| value.get("sessionFile"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        session_cwd: session
            .and_then(|value| value.get("cwd"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
    })
}

pub(in super::super) fn parse_clipboard(
    value: &serde_json::Value,
) -> Result<ClipboardDescriptor, TuiError> {
    let object = value
        .as_object()
        .ok_or_else(|| TuiError::InvalidResponse("剪贴板响应无效".to_owned()))?;
    Ok(ClipboardDescriptor {
        capability: required_bool(object, "capability")?,
        text: object
            .get("text")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
    })
}

pub(in super::super) fn required_string(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<String, TuiError> {
    object
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| TuiError::InvalidResponse(format!("响应缺少 {key}")))
}

pub(in super::super) fn required_bool(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<bool, TuiError> {
    object
        .get(key)
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| TuiError::InvalidResponse(format!("响应缺少 {key}")))
}

pub(in super::super) fn required_u64(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<u64, TuiError> {
    object
        .get(key)
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| TuiError::InvalidResponse(format!("响应缺少 {key}")))
}

pub(in super::super) fn required_string_array(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<Vec<String>, TuiError> {
    object
        .get(key)
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|value| {
                    value.as_str().map(str::to_owned).ok_or_else(|| {
                        TuiError::InvalidResponse(format!("响应 {key} 包含非字符串"))
                    })
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .ok_or_else(|| TuiError::InvalidResponse(format!("响应缺少 {key}")))?
}

pub(in super::super) fn ui_select_items(payload: &serde_json::Value) -> Vec<OverlayItem> {
    let options = payload
        .get("options")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let items = options
        .into_iter()
        .filter_map(|option| {
            let value = option
                .get("value")
                .and_then(serde_json::Value::as_str)
                .or_else(|| option.get("id").and_then(serde_json::Value::as_str))
                .or_else(|| option.as_str())?;
            let label = option
                .get("label")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(value);
            let detail = option
                .get("description")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            Some(OverlayItem {
                label: label.to_owned(),
                detail: detail.to_owned(),
                action: format!("ui:select:{value}"),
            })
        })
        .collect::<Vec<_>>();
    if items.is_empty() {
        vec![OverlayItem {
            label: "无可选项".to_owned(),
            detail: String::new(),
            action: "ui:select:".to_owned(),
        }]
    } else {
        items
    }
}

pub(in super::super) fn pretty_json_lines(value: &serde_json::Value) -> Vec<String> {
    serde_json::to_string_pretty(value)
        .unwrap_or_else(|_| "无法格式化结果".to_owned())
        .lines()
        .map(str::to_owned)
        .collect()
}
