// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let [_, flag, id] = args.as_slice() {
        if flag == "--run-sync" {
            std::process::exit(kermius_lib::cli_run_sync(id));
        }
    }
    if args.get(1).map(String::as_str) == Some("--ssh-bridge") {
        std::process::exit(kermius_lib::cli_ssh_bridge(&args[2..]));
    }
    if let [_, flag, path] = args.as_slice() {
        if flag == "--import-termix" {
            match kermius_lib::cli_import(path) {
                Ok(msg) => println!("{msg}"),
                Err(err) => {
                    eprintln!("Import failed: {err:#}");
                    std::process::exit(1);
                }
            }
            return;
        }
    }
    kermius_lib::run()
}
