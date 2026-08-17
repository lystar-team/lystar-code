use serde::Deserialize;
use serde_json::Value;

use crate::{ProtocolError, ServerMessage};

pub const MAX_PROGRESS_PREVIEW_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub href: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptImage {
    pub content_ref: String,
    pub mime_type: String,
    pub byte_length: u64,
    pub alt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDiffFile {
    pub path: Option<String>,
    pub operation: Option<String>,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub diff: Option<String>,
    pub truncated: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ToolDiff {
    pub files: Vec<ToolDiffFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TranscriptViewItem {
    User {
        text: String,
        images: Option<Vec<TranscriptImage>>,
    },
    Assistant {
        text: String,
        images: Option<Vec<TranscriptImage>>,
    },
    Thinking {
        text: String,
    },
    ToolCall {
        calls: Vec<ToolCall>,
    },
    ToolResult {
        #[serde(rename = "callId")]
        call_id: String,
        name: String,
        status: String,
        summary: String,
        detail: Option<String>,
        #[serde(rename = "contentRef")]
        content_ref: Option<String>,
        diff: Option<ToolDiff>,
        images: Option<Vec<TranscriptImage>>,
    },
    Bash {
        text: String,
    },
    Custom {
        text: String,
    },
    Summary {
        title: String,
        text: String,
    },
    System {
        text: String,
    },
}

impl TranscriptViewItem {
    pub fn utf8_len(&self) -> usize {
        match self {
            Self::User { text, images } | Self::Assistant { text, images } => {
                text.len() + images.as_deref().map_or(0, image_utf8_len)
            }
            Self::Thinking { text }
            | Self::Bash { text }
            | Self::Custom { text }
            | Self::System { text } => text.len(),
            Self::ToolCall { calls } => calls
                .iter()
                .map(|call| {
                    call.id.len()
                        + call.name.len()
                        + call.summary.len()
                        + call.href.as_ref().map_or(0, String::len)
                })
                .sum(),
            Self::ToolResult {
                call_id,
                name,
                status,
                summary,
                detail,
                content_ref,
                diff,
                images,
            } => {
                call_id.len()
                    + name.len()
                    + status.len()
                    + summary.len()
                    + detail.as_ref().map_or(0, String::len)
                    + content_ref.as_ref().map_or(0, String::len)
                    + diff.as_ref().map_or(0, tool_diff_utf8_len)
                    + images.as_deref().map_or(0, image_utf8_len)
            }
            Self::Summary { title, text } => title.len() + text.len(),
        }
    }
}

fn tool_diff_utf8_len(diff: &ToolDiff) -> usize {
    diff.files
        .iter()
        .map(|file| {
            file.path.as_ref().map_or(0, String::len)
                + file.operation.as_ref().map_or(0, String::len)
                + file.additions.map_or(0, |value| value.to_string().len())
                + file.deletions.map_or(0, |value| value.to_string().len())
                + file.diff.as_ref().map_or(0, String::len)
                + usize::from(file.truncated.unwrap_or(false))
        })
        .sum()
}

fn image_utf8_len(images: &[TranscriptImage]) -> usize {
    images
        .iter()
        .map(|image| {
            image.content_ref.len()
                + image.mime_type.len()
                + image.byte_length.to_string().len()
                + image.alt.as_ref().map_or(0, String::len)
        })
        .sum()
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptItem {
    pub entry_id: String,
    pub timestamp: String,
    pub view: TranscriptViewItem,
}

impl TranscriptItem {
    pub fn utf8_len(&self) -> usize {
        self.entry_id.len() + self.timestamp.len() + self.view.utf8_len()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptRequestContext {
    pub generation: Option<String>,
    pub revision: Option<u64>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPage {
    pub items: Vec<TranscriptItem>,
    pub previous_cursor: Option<String>,
    pub has_more_previous: bool,
    pub transcript_generation: String,
    pub transcript_revision: u64,
    pub complete: bool,
    pub request_context: Option<TranscriptRequestContext>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSearchHit {
    pub entry_id: String,
    pub kind: String,
    pub timestamp: String,
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSearchResult {
    pub generation: String,
    pub transcript_revision: u64,
    pub complete: bool,
    pub hits: Vec<TranscriptSearchHit>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageProgress {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub elapsed_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionProgress {
    AssistantDelta {
        text: String,
    },
    ThinkingDelta {
        text: String,
    },
    ToolStart {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        name: String,
        summary: Option<String>,
        diff: Option<ToolDiff>,
    },
    ToolUpdate {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        name: String,
        summary: String,
        diff: Option<ToolDiff>,
    },
    ToolEnd {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        name: String,
        status: String,
        summary: String,
        diff: Option<ToolDiff>,
    },
    QueueUpdate {
        #[serde(rename = "steeringCount")]
        steering_count: u64,
        #[serde(rename = "followUpCount")]
        follow_up_count: u64,
    },
    Phase {
        phase: String,
    },
    Compaction {
        status: String,
        reason: String,
        error: Option<String>,
    },
    Retry {
        status: String,
        kind: String,
        attempt: Option<u64>,
        #[serde(rename = "maxAttempts")]
        max_attempts: Option<u64>,
        #[serde(rename = "delayMs")]
        delay_ms: Option<u64>,
        error: Option<String>,
    },
    Status {
        status: String,
        truncated: Option<bool>,
    },
    Usage {
        usage: UsageProgress,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub id: String,
    pub path: String,
    pub cwd: String,
    pub phase: String,
    pub activity: String,
    pub thinking_level: String,
    pub attached: bool,
    pub write_access: String,
    pub revision: u64,
    pub queued_steer_count: u64,
    pub queued_follow_up_count: u64,
    pub transcript_generation: String,
    pub transcript_revision: u64,
    pub model: Option<ModelRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ModelRef {
    pub provider: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationSnapshot {
    pub operation_id: String,
    pub client_instance_id: String,
    pub client_request_id: String,
    pub session_path: String,
    #[serde(rename = "type")]
    pub operation_type: String,
    pub status: String,
    pub progress: Option<SessionProgress>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadOnlyResponse {
    TranscriptPage {
        id: String,
        page: TranscriptPage,
    },
    SearchResult {
        id: String,
        result: TranscriptSearchResult,
    },
    SessionLease {
        id: String,
        lease_id: String,
        snapshot: SessionSnapshot,
    },
    Operation {
        id: String,
        operation: OperationSnapshot,
        duplicate: bool,
    },
    Error {
        id: String,
        message: String,
    },
    Other {
        id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadOnlyEvent {
    SessionSnapshot {
        snapshot: SessionSnapshot,
    },
    TranscriptChanged {
        session_path: String,
    },
    TranscriptCommitted {
        session_path: String,
        transcript_generation: String,
        from_revision: u64,
        to_revision: u64,
        items: Vec<TranscriptItem>,
    },
    SessionProgress {
        session_path: String,
        progress: SessionProgress,
    },
    OperationUpdated {
        operation: OperationSnapshot,
    },
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadOnlyMessage {
    Hello,
    HelloError { message: String },
    Response(ReadOnlyResponse),
    Event(ReadOnlyEvent),
}

impl ServerMessage {
    pub fn read_only(&self) -> Result<ReadOnlyMessage, ProtocolError> {
        let raw = self.json()?;
        match required_text(&raw, &["type"])? {
            "hello" => Ok(ReadOnlyMessage::Hello),
            "hello_error" => Ok(ReadOnlyMessage::HelloError {
                message: required_text(&raw, &["error", "message"])?.to_owned(),
            }),
            "response" if required_bool(&raw, &["ok"])? => parse_response(&raw),
            "response" => Ok(ReadOnlyMessage::Response(ReadOnlyResponse::Error {
                id: required_text(&raw, &["id"])?.to_owned(),
                message: required_text(&raw, &["error", "message"])?.to_owned(),
            })),
            "event" => parse_event(&raw),
            _ => Err(invalid_projection(&["type"])),
        }
    }
}

fn parse_response(raw: &Value) -> Result<ReadOnlyMessage, ProtocolError> {
    let id = required_text(raw, &["id"])?.to_owned();
    let result = required_value(raw, &["result"])?;
    if result.get("items").is_some() {
        return Ok(ReadOnlyMessage::Response(
            ReadOnlyResponse::TranscriptPage {
                id,
                page: parse_projection(result)?,
            },
        ));
    }
    if result.get("hits").is_some() {
        return Ok(ReadOnlyMessage::Response(ReadOnlyResponse::SearchResult {
            id,
            result: parse_projection(result)?,
        }));
    }
    if let (Some(lease), Some(snapshot)) = (result.get("lease"), result.get("snapshot")) {
        return Ok(ReadOnlyMessage::Response(ReadOnlyResponse::SessionLease {
            id,
            lease_id: required_text(lease, &["leaseId"])?.to_owned(),
            snapshot: parse_projection(snapshot)?,
        }));
    }
    if let Some(operation) = result.get("operation") {
        return Ok(ReadOnlyMessage::Response(ReadOnlyResponse::Operation {
            id,
            operation: parse_projection(operation)?,
            duplicate: result
                .get("duplicate")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }));
    }
    Ok(ReadOnlyMessage::Response(ReadOnlyResponse::Other { id }))
}

fn parse_event(raw: &Value) -> Result<ReadOnlyMessage, ProtocolError> {
    let event = required_value(raw, &["event"])?;
    let parsed = match required_text(event, &["type"])? {
        "session_snapshot" => ReadOnlyEvent::SessionSnapshot {
            snapshot: parse_projection(required_value(event, &["snapshot"])?)?,
        },
        "transcript_changed" => ReadOnlyEvent::TranscriptChanged {
            session_path: required_text(event, &["sessionPath"])?.to_owned(),
        },
        "transcript_committed" => ReadOnlyEvent::TranscriptCommitted {
            session_path: required_text(event, &["sessionPath"])?.to_owned(),
            transcript_generation: required_text(event, &["transcriptGeneration"])?.to_owned(),
            from_revision: required_u64(event, &["fromRevision"])?,
            to_revision: required_u64(event, &["toRevision"])?,
            items: parse_projection(required_value(event, &["items"])?)?,
        },
        "session_progress" => ReadOnlyEvent::SessionProgress {
            session_path: required_text(event, &["sessionPath"])?.to_owned(),
            progress: parse_projection(required_value(event, &["progress"])?)?,
        },
        "operation_updated" => ReadOnlyEvent::OperationUpdated {
            operation: parse_projection(required_value(event, &["operation"])?)?,
        },
        _ => ReadOnlyEvent::Other,
    };
    Ok(ReadOnlyMessage::Event(parsed))
}

fn required_value<'a>(value: &'a Value, path: &[&str]) -> Result<&'a Value, ProtocolError> {
    let mut current = value;
    for key in path {
        current = current.get(*key).ok_or_else(|| invalid_projection(path))?;
    }
    Ok(current)
}
fn required_text<'a>(value: &'a Value, path: &[&str]) -> Result<&'a str, ProtocolError> {
    required_value(value, path)?
        .as_str()
        .ok_or_else(|| invalid_projection(path))
}
fn required_bool(value: &Value, path: &[&str]) -> Result<bool, ProtocolError> {
    required_value(value, path)?
        .as_bool()
        .ok_or_else(|| invalid_projection(path))
}
fn required_u64(value: &Value, path: &[&str]) -> Result<u64, ProtocolError> {
    required_value(value, path)?
        .as_u64()
        .ok_or_else(|| invalid_projection(path))
}
fn parse_projection<T: for<'de> Deserialize<'de>>(value: &Value) -> Result<T, ProtocolError> {
    serde_json::from_value(value.clone()).map_err(|error| ProtocolError::InvalidMessage {
        direction: "server",
        reason: error.to_string(),
    })
}
fn invalid_projection(path: &[&str]) -> ProtocolError {
    ProtocolError::InvalidMessage {
        direction: "server",
        reason: format!("missing or invalid projection field {}", path.join(".")),
    }
}
