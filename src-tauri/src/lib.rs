mod session;
mod agent;
mod config;

use session::{AppState, SessionState, AgentMode};
use config::FullConfig;
use std::sync::Arc;
use std::collections::HashMap;
use tokio::sync::Mutex;
use tauri::{Manager, Emitter};
use tokio_util::sync::CancellationToken;
use tokio::task::JoinHandle;

type SharedState = Arc<AppState>;
/// Maps session_id -> CancellationToken for running agent tasks
type AgentCancellations = Arc<Mutex<HashMap<String, CancellationToken>>>;
/// Maps session_id -> JoinHandle for running agent tasks (A5: monitor for panics)
type AgentHandles = Arc<Mutex<HashMap<String, JoinHandle<()>>>>;

/// Read a secret from Stronghold's unencrypted store.
/// Returns None if the key doesn't exist or Stronghold isn't available.
fn stronghold_get(app: &tauri::AppHandle, key: &str) -> Option<String> {
    use tauri_plugin_stronghold::stronghold::Stronghold;

    let stronghold = app.try_state::<Stronghold>()?;
    let client = stronghold.get_client("codedeck").ok()?;
    let store = client.store();
    let data = store.get(key.as_bytes()).ok()?;
    data.map(|bytes| String::from_utf8_lossy(&bytes).to_string())
}

/// Write a secret to Stronghold's unencrypted store.
fn stronghold_set(app: &tauri::AppHandle, key: &str, value: &str) -> Result<(), String> {
    use tauri_plugin_stronghold::stronghold::Stronghold;

    let stronghold = app.state::<Stronghold>();
    let client = stronghold.get_client("codedeck")
        .or_else(|_| stronghold.create_client("codedeck"))
        .map_err(|e| format!("Stronghold client error: {}", e))?;
    let store = client.store();
    store.insert(key.as_bytes().to_vec(), value.as_bytes().to_vec(), None)
        .map_err(|e| format!("Stronghold insert error: {}", e))?;
    stronghold.save()
        .map_err(|e| format!("Stronghold save error: {}", e))?;
    Ok(())
}

/// Delete a secret from Stronghold's store.
fn stronghold_delete(app: &tauri::AppHandle, key: &str) -> Result<(), String> {
    use tauri_plugin_stronghold::stronghold::Stronghold;

    let stronghold = app.try_state::<Stronghold>();
    if let Some(stronghold) = stronghold {
        if let Ok(client) = stronghold.get_client("codedeck") {
            let store = client.store();
            store.delete(key.as_bytes())
                .map_err(|e| format!("Stronghold delete error: {}", e))?;
            stronghold.save()
                .map_err(|e| format!("Stronghold save error: {}", e))?;
        }
    }
    Ok(())
}

/// One-time migration: move plaintext secrets from config.json to Stronghold.
/// Reads config.json as raw JSON, extracts secret fields, writes them to
/// Stronghold, then rewrites config.json without those fields.
fn migrate_secrets_from_config(data_dir: &std::path::Path, app: &tauri::AppHandle) {
    let config_path = data_dir.join("config.json");
    if !config_path.exists() { return; }

    let data = match std::fs::read_to_string(&config_path) {
        Ok(d) => d,
        Err(_) => return,
    };
    let mut json: serde_json::Value = match serde_json::from_str(&data) {
        Ok(j) => j,
        Err(_) => return,
    };

    let mut migrated = false;
    if let Some(key) = json.get("anthropic_api_key").and_then(|v| v.as_str()) {
        if !key.is_empty() {
            stronghold_set(app, "anthropic_api_key", key).ok();
            migrated = true;
        }
    }
    if let Some(pat) = json.get("github_pat").and_then(|v| v.as_str()) {
        if !pat.is_empty() {
            stronghold_set(app, "github_pat", pat).ok();
            migrated = true;
        }
    }

    if migrated {
        // Remove secret fields from JSON and rewrite
        if let Some(obj) = json.as_object_mut() {
            obj.remove("anthropic_api_key");
            obj.remove("github_pat");
        }
        if let Ok(cleaned) = serde_json::to_string_pretty(&json) {
            std::fs::write(&config_path, cleaned).ok();
        }
        eprintln!("Migrated secrets from config.json to Stronghold encrypted storage");
    }
}

