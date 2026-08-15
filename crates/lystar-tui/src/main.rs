mod terminal;

use std::panic;

fn main() {
    let result = panic::catch_unwind(|| match std::env::args().nth(1).as_deref() {
        Some("--pipe-handshake") => terminal::handshake_inherited_pipes(),
        Some("--shell") => terminal::run_shell(false, false),
        Some("--shell-pipe") => terminal::run_shell(true, false),
        Some("--shell-panic") => terminal::run_shell(false, true),
        _ => Ok(()),
    });
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            eprintln!("lystar-tui: {error}");
            std::process::exit(1);
        }
        Err(_) => {
            eprintln!("lystar-tui: panic recovered after terminal cleanup");
            std::process::exit(101);
        }
    }
}
