mod app;
mod editor;
mod terminal;

use std::panic;

fn main() {
    let result = panic::catch_unwind(|| match std::env::args().nth(1).as_deref() {
        Some("--run") | Some("run") => {
            let session_path = std::env::args().nth(2).ok_or_else(|| {
                terminal::TuiError::InvalidResponse("缺少 Session 路径".to_owned())
            })?;
            terminal::run(&session_path)
        }
        Some("--pipe-handshake-hold") => {
            terminal::handshake_inherited_pipes()?;
            let hold_ms = std::env::args().nth(2).unwrap_or_else(|| "1200".to_owned());
            std::thread::sleep(std::time::Duration::from_millis(hold_ms.parse().unwrap()));
            Ok(())
        }
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
