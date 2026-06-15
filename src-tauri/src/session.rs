use serde::{Serialize, Deserialize};
use chrono::{DateTime, Utc};
use std::path::PathBuf;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use anyhow::Result;
use crate::config::AppConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub name: String,
    pub group: String,
    pub repo_url: String,
    pub branch: String,
    pub workspace_path: String,
    pub state: SessionState,
    pub mode: AgentMode,
    pub created_at: DateTime<Utc>,
    pub last_activity: DateTime<Utc>,
    pub pending_permissions: Vec<PermissionRequest>,
    pub git_sync_status: GitSyncStatus,
    pub token_usage: TokenUsage,
    /// False while git clone is in progress; true once workspace is ready for use
    #[serde(default = "default_true")]
    pub workspace_ready: bool,
}

fn default_true() -> bool { true }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_cost_usd: f64,
}

impl TokenUsage {
    pub fn add(&mut self, input: u64, output: u64, model: &str) {
        self.input_tokens += input;
        self.output_tokens += output;
        // Approximate pricing per 1M tokens (input, output), as of June 2026.
        // Specific matches must come before the generic `opus`/`sonnet` fallbacks.
        let (input_rate, output_rate) = match model {
            m if m.contains("fable") => (10.0, 50.0),       // Fable 5
            m if m.contains("opus-4-8") => (5.0, 25.0),     // Opus 4.8
            m if m.contains("opus-4-7") => (5.0, 25.0),     // Opus 4.7
            m if m.contains("opus") => (15.0, 75.0),        // older Opus (4.6 and earlier)
            m if m.contains("sonnet") => (3.0, 15.0),       // Sonnet 4.x
            m if m.contains("haiku") => (1.0, 5.0),         // Haiku 4.5
            _ => (3.0, 15.0),                               // default to sonnet pricing
        };
        self.total_cost_usd += (input as f64 / 1_000_000.0) * input_rate
            + (output as f64 / 1_000_000.0) * output_rate;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Idle,
    Running,
    WaitingPermission,
    Completed,
    Error(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AgentMode {
    Plan,
    Auto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRequest {
    pub id: String,
    pub tool_type: String,
    pub description: String,
    pub command: String,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputEntry {
    pub entry_type: OutputType,
    pub content: String,
    pub timestamp: DateTime<Utc>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputType {
    Action,
    Diff,
    Message,
    Error,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitSyncStatus {
    Synced,
    PendingPush,
    PushFailed(String),
    NeverPushed,
}

/// Stored conversation for persistence
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConversationHistory {
    pub messages: Vec<serde_json::Value>,
    /// Accumulated summary from previous pruning rounds.
    /// Prepended to the system prompt to preserve context across long sessions.
    #[serde(default)]
    pub summary: Option<String>,
}

/// Per-session lock wrapper — each session gets its own Mutex so agents
/// don't block each other when accessing different sessions.
pub type SessionLock = Arc<Mutex<Session>>;

/// Permission response channels, keyed by request_id.
/// Separated from sessions so agent code can await permissions
/// without holding a session lock.
pub type PermissionSenders = Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>;

/// Shared application state, replacing the single-mutex SessionManager.
///
/// - `sessions`: per-session Mutex (agents only lock their own session)
/// - `config`: RwLock (read-heavy, rarely written)
/// - `permission_senders`: separate from sessions (agent waits on channel, not session lock)
/// - `persistence`: filesystem I/O helper
pub struct AppState {
    pub sessions: Arc<Mutex<HashMap<String, SessionLock>>>,
    pub config: Arc<RwLock<AppConfig>>,
    pub permission_senders: PermissionSenders,
    pub persistence: Arc<Persistence>,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            config: Arc::new(RwLock::new(AppConfig::default())),
            permission_senders: Arc::new(Mutex::new(HashMap::new())),
            persistence: Arc::new(Persistence::new(data_dir)),
        }
    }

    pub fn load(data_dir: PathBuf) -> Result<Self> {
        let persistence = Persistence::new(data_dir);
        let sessions_vec = persistence.load_sessions()?;
        let config = persistence.load_config()?;

        let mut sessions_map = HashMap::new();
        for session in sessions_vec {
            sessions_map.insert(session.id.clone(), Arc::new(Mutex::new(session)));
        }

        Ok(Self {
            sessions: Arc::new(Mutex::new(sessions_map)),
            config: Arc::new(RwLock::new(config)),
            permission_senders: Arc::new(Mutex::new(HashMap::new())),
            persistence: Arc::new(persistence),
        })
    }

    /// Get all sessions as a Vec (for the get_sessions command)
    pub async fn get_all_sessions(&self) -> Vec<Session> {
        let sessions = self.sessions.lock().await;
        let mut result = Vec::with_capacity(sessions.len());
        for session_lock in sessions.values() {
            result.push(session_lock.lock().await.clone());
        }
        result.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        result
    }

    /// Save all sessions to disk
    pub async fn save_sessions(&self) -> Result<()> {
        let sessions = self.get_all_sessions().await;
        self.persistence.save_sessions(&sessions)
    }

    /// Save config to disk
    pub async fn save_config(&self) -> Result<()> {
        let config = self.config.read().await;
        self.persistence.save_config(&config)
    }
}

/// Filesystem persistence — no locks, just I/O methods.
pub struct Persistence {
    pub data_dir: PathBuf,
}

impl Persistence {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    pub fn load_sessions(&self) -> Result<Vec<Session>> {
        let path = self.data_dir.join("sessions.json");
        if path.exists() {
            let data = std::fs::read_to_string(&path)?;
            Ok(serde_json::from_str(&data)?)
        } else {
            Ok(Vec::new())
        }
    }

    pub fn save_sessions(&self, sessions: &[Session]) -> Result<()> {
        let path = self.data_dir.join("sessions.json");
        let data = serde_json::to_string_pretty(sessions)?;
        std::fs::write(path, data)?;
        Ok(())
    }

    pub fn load_config(&self) -> Result<AppConfig> {
        let path = self.data_dir.join("config.json");
        if path.exists() {
            let data = std::fs::read_to_string(&path)?;
            Ok(serde_json::from_str(&data)?)
        } else {
            Ok(AppConfig::default())
        }
    }

    pub fn save_config(&self, config: &AppConfig) -> Result<()> {
        let path = self.data_dir.join("config.json");
        let data = serde_json::to_string_pretty(config)?;
        std::fs::write(path, data)?;
        Ok(())
    }

    pub fn save_conversation(&self, session_id: &str, history: &ConversationHistory) -> Result<()> {
        let history_dir = self.data_dir.join("history");
        std::fs::create_dir_all(&history_dir)?;
        let path = history_dir.join(format!("{}.json", session_id));
        let data = serde_json::to_string_pretty(history)?;
        std::fs::write(path, data)?;
        Ok(())
    }

    pub fn load_conversation(&self, session_id: &str) -> Result<ConversationHistory> {
        let path = self.data_dir.join("history").join(format!("{}.json", session_id));
        if path.exists() {
            let data = std::fs::read_to_string(&path)?;
            Ok(serde_json::from_str(&data)?)
        } else {
            Ok(ConversationHistory::default())
        }
    }

    pub fn workspace_path(&self, session_id: &str) -> String {
        self.data_dir
            .join("workspaces")
            .join(session_id)
            .to_string_lossy()
            .to_string()
    }

    pub fn delete_session_data(&self, session_id: &str, workspace_path: &str) -> Result<()> {
        let ws = std::path::Path::new(workspace_path);
        if ws.exists() {
            std::fs::remove_dir_all(ws).ok();
        }
        let history_path = self.data_dir.join("history").join(format!("{}.json", session_id));
        if history_path.exists() {
            std::fs::remove_file(history_path).ok();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- TokenUsage tests ---

    #[test]
    fn token_usage_default_is_zero() {
        let usage = TokenUsage::default();
        assert_eq!(usage.input_tokens, 0);
        assert_eq!(usage.output_tokens, 0);
        assert_eq!(usage.total_cost_usd, 0.0);
    }

    #[test]
    fn token_usage_add_opus_pricing() {
        let mut usage = TokenUsage::default();
        usage.add(1_000_000, 1_000_000, "claude-opus-4-6");
        assert_eq!(usage.input_tokens, 1_000_000);
        assert_eq!(usage.output_tokens, 1_000_000);
        // opus: $15/1M input + $75/1M output = $90
        assert!((usage.total_cost_usd - 90.0).abs() < 0.01);
    }

    #[test]
    fn token_usage_add_sonnet_pricing() {
        let mut usage = TokenUsage::default();
        usage.add(1_000_000, 1_000_000, "claude-sonnet-4-20250514");
        // sonnet: $3/1M input + $15/1M output = $18
        assert!((usage.total_cost_usd - 18.0).abs() < 0.01);
    }

    #[test]
    fn token_usage_add_haiku_pricing() {
        let mut usage = TokenUsage::default();
        usage.add(1_000_000, 1_000_000, "claude-haiku-4-5-20251001");
        // haiku: $0.80/1M input + $4.0/1M output = $4.80
        assert!((usage.total_cost_usd - 4.80).abs() < 0.01);
    }

    #[test]
    fn token_usage_add_unknown_model_defaults_to_sonnet() {
        let mut usage = TokenUsage::default();
        usage.add(1_000_000, 1_000_000, "some-unknown-model");
        // default sonnet: $3/1M + $15/1M = $18
        assert!((usage.total_cost_usd - 18.0).abs() < 0.01);
    }

    #[test]
    fn token_usage_add_cumulative() {
        let mut usage = TokenUsage::default();
        usage.add(100, 50, "claude-sonnet-4-20250514");
        usage.add(200, 100, "claude-sonnet-4-20250514");
        assert_eq!(usage.input_tokens, 300);
        assert_eq!(usage.output_tokens, 150);
    }

    // --- ConversationHistory serialization ---

    #[test]
    fn conversation_history_serde_roundtrip() {
        let history = ConversationHistory {
            messages: vec![
                serde_json::json!({"role": "user", "content": "hello"}),
                serde_json::json!({"role": "assistant", "content": [{"type": "text", "text": "hi"}]}),
            ],
            summary: Some("Previous context: user asked about Rust".into()),
        };
        let serialized = serde_json::to_string(&history).unwrap();
        let deserialized: ConversationHistory = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized.messages.len(), 2);
        assert_eq!(deserialized.messages[0]["role"], "user");
        assert_eq!(deserialized.messages[1]["content"][0]["text"], "hi");
        assert_eq!(deserialized.summary, Some("Previous context: user asked about Rust".into()));
    }

    #[test]
    fn conversation_history_summary_field_backwards_compat() {
        // Old JSON without the summary field should deserialize with summary = None
        let json = r#"{"messages":[{"role":"user","content":"hello"}]}"#;
        let history: ConversationHistory = serde_json::from_str(json).unwrap();
        assert_eq!(history.messages.len(), 1);
        assert!(history.summary.is_none());
    }

    // --- Persistence tests ---

    fn temp_persistence() -> (Persistence, PathBuf) {
        let dir = std::env::temp_dir().join(format!("codedeck_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        (Persistence::new(dir.clone()), dir)
    }

    #[test]
    fn persistence_save_load_config_roundtrip() {
        let (p, dir) = temp_persistence();
        let config = AppConfig {
            github_username: Some("testuser".into()),
            model: "claude-opus-4-6".into(),
            ..AppConfig::default()
        };
        p.save_config(&config).unwrap();
        let loaded = p.load_config().unwrap();
        assert_eq!(loaded.github_username, Some("testuser".into()));
        assert_eq!(loaded.model, "claude-opus-4-6");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn persistence_save_load_conversation_roundtrip() {
        let (p, dir) = temp_persistence();
        let history = ConversationHistory {
            messages: vec![serde_json::json!({"role": "user", "content": "test"})],
            summary: None,
        };
        p.save_conversation("session-1", &history).unwrap();
        let loaded = p.load_conversation("session-1").unwrap();
        assert_eq!(loaded.messages.len(), 1);
        assert_eq!(loaded.messages[0]["content"], "test");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn persistence_load_missing_config_returns_default() {
        let (p, dir) = temp_persistence();
        let config = p.load_config().unwrap();
        assert_eq!(config.model, "claude-sonnet-4-20250514");
        assert!(config.github_username.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn persistence_load_missing_conversation_returns_empty() {
        let (p, dir) = temp_persistence();
        let history = p.load_conversation("nonexistent").unwrap();
        assert!(history.messages.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn persistence_workspace_path() {
        let p = Persistence::new(PathBuf::from("/data"));
        let path = p.workspace_path("abc-123");
        assert_eq!(path, "/data/workspaces/abc-123");
    }

    #[test]
    fn persistence_save_load_sessions_roundtrip() {
        let (p, dir) = temp_persistence();
        let sessions = vec![Session {
            id: "s1".into(),
            name: "Test".into(),
            group: "default".into(),
            repo_url: String::new(),
            branch: String::new(),
            workspace_path: "/tmp/ws".into(),
            state: SessionState::Idle,
            mode: AgentMode::Plan,
            created_at: chrono::Utc::now(),
            last_activity: chrono::Utc::now(),
            pending_permissions: Vec::new(),
            git_sync_status: GitSyncStatus::NeverPushed,
            token_usage: TokenUsage::default(),
            workspace_ready: true,
        }];
        p.save_sessions(&sessions).unwrap();
        let loaded = p.load_sessions().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "s1");
        assert_eq!(loaded[0].name, "Test");
        std::fs::remove_dir_all(&dir).ok();
    }
}
