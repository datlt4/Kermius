//! Kermius sync server. Stores one opaque, client-side encrypted vault blob
//! with a monotonically increasing version (optimistic concurrency).
//! The server never sees plaintext or the encryption passphrase.
//!
//! Env: KERMIUS_TOKEN (required), KERMIUS_DATA (default ./data), KERMIUS_ADDR (default 0.0.0.0:8080)
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

struct App {
    token: String,
    dir: PathBuf,
    lock: Mutex<()>,
}

fn authorized(app: &App, headers: &HeaderMap) -> bool {
    let got = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    // Constant-time comparison.
    got.len() == app.token.len() && got.bytes().zip(app.token.bytes()).fold(0, |acc, (a, b)| acc | (a ^ b)) == 0
}

async fn read_version(app: &App) -> u64 {
    tokio::fs::read_to_string(app.dir.join("vault.version"))
        .await
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

async fn get_vault(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if !authorized(&app, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let _guard = app.lock.lock().await;
    match tokio::fs::read(app.dir.join("vault.bin")).await {
        Ok(data) => ([("x-version", read_version(&app).await.to_string())], data).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn put_vault(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> Response {
    if !authorized(&app, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(base) = headers.get("x-base-version").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()) else {
        return (StatusCode::BAD_REQUEST, "missing x-base-version").into_response();
    };
    let _guard = app.lock.lock().await;
    let current = read_version(&app).await;
    if base != current {
        return (StatusCode::CONFLICT, [("x-version", current.to_string())]).into_response();
    }
    let next = current + 1;
    let write = async {
        let tmp = app.dir.join("vault.bin.tmp");
        tokio::fs::write(&tmp, &body).await?;
        tokio::fs::rename(&tmp, app.dir.join("vault.bin")).await?;
        tokio::fs::write(app.dir.join("vault.version"), next.to_string()).await
    };
    match write.await {
        Ok(()) => ([("x-version", next.to_string())], "ok").into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[tokio::main]
async fn main() {
    let token = std::env::var("KERMIUS_TOKEN").unwrap_or_default();
    if token.len() < 16 {
        eprintln!("KERMIUS_TOKEN must be set (at least 16 characters)");
        std::process::exit(1);
    }
    let dir = PathBuf::from(std::env::var("KERMIUS_DATA").unwrap_or_else(|_| "./data".into()));
    tokio::fs::create_dir_all(&dir).await.expect("create data dir");
    let addr = std::env::var("KERMIUS_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());

    let app = Arc::new(App { token, dir, lock: Mutex::new(()) });
    let router = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/v1/vault", get(get_vault).put(put_vault))
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(app);

    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    println!("kermius-sync listening on {addr}");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .unwrap();
}
