// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if lystar_code_gui_lib::run_ssh_askpass() {
        return;
    }
    lystar_code_gui_lib::run();
}
