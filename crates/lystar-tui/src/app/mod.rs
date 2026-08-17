mod composer;
mod extension;
mod live_bash;
mod live_compaction;
mod live_diff;
mod live_retry;
mod live_stream;
mod live_tools;
mod overlay;
mod search;
mod state;
mod transcript;
mod transcript_tools;
mod workspace;

pub use composer::*;
pub use extension::*;
pub use live_compaction::*;
pub use live_retry::*;
pub use live_tools::*;
pub use overlay::*;
pub use search::*;
pub use state::*;
pub use transcript::*;
pub use workspace::*;

pub const ROUND_CACHE_LIMIT: usize = 400;
pub const ITEM_CACHE_LIMIT: usize = 800;
pub const UTF8_CACHE_LIMIT: usize = 4 * 1024 * 1024;
pub const WORKSPACE_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

#[cfg(test)]
mod bash_tests;
#[cfg(test)]
mod compact_tests;
#[cfg(test)]
mod diff_tests;
#[cfg(test)]
mod retry_tests;
#[cfg(test)]
mod tests;
