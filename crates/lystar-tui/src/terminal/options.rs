use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalMode {
    Auto,
    Fullscreen,
    Regular,
}

impl TerminalMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "fullscreen" => Some(Self::Fullscreen),
            "regular" => Some(Self::Regular),
            _ => None,
        }
    }

    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Fullscreen => "fullscreen",
            Self::Regular => "regular",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitOutput {
    Transcript,
    ResumeHint,
}

impl ExitOutput {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "transcript" => Some(Self::Transcript),
            "resume-hint" => Some(Self::ResumeHint),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunOptions {
    pub mode: TerminalMode,
    pub exit_output: ExitOutput,
}

impl Default for RunOptions {
    fn default() -> Self {
        Self {
            mode: TerminalMode::Auto,
            exit_output: ExitOutput::Transcript,
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct TerminalModeContext {
    pub(super) stdout_tty: bool,
    pub(super) stdin_tty: bool,
    pub(super) term: Option<String>,
    pub(super) env_mode: Option<TerminalMode>,
}

pub(super) fn terminal_mode_context() -> TerminalModeContext {
    TerminalModeContext {
        stdout_tty: io::stdout().is_terminal(),
        stdin_tty: io::stdin().is_terminal(),
        term: std::env::var("TERM").ok(),
        env_mode: std::env::var("PI_TUI_MODE")
            .ok()
            .as_deref()
            .and_then(TerminalMode::parse),
    }
}

pub(super) fn resolve_terminal_mode(
    requested: TerminalMode,
    context: TerminalModeContext,
) -> TerminalMode {
    if requested != TerminalMode::Auto {
        return requested;
    }
    if let Some(mode @ (TerminalMode::Fullscreen | TerminalMode::Regular)) = context.env_mode {
        return mode;
    }
    let alternate_capable = context
        .term
        .as_deref()
        .is_some_and(|term| !term.is_empty() && term != "dumb");
    if context.stdout_tty && context.stdin_tty && alternate_capable {
        TerminalMode::Fullscreen
    } else {
        TerminalMode::Regular
    }
}

pub(super) fn inline_viewport_height(rows: u16) -> u16 {
    rows.clamp(3, 24)
}

#[derive(Debug, Error)]
pub enum TuiError {
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error("{mode} 模式无法启用终端原始输入：{message}")]
    TerminalSetup { mode: &'static str, message: String },
    #[error("host closed the protocol pipe before hello")]
    ChildEof,
    #[error("host rejected the Rust frontend: {0}")]
    HelloRejected(String),
    #[error("host protocol response is malformed: {0}")]
    InvalidResponse(String),
}

#[derive(Debug)]
pub(super) enum SessionTransition {
    InitialAcquiring {
        id: String,
        path: String,
        generation: u64,
    },
    List {
        id: String,
        selected_path: Option<String>,
    },
    Rename {
        id: String,
        index: usize,
        name: String,
    },
    Name {
        id: String,
        requested_name: String,
    },
    Reload {
        id: String,
    },
    Fork {
        id: String,
        toast: String,
    },
    Import {
        id: String,
        input_path: String,
    },
    Readonly {
        id: String,
        path: String,
        replace: bool,
        generation: u64,
    },
    SwitchReleasing {
        id: String,
        target: SessionSummary,
        restore: SessionRestorePoint,
    },
    SwitchAcquiring {
        id: String,
        target: SessionSummary,
        restore: SessionRestorePoint,
    },
    SwitchRollback {
        id: String,
        restore: SessionRestorePoint,
        reason: String,
    },
    CreateStarting {
        id: String,
        restore: SessionRestorePoint,
    },
    CreateReleasingOld {
        id: String,
        path: String,
        lease_id: String,
        snapshot: lystar_protocol::SessionSnapshot,
        restore: Box<SessionRestorePoint>,
    },
    CreateCleanup {
        id: String,
        restore: SessionRestorePoint,
        reason: String,
    },
    DeleteReleasing {
        id: String,
        restore: SessionRestorePoint,
        target: Option<SessionSummary>,
    },
    DeleteRemoving {
        id: String,
        restore: SessionRestorePoint,
        target: Option<SessionSummary>,
    },
    DeleteAcquiring {
        id: String,
        target: SessionSummary,
    },
    DeleteRollback {
        id: String,
        restore: SessionRestorePoint,
        reason: String,
    },
    QuitReleasing {
        id: String,
    },
}

pub(super) type SessionFlow = SessionTransition;
