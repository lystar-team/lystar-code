use super::*;

pub(super) fn request_session_info(
    app: &mut AppState,
    pipe: &mut ProtocolPipe,
    session_path: &str,
    sequence: &mut u64,
) -> Result<(), TuiError> {
    let Some(lease_id) = app.lease_id.clone() else {
        app.set_overlay_error("尚未获取会话租约");
        return Ok(());
    };
    app.open_workspace_overlay(
        "session",
        OverlayState::Detail(DetailOverlay {
            title: "会话信息".to_owned(),
            lines: vec!["正在读取会话信息".to_owned()],
            scroll: 0,
            status: "请稍候".to_owned(),
            link: None,
            copy_text: None,
        }),
    );
    request_workspace(
        app,
        pipe,
        sequence,
        WorkspaceCommand::GetSessionInfo,
        serde_json::json!({ "sessionPath": session_path, "leaseId": lease_id })
            .as_object()
            .cloned()
            .unwrap_or_default(),
        PendingIntent::SessionInfo,
    )
}

pub(super) fn apply_session_info(
    app: &mut AppState,
    result: serde_json::Value,
) -> Result<(), TuiError> {
    let object = result
        .as_object()
        .ok_or_else(|| TuiError::InvalidResponse("会话信息响应无效".to_owned()))?;
    let messages = required_object(object, "messages")?;
    let tokens = required_object(object, "tokens")?;
    let cache_waste = required_object(object, "cacheWaste")?;
    let input = required_u64(tokens, "input")?;
    let cache_read = required_u64(tokens, "cacheRead")?;
    let cache_write = required_u64(tokens, "cacheWrite")?;
    let prompt_tokens = input
        .checked_add(cache_read)
        .and_then(|total| total.checked_add(cache_write))
        .ok_or_else(|| TuiError::InvalidResponse("Token 统计超出范围".to_owned()))?;
    let cost = required_f64(object, "cost")?;
    let missed_tokens = required_u64(cache_waste, "missedTokens")?;
    let missed_cost = required_f64(cache_waste, "missedCost")?;

    let mut lines = Vec::new();
    if let Some(name) = optional_string(object, "name")?
        && !name.is_empty()
    {
        lines.push(format!("名称： {name}"));
    }
    lines.push(format!(
        "文件： {}",
        optional_string(object, "sessionFile")?.unwrap_or_else(|| "仅存于内存".to_owned())
    ));
    lines.push(format!("ID： {}", required_string(object, "sessionId")?));
    lines.push(String::new());
    lines.push("消息".to_owned());
    lines.push(format!("总数： {}", required_u64(messages, "total")?));
    lines.push(format!("用户： {}", required_u64(messages, "user")?));
    lines.push(format!("Agent： {}", required_u64(messages, "agent")?));
    lines.push(format!(
        "工具： {} 次调用，{} 次返回",
        required_u64(messages, "toolCalls")?,
        required_u64(messages, "toolResults")?
    ));
    lines.push(String::new());
    lines.push("Token 用量（会话累计）".to_owned());
    lines.push(format!("输入： {}", format_count(prompt_tokens)));
    if prompt_tokens > 0 && (cache_read > 0 || cache_write > 0) {
        lines.push(format!(
            "  缓存命中： {} （{:.1}%）",
            format_count(cache_read),
            cache_read as f64 / prompt_tokens as f64 * 100.0
        ));
        let written = if cache_write > 0 {
            format!(" （写入缓存 {}）", format_count(cache_write))
        } else {
            String::new()
        };
        lines.push(format!(
            "  未缓存： {}{written}",
            format_count(input.saturating_add(cache_write))
        ));
    }
    lines.push(format!(
        "输出： {}",
        format_count(required_u64(tokens, "output")?)
    ));
    lines.push(format!(
        "合计： {}",
        format_count(required_u64(tokens, "total")?)
    ));

    if cost > 0.0 || missed_tokens > 0 {
        lines.push(String::new());
        lines.push("费用".to_owned());
        lines.push(format!("合计： ${cost:.3}"));
        let breakdown = object
            .get("usageBreakdown")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| TuiError::InvalidResponse("会话信息缺少 usageBreakdown".to_owned()))?;
        if breakdown.len() > 1 {
            for entry in breakdown {
                let entry = entry
                    .as_object()
                    .ok_or_else(|| TuiError::InvalidResponse("会话费用明细无效".to_owned()))?;
                lines.push(format!(
                    "  {}: ${:.3} （{} Token）",
                    required_string(entry, "key")?,
                    required_f64(entry, "cost")?,
                    format_tokens(required_u64(entry, "tokens")?)
                ));
            }
        }
        if missed_tokens > 0 {
            let detail = format!(
                "{} Token，{} 次未命中",
                format_count(missed_tokens),
                required_u64(cache_waste, "missCount")?
            );
            lines.push(if missed_cost >= 0.0001 {
                format!("Cache 重复计费： ${missed_cost:.3} （{detail}）")
            } else {
                format!("Cache 重复计费： {detail}")
            });
        }
    }

    app.replace_overlay(OverlayState::Detail(DetailOverlay {
        title: "会话信息".to_owned(),
        lines,
        scroll: 0,
        status: "Esc 返回".to_owned(),
        link: None,
        copy_text: None,
    }));
    Ok(())
}

fn required_object<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<&'a serde_json::Map<String, serde_json::Value>, TuiError> {
    object
        .get(key)
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| TuiError::InvalidResponse(format!("会话信息缺少 {key}")))
}

fn optional_string(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<Option<String>, TuiError> {
    match object.get(key) {
        Some(serde_json::Value::String(value)) => Ok(Some(value.clone())),
        Some(serde_json::Value::Null) => Ok(None),
        _ => Err(TuiError::InvalidResponse(format!("会话信息缺少 {key}"))),
    }
}

fn required_f64(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<f64, TuiError> {
    object
        .get(key)
        .and_then(serde_json::Value::as_f64)
        .ok_or_else(|| TuiError::InvalidResponse(format!("会话信息缺少 {key}")))
}

fn format_count(value: u64) -> String {
    let digits = value.to_string();
    let mut result = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, character) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            result.push(',');
        }
        result.push(character);
    }
    result
}

pub(super) fn format_tokens(value: u64) -> String {
    if value < 1_000 {
        return value.to_string();
    }
    let (divisor, unit) = if value < 1_000_000 {
        (1_000.0, "K")
    } else if value < 1_000_000_000 {
        (1_000_000.0, "M")
    } else {
        (1_000_000_000.0, "B")
    };
    let scaled = value as f64 / divisor;
    let precision = if scaled < 10.0 {
        2
    } else if scaled < 100.0 {
        1
    } else {
        0
    };
    let formatted = if precision == 0 {
        format!("{scaled:.0}")
    } else {
        format!("{scaled:.precision$}")
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_owned()
    };
    format!("{formatted}{unit}")
}
