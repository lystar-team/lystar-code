use super::*;

pub(super) fn apply_content_response(
    app: &mut AppState,
    message: &ServerMessage,
    raw: &serde_json::Value,
) -> Result<Option<bool>, TuiError> {
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("response")
        && let Some(id) = raw.get("id").and_then(serde_json::Value::as_str)
        && let Some(pending) = app.take_image_request(id)
    {
        if pending.generation != app.image_generation {
            return Ok(Some(false));
        }
        if raw.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
            app.mark_image_failed(pending.content_ref);
            app.transcript.status = "图片读取失败，已保留占位".to_owned();
            return Ok(Some(false));
        }
        let result =
            message.validated_workspace_result_value(WorkspaceCommand::ReadImageContent)?;
        let object = result
            .as_object()
            .ok_or_else(|| TuiError::InvalidResponse("图片响应无效".to_owned()))?;
        let content_ref = object
            .get("contentRef")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| TuiError::InvalidResponse("图片响应缺少引用".to_owned()))?;
        let mime_type = object
            .get("mimeType")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| TuiError::InvalidResponse("图片响应缺少 MIME".to_owned()))?;
        let byte_length = object
            .get("byteLength")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| TuiError::InvalidResponse("图片响应缺少长度".to_owned()))?;
        let data = object
            .get("data")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| TuiError::InvalidResponse("图片响应缺少数据".to_owned()))?;
        if content_ref != pending.content_ref
            || !mime_type.starts_with("image/")
            || byte_length > 4 * 1024 * 1024
        {
            app.mark_image_failed(pending.content_ref);
            app.transcript.status = "图片数据无效，已保留占位".to_owned();
            return Ok(Some(false));
        }
        app.image_cache.insert(CachedImage {
            content_ref: content_ref.to_owned(),
            mime_type: mime_type.to_owned(),
            byte_length: usize::try_from(byte_length).unwrap_or(usize::MAX),
            base64: data.to_owned(),
        });
        return Ok(Some(false));
    }
    if raw.get("type").and_then(serde_json::Value::as_str) == Some("response")
        && let Some(id) = raw.get("id").and_then(serde_json::Value::as_str)
        && let Some(pending) = app.take_rich_text_request(id)
    {
        if pending.generation != app.rich_text_generation {
            return Ok(Some(false));
        }
        if raw.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
            app.mark_rich_text_failed(pending.key);
            app.transcript.status = "富文本渲染失败，已保留纯文本".to_owned();
            return Ok(Some(false));
        }
        let result = message.validated_workspace_result_value(WorkspaceCommand::RenderRichText)?;
        let object = result
            .as_object()
            .ok_or_else(|| TuiError::InvalidResponse("富文本响应无效".to_owned()))?;
        let content_hash = object
            .get("contentHash")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| TuiError::InvalidResponse("富文本响应缺少内容哈希".to_owned()))?;
        if content_hash != pending.key.content_hash {
            app.mark_rich_text_failed(pending.key);
            return Ok(Some(false));
        }
        let lines = object
            .get("lines")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| TuiError::InvalidResponse("富文本响应缺少行".to_owned()))?
            .iter()
            .map(|line| {
                line.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| TuiError::InvalidResponse("富文本行无效".to_owned()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        app.rich_text_cache
            .insert(pending.key, crate::rich_text::parse_ansi_lines(&lines));
        return Ok(Some(false));
    }
    Ok(None)
}