#[tauri::command]
async fn get_sessions(
    state: tauri::State<'_, SharedState>,
) -> Result<Vec<session::Session>, String> {
    Ok(state.get_all_sessions().await)
}

#[tauri::command]
async fn create_session(
    name: String,
    group: String,
    repo_url: String,
    branch: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<session::Session, String> {
    let default_mode = {
        let config = state.config.read().await;
        config.default_mode.clone()
    };

    let id = uuid::Uuid::new_v4().to_string();
    let workspace_path = state.persistence.workspace_path(&id);
    std::fs::create_dir_all(&workspace_path).map_err(|e| e.to_string())?;

    let workspace_ready = repo_url.is_empty();

    let new_session = session::Session {
        id: id.clone(),
        name,
        group,
        repo_url: repo_url.clone(),
        branch: branch.clone(),
        workspace_path: workspace_path.clone(),
        state: SessionState::Idle,
        mode: default_mode,
        created_at: chrono::Utc::now(),
        last_activity: chrono::Utc::now(),
        pending_permissions: Vec::new(),
        git_sync_status: session::GitSyncStatus::NeverPushed,
        token_usage: session::TokenUsage::default(),
        workspace_ready,
    };

    // Insert into per-session map
    {
        let mut sessions = state.sessions.lock().await;
        sessions.insert(id.clone(), Arc::new(Mutex::new(new_session.clone())));
    }
    state.save_sessions().await.map_err(|e| e.to_string())?;

    // If a repo URL was provided, clone it in the background
    if !repo_url.is_empty() {
        let session_id = id.clone();
        let app_clone = app.clone();
        let state_arc = state.inner().clone();

        tokio::spawn(async move {
            let entry = session::OutputEntry {
                entry_type: session::OutputType::System,
                content: format!("Cloning {}...", repo_url),
                timestamp: chrono::Utc::now(),
                metadata: None,
            };
            let _ = app_clone.emit("session-output", serde_json::json!({
                "session_id": session_id,
                "entry": entry,
            }));

            match agent::git_clone(&repo_url, &branch, &workspace_path).await {
                Ok(msg) => {
                    let entry = session::OutputEntry {
                        entry_type: session::OutputType::System,
                        content: msg,
                        timestamp: chrono::Utc::now(),
                        metadata: None,
                    };
                    let _ = app_clone.emit("session-output", serde_json::json!({
                        "session_id": session_id,
                        "entry": entry,
                    }));
                }
                Err(e) => {
                    let entry = session::OutputEntry {
                        entry_type: session::OutputType::Error,
                        content: format!("Git clone failed: {}", e),
                        timestamp: chrono::Utc::now(),
                        metadata: None,
                    };
                    let _ = app_clone.emit("session-output", serde_json::json!({
                        "session_id": session_id,
                        "entry": entry,
                    }));
                }
            }

            // Mark workspace as ready
            let sessions = state_arc.sessions.lock().await;
            if let Some(session_lock) = sessions.get(&session_id) {
                let mut s = session_lock.lock().await;
                s.workspace_ready = true;
                let session_clone = s.clone();
                let _ = app_clone.emit("session-state", serde_json::json!({
                    "session_id": session_id,
                    "state": format!("{:?}", session_clone.state),
                    "session": session_clone,
                }));
            }
            drop(sessions);
            state_arc.save_sessions().await.ok();
        });
    }

    Ok(new_session)
}

#[tauri::command]
async fn delete_session(
    session_id: String,
    state: tauri::State<'_, SharedState>,
    cancellations: tauri::State<'_, AgentCancellations>,
    handles: tauri::State<'_, AgentHandles>,
) -> Result<(), String> {
    // Cancel any running agent for this session
    {
        let mut tokens = cancellations.lock().await;
        if let Some(token) = tokens.remove(&session_id) {
            token.cancel();
        }
    }
    // Abort the task handle (A5)
    {
        let mut h = handles.lock().await;
        if let Some(handle) = h.remove(&session_id) {
            handle.abort();
        }
    }
    // Remove session and clean up filesystem
    let workspace_path = {
        let mut sessions = state.sessions.lock().await;
        if let Some(session_lock) = sessions.remove(&session_id) {
            let s = session_lock.lock().await;
            s.workspace_path.clone()
        } else {
            return Ok(());
        }
    };
    state.persistence.delete_session_data(&session_id, &workspace_path)
        .map_err(|e| e.to_string())?;
    state.save_sessions().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_message(
    session_id: String,
    text: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedState>,
    cancellations: tauri::State<'_, AgentCancellations>,
    handles: tauri::State<'_, AgentHandles>,
) -> Result<(), String> {
    // Read API key from Stronghold encrypted storage
    let (api_key, model, workspace_path, mode) = {
        let api_key = match stronghold_get(&app, "anthropic_api_key") {
            Some(key) if !key.is_empty() => key,
            _ => {
                let entry = session::OutputEntry {
                    entry_type: session::OutputType::Error,
                    content: "No Anthropic API key configured. Go to Settings to add one.".into(),
                    timestamp: chrono::Utc::now(),
                    metadata: None,
                };
                let _ = app.emit("session-output", serde_json::json!({
                    "session_id": session_id,
                    "entry": entry,
                }));
                return Ok(());
            }
        };
        let config = state.config.read().await;
        let model = config.model.clone();
        drop(config);

        let sessions = state.sessions.lock().await;
        let session_lock = sessions.get(&session_id)
            .ok_or_else(|| "Session not found".to_string())?;
        let session = session_lock.lock().await;

        if !session.workspace_ready {
            let entry = session::OutputEntry {
                entry_type: session::OutputType::Error,
                content: "Workspace is still being cloned. Please wait for the clone to finish.".into(),
                timestamp: chrono::Utc::now(),
                metadata: None,
            };
            let _ = app.emit("session-output", serde_json::json!({
                "session_id": session_id,
                "entry": entry,
            }));
            return Ok(());
        }

        (api_key, model, session.workspace_path.clone(), session.mode.clone())
    };

    // Update state to running (per-session lock — doesn't block other sessions)
    {
        let sessions = state.sessions.lock().await;
        if let Some(session_lock) = sessions.get(&session_id) {
            let mut s = session_lock.lock().await;
            s.state = SessionState::Running;
            s.last_activity = chrono::Utc::now();
            let session_clone = s.clone();
            let _ = app.emit("session-state", serde_json::json!({
                "session_id": session_id,
                "state": "running",
                "session": session_clone,
            }));
        }
    }

    // Create cancellation token for this agent run
    let cancel_token = CancellationToken::new();
    {
        let mut tokens = cancellations.lock().await;
        if let Some(old_token) = tokens.insert(session_id.clone(), cancel_token.clone()) {
            old_token.cancel();
        }
    }

    let app_clone = app.clone();
    let session_id_clone = session_id.clone();
    let state_arc = state.inner().clone();
    let cancellations_arc = cancellations.inner().clone();
    let handles_arc = handles.inner().clone();

    let handle = tokio::spawn(async move {
        let result = agent::run_agent(
            &session_id_clone,
            text,
            &api_key,
            &model,
            &workspace_path,
            &mode,
            &app_clone,
            state_arc.clone(),
            cancel_token,
        ).await;

        // Clean up cancellation token
        {
            let mut tokens = cancellations_arc.lock().await;
            tokens.remove(&session_id_clone);
        }

        // Update session state based on result (per-session lock)
        {
            let sessions = state_arc.sessions.lock().await;
            if let Some(session_lock) = sessions.get(&session_id_clone) {
                let mut s = session_lock.lock().await;
                match result {
                    Ok(()) => s.state = SessionState::Completed,
                    Err(ref e) => s.state = SessionState::Error(e.to_string()),
                }
                s.last_activity = chrono::Utc::now();
                let session_clone = s.clone();
                let _ = app_clone.emit("session-state", serde_json::json!({
                    "session_id": session_id_clone,
                    "state": format!("{:?}", session_clone.state),
                    "session": session_clone,
                }));
            }
        }
        state_arc.save_sessions().await.ok();

        // Clean up own handle entry
        {
            let mut h = handles_arc.lock().await;
            h.remove(&session_id_clone);
        }
    });

    // Store the JoinHandle so we can monitor/abort it (A5)
    {
        let mut h = handles.lock().await;
        h.insert(session_id.clone(), handle);
    }

    Ok(())
}

#[tauri::command]
async fn cancel_agent(
    session_id: String,
    cancellations: tauri::State<'_, AgentCancellations>,
) -> Result<(), String> {
    let mut tokens = cancellations.lock().await;
    if let Some(token) = tokens.remove(&session_id) {
        token.cancel();
        Ok(())
    } else {
        Err("No running agent for this session".to_string())
    }
}

#[tauri::command]
async fn respond_permission(
    session_id: String,
    request_id: String,
    allow: bool,
    state: tauri::State<'_, SharedState>,
) -> Result<(), String> {
    // Send the response through the oneshot channel (separate lock from sessions)
    {
        let mut perms = state.permission_senders.lock().await;
        if let Some(tx) = perms.remove(&request_id) {
            let _ = tx.send(allow);
        }
    }
    // Clean up the permission from the session's pending list (per-session lock)
    {
        let sessions = state.sessions.lock().await;
        if let Some(session_lock) = sessions.get(&session_id) {
            let mut s = session_lock.lock().await;
            s.pending_permissions.retain(|p| p.id != request_id);
        }
    }
    Ok(())
}

#[tauri::command]
async fn set_mode(
    session_id: String,
    mode: AgentMode,
    state: tauri::State<'_, SharedState>,
) -> Result<(), String> {
    {
        let sessions = state.sessions.lock().await;
        if let Some(session_lock) = sessions.get(&session_id) {
            let mut s = session_lock.lock().await;
            s.mode = mode;
        }
    }
    state.save_sessions().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn git_push(
    session_id: String,
    state: tauri::State<'_, SharedState>,
) -> Result<String, String> {
    let workspace_path = {
        let sessions = state.sessions.lock().await;
        let session_lock = sessions.get(&session_id)
            .ok_or_else(|| "Session not found".to_string())?;
        let s = session_lock.lock().await;
        s.workspace_path.clone()
    };

    match agent::git_push_in_workspace(&workspace_path).await {
        Ok(output) => {
            let sessions = state.sessions.lock().await;
            if let Some(session_lock) = sessions.get(&session_id) {
                let mut s = session_lock.lock().await;
                s.git_sync_status = session::GitSyncStatus::Synced;
                s.last_activity = chrono::Utc::now();
            }
            drop(sessions);
            state.save_sessions().await.map_err(|e| e.to_string())?;
            Ok(output)
        }
        Err(e) => {
            let sessions = state.sessions.lock().await;
            if let Some(session_lock) = sessions.get(&session_id) {
                let mut s = session_lock.lock().await;
                s.git_sync_status = session::GitSyncStatus::PushFailed(e.to_string());
            }
            drop(sessions);
            state.save_sessions().await.map_err(|e| e.to_string())?;
            Err(e.to_string())
        }
    }
}

#[tauri::command]
async fn git_pull(
    session_id: String,
    state: tauri::State<'_, SharedState>,
) -> Result<String, String> {
    let workspace_path = {
        let sessions = state.sessions.lock().await;
        let session_lock = sessions.get(&session_id)
            .ok_or_else(|| "Session not found".to_string())?;
        let s = session_lock.lock().await;
        s.workspace_path.clone()
    };

    match agent::git_pull_in_workspace(&workspace_path).await {
        Ok(output) => {
            let sessions = state.sessions.lock().await;
            if let Some(session_lock) = sessions.get(&session_id) {
                let mut s = session_lock.lock().await;
                s.git_sync_status = session::GitSyncStatus::Synced;
                s.last_activity = chrono::Utc::now();
            }
            drop(sessions);
            state.save_sessions().await.map_err(|e| e.to_string())?;
            Ok(output)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Test an Anthropic API key by making a minimal API call.
/// The key is passed directly from the frontend (not read from Stronghold)
/// so this works before the user has saved their settings.
#[tauri::command]
async fn test_api_key(
    api_key: String,
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("No API key provided".into());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let body = serde_json::json!({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "Hi"}]
    });

    let resp = agent::with_anthropic_auth(
            client.post("https://api.anthropic.com/v1/messages"),
            &api_key,
        )
        .header("anthropic-version", agent::streaming::ANTHROPIC_API_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let status = resp.status();
    if status.is_success() {
        Ok("Valid".into())
    } else {
        let text = resp.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("error")?.get("message")?.as_str().map(String::from))
            .unwrap_or_else(|| format!("HTTP {}", status));
        Err(msg)
    }
}

/// Returns the full config including secrets (read from Stronghold).
/// The FullConfig has the same JSON shape as the old AppConfig,
/// so the frontend TypeScript interface requires no changes.
#[tauri::command]
async fn get_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<FullConfig, String> {
    let config = state.config.read().await;
    let api_key = stronghold_get(&app, "anthropic_api_key");
    let pat = stronghold_get(&app, "github_pat");
    Ok(FullConfig::from_config_and_secrets(&config, api_key, pat))
}

/// Updates config — secrets go to Stronghold, non-secrets go to config.json.
#[tauri::command]
async fn update_config(
    config: FullConfig,
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedState>,
) -> Result<(), String> {
    // Save secrets to Stronghold encrypted storage
    if let Some(ref key) = config.anthropic_api_key {
        if !key.is_empty() {
            stronghold_set(&app, "anthropic_api_key", key)?;
        } else {
            stronghold_delete(&app, "anthropic_api_key")?;
        }
    } else {
        stronghold_delete(&app, "anthropic_api_key")?;
    }
    if let Some(ref pat) = config.github_pat {
        if !pat.is_empty() {
            stronghold_set(&app, "github_pat", pat)?;
        } else {
            stronghold_delete(&app, "github_pat")?;
        }
    } else {
        stronghold_delete(&app, "github_pat")?;
    }

    // Save non-secret config to JSON
    {
        let mut cfg = state.config.write().await;
        *cfg = config.to_app_config();
    }
    state.save_config().await.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_speech_recognizer::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_background_relay::init())
        .plugin(tauri_plugin_mesh::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_tts::init())
        .setup(|app| {
            // Initialize Stronghold encrypted storage
            let salt_path = app.path()
                .app_local_data_dir()
                .expect("could not resolve app local data path")
                .join("salt.txt");
            app.handle().plugin(
                tauri_plugin_stronghold::Builder::with_argon2(&salt_path).build()
            )?;

            let data_dir = app.path().app_data_dir().expect("failed to get data dir");
            std::fs::create_dir_all(&data_dir).ok();

            // Migrate any existing plaintext secrets to Stronghold
            migrate_secrets_from_config(&data_dir, app.handle());

            let app_state = AppState::load(data_dir.clone()).unwrap_or_else(|e| {
                eprintln!("Failed to load state: {}", e);
                AppState::new(data_dir)
            });
            app.manage(Arc::new(app_state));
            app.manage(AgentCancellations::default());
            app.manage(AgentHandles::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_sessions,
            create_session,
            delete_session,
            send_message,
            cancel_agent,
            respond_permission,
            set_mode,
            git_push,
            git_pull,
            test_api_key,
            get_config,
            update_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CodeDeck");
}
