use serde::{Serialize, Deserialize};
use crate::session::AgentMode;

/// Application configuration, stored as plaintext JSON on disk.
///
/// It holds no secrets: the Anthropic key comes from `ANTHROPIC_API_KEY` in the
/// environment, and remote sessions authenticate on the bridge's machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub default_mode: AgentMode,
    #[serde(default = "default_effort")]
    pub default_effort: String,
    pub auto_push_on_complete: bool,
    pub notifications_enabled: bool,
    pub workspace_base_path: String,
    pub max_sessions: u32,
    pub model: String,
    #[serde(default = "default_show_session_metadata")]
    pub show_session_metadata: bool,
    #[serde(default = "default_show_mode_badge")]
    pub show_mode_badge: bool,
    #[serde(default = "default_show_commit_badge")]
    pub show_commit_badge: bool,
    #[serde(default = "default_show_model_badge")]
    pub show_model_badge: bool,
    #[serde(default = "default_show_usage_badge")]
    pub show_usage_badge: bool,
}

fn default_effort() -> String {
    "auto".to_string()
}

fn default_show_session_metadata() -> bool {
    true
}

fn default_show_mode_badge() -> bool {
    true
}

fn default_show_commit_badge() -> bool {
    true
}

fn default_show_model_badge() -> bool {
    true
}

fn default_show_usage_badge() -> bool {
    true
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            default_mode: AgentMode::Plan,
            default_effort: "auto".to_string(),
            auto_push_on_complete: true,
            notifications_enabled: true,
            workspace_base_path: String::new(),
            max_sessions: 20,
            model: "claude-opus-5".to_string(),
            show_session_metadata: true,
            show_mode_badge: true,
            show_commit_badge: true,
            show_model_badge: true,
            show_usage_badge: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_config_roundtrips_through_json() {
        let config = AppConfig::default();
        let json = serde_json::to_string(&config).unwrap();
        let back: AppConfig = serde_json::from_str(&json).unwrap();

        assert_eq!(back.model, "claude-opus-5");
        assert!(back.show_model_badge);
    }

    #[test]
    fn app_config_ignores_fields_left_over_from_older_installs() {
        // CD-063 removed anthropic_api_key/github_pat/github_username. An existing
        // config.json still carries them, and must keep deserializing.
        let legacy = r#"{
            "anthropic_api_key": "sk-ant-old",
            "github_pat": "ghp_old",
            "github_username": "someone",
            "default_mode": "plan",
            "auto_push_on_complete": true,
            "notifications_enabled": true,
            "workspace_base_path": "",
            "max_sessions": 20,
            "model": "claude-opus-5"
        }"#;

        let config: AppConfig = serde_json::from_str(legacy).unwrap();
        assert_eq!(config.model, "claude-opus-5");
        assert_eq!(config.max_sessions, 20);
    }
}
