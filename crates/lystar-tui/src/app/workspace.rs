use std::{collections::BTreeMap, time::Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentDescriptor {
    pub parent_session_path: String,
    pub run_id: String,
    pub agent_id: String,
    pub name: String,
    pub source: String,
    pub task: String,
    pub state: String,
    pub current_action: Option<String>,
    pub started_at: u64,
    pub updated_at: u64,
    pub elapsed_ms: u64,
    pub controllable: bool,
    pub session_file: Option<String>,
    pub session_cwd: Option<String>,
}

pub fn merge_subagents(
    committed: impl IntoIterator<Item = SubagentDescriptor>,
    live: impl IntoIterator<Item = SubagentDescriptor>,
) -> Vec<SubagentDescriptor> {
    let mut merged = BTreeMap::new();
    for snapshot in committed {
        merged.insert(
            (snapshot.run_id.clone(), snapshot.agent_id.clone()),
            snapshot,
        );
    }
    for snapshot in live {
        merged.insert(
            (snapshot.run_id.clone(), snapshot.agent_id.clone()),
            snapshot,
        );
    }
    let mut snapshots = merged.into_values().collect::<Vec<_>>();
    snapshots.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.run_id.cmp(&right.run_id))
            .then_with(|| left.agent_id.cmp(&right.agent_id))
    });
    snapshots
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingDescriptor {
    pub id: String,
    pub label: String,
    pub description: String,
    pub kind: String,
    pub value: serde_json::Value,
    pub display_value: String,
    pub options: Vec<String>,
    pub minimum: Option<i64>,
    pub maximum: Option<i64>,
    pub scope: String,
    pub read_only: bool,
    pub restart_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelDescriptor {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub reasoning: bool,
    pub input: Vec<String>,
    pub context_window: u64,
    pub configured: bool,
    pub supported_thinking_levels: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderDescriptor {
    pub id: String,
    pub name: String,
    pub configured: bool,
    pub auth_methods: Vec<String>,
    pub auth_source: Option<String>,
    pub model_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitFileDescriptor {
    pub path: String,
    pub original_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ChangesTab {
    Staged,
    Unstaged,
    #[default]
    All,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitStatusDescriptor {
    pub root: String,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
    pub files: Vec<GitFileDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitDiffDescriptor {
    pub path: Option<String>,
    pub staged: bool,
    pub diff: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillDescriptor {
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: String,
    pub scope: String,
    pub enabled: bool,
    pub eligible: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstructionDescriptor {
    pub path: String,
    pub file_name: String,
    pub exists: bool,
    pub active: bool,
    pub editable: bool,
    pub content: Option<String>,
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectTrustDescriptor {
    pub cwd: String,
    pub trusted: Option<bool>,
    pub reason: String,
    pub resource_risk: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageDescriptor {
    pub source: String,
    pub scope: String,
    pub filtered: bool,
    pub installed_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateDescriptor {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub status: String,
    pub url: Option<String>,
    pub note: Option<String>,
    pub install_blocked_reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceOverlayGeneration {
    pub key: String,
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSummary {
    pub path: String,
    pub id: String,
    pub cwd: String,
    pub name: Option<String>,
    pub updated_at: u64,
    pub first_message: String,
    pub activity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingSessionImport {
    pub input_path: String,
    pub cwd_override: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionTreeNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub label: Option<String>,
    pub timestamp: String,
    pub preview: String,
    pub is_leaf: bool,
    pub depth: usize,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkbenchTarget {
    Settings,
    Model,
    Thinking,
    Login,
    Sessions,
    Tree,
    Changes,
    Skills,
    Trust,
    InstructionsProject,
    InstructionsHost,
    Packages,
    Update,
    Subagents,
    Clipboard,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TreeFilter {
    #[default]
    Default,
    NoTools,
    UserOnly,
    LabeledOnly,
    All,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceRequest {
    pub command: lystar_protocol::WorkspaceCommand,
    pub payload: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingIntent {
    Overlay {
        target: String,
    },
    ChangeDetail,
    SkillMutation {
        selected_key: String,
        filter: String,
    },
    TrustMutation,
    InstructionMutation {
        target: WorkbenchTarget,
        selected_key: String,
        filter: String,
    },
    PackageMutation {
        selected_key: Option<String>,
        filter: String,
        toast: String,
    },
    SubagentRead {
        parent_session_path: String,
        selected_key: String,
        filter: String,
    },
    SubagentMutation {
        parent_session_path: String,
        selected_key: String,
        filter: String,
        toast: String,
    },
    ClipboardRead {
        insert: bool,
    },
    ClipboardBothText {
        generation: u64,
    },
    ClipboardBothImage {
        generation: u64,
    },
    AttachCompletion {
        text: String,
    },
    ProjectImage {
        source: String,
    },
    ClipboardImage,
    ClipboardMutation {
        toast: String,
    },
    CopyLastAssistantMessage,
    Export,
    Changelog,
    SessionInfo,
    ForkMessages,
    WorkbenchLoad {
        target: WorkbenchTarget,
        selected_key: Option<String>,
        filter: String,
    },
    SettingMutation {
        selected_key: String,
        filter: String,
    },
    ModelMutation {
        session_path: String,
        provider: String,
        id: String,
    },
    ThinkingMutation {
        session_path: String,
        provider: String,
        id: String,
        level: String,
    },
    TreeMutation {
        selected_key: String,
        filter: String,
    },
    TreeNavigate {
        selected_key: String,
        filter: String,
    },
    AuthMutation {
        selected_key: Option<String>,
        filter: String,
        toast: String,
    },
}

#[derive(Debug, Clone)]
pub struct PendingRequest {
    pub intent: PendingIntent,
    pub workspace: Option<WorkspaceOverlayGeneration>,
    pub request: WorkspaceRequest,
    pub started_at: Instant,
}
