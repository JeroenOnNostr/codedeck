use serde::{Serialize, Deserialize};
use crate::session::AgentMode;

/// Non-secret configuration, stored as plaintext JSON on disk.
/// Secret fields (API keys) are stored in Stronghold encrypted storage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub github_username: Option<String>,
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
            github_username: None,
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

/// Full config as seen by the frontend (includes secrets in transit over IPC).
/// Secrets are populated from Stronghold on read, saved to Stronghold on write.
/// This struct has the same JSON shape as the old AppConfig, so the frontend
/// TypeScript interface requires no changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FullConfig {
    pub anthropic_api_key: Option<String>,
    pub github_pat: Option<String>,
    pub github_username: Option<String>,
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

impl FullConfig {
    /// Merge non-secret config with secrets from Stronghold
    pub fn from_config_and_secrets(
        config: &AppConfig,
        api_key: Option<String>,
        pat: Option<String>,
    ) -> Self {
        Self {
            anthropic_api_key: api_key,
            github_pat: pat,
            github_username: config.github_username.clone(),
            default_mode: config.default_mode.clone(),
            default_effort: config.default_effort.clone(),
            auto_push_on_complete: config.auto_push_on_complete,
            notifications_enabled: config.notifications_enabled,
            workspace_base_path: config.workspace_base_path.clone(),
            max_sessions: config.max_sessions,
            model: config.model.clone(),
            show_session_metadata: config.show_session_metadata,
            show_mode_badge: config.show_mode_badge,
            show_commit_badge: config.show_commit_badge,
            show_model_badge: config.show_model_badge,
            show_usage_badge: config.show_usage_badge,
        }
    }

    /// Extract non-secret config (for JSON persistence)
    pub fn to_app_config(&self) -> AppConfig {
        AppConfig {
            github_username: self.github_username.clone(),
            default_mode: self.default_mode.clone(),
            default_effort: self.default_effort.clone(),
            auto_push_on_complete: self.auto_push_on_complete,
            notifications_enabled: self.notifications_enabled,
            workspace_base_path: self.workspace_base_path.clone(),
            max_sessions: self.max_sessions,
            model: self.model.clone(),
            show_session_metadata: self.show_session_metadata,
            show_mode_badge: self.show_mode_badge,
            show_commit_badge: self.show_commit_badge,
            show_model_badge: self.show_model_badge,
            show_usage_badge: self.show_usage_badge,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_config_roundtrip() {
        let config = AppConfig::default();
        let full = FullConfig::from_config_and_secrets(
            &config,
            Some("sk-ant-test".into()),
            Some("ghp_test".into()),
        );
        assert_eq!(full.anthropic_api_key, Some("sk-ant-test".into()));
        assert_eq!(full.github_pat, Some("ghp_test".into()));
        assert_eq!(full.model, "claude-opus-5");
        assert!(full.show_model_badge);

        let back = full.to_app_config();
        assert_eq!(back.model, "claude-opus-5");
        // Secrets should not be in the non-secret config
        // (they don't exist on AppConfig at all)
    }

    #[test]
    fn full_config_with_no_secrets() {
        let config = AppConfig::default();
        let full = FullConfig::from_config_and_secrets(&config, None, None);
        assert!(full.anthropic_api_key.is_none());
        assert!(full.github_pat.is_none());
    }
}
