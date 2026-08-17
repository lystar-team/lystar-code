mod composer;
mod extension;
mod overlay;
mod state;
mod transcript;
mod workspace;

pub use composer::*;
pub use extension::*;
pub use overlay::*;
pub use state::*;
pub use transcript::*;
pub use workspace::*;

pub const ROUND_CACHE_LIMIT: usize = 400;
pub const ITEM_CACHE_LIMIT: usize = 800;
pub const UTF8_CACHE_LIMIT: usize = 4 * 1024 * 1024;
pub const WORKSPACE_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

#[cfg(test)]
mod tests;
