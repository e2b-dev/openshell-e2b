//! Thin client for E2B: runs `node e2b-helper.mjs <op>` with a JSON request.
//!
//!   Rust (this file) ──JSON on stdin──► e2b-helper.mjs ──E2B SDK──► E2B
//!                    ◄─JSON on stdout──
//!
//! The helper uses E2B's official JS SDK, so this file only has to shuttle JSON.
//! Every call is a fresh short-lived Node process: simple and stateless.

use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

#[derive(Clone, Debug)]
pub struct E2b {
    pub node: PathBuf,
    pub helper: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub sandbox_id: String,
    /// Secret that E2B's proxy requires on every request to this sandbox's URLs.
    pub traffic_access_token: String,
    /// Public hostname for port 9000, e.g. `9000-<id>.e2b.app`.
    pub host9000: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl E2b {
    async fn call<T: DeserializeOwned>(&self, op: &str, req: Value) -> Result<T, String> {
        let mut child = Command::new(&self.node)
            .arg(&self.helper)
            .arg(op)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("start e2b helper: {e}"))?;
        let mut stdin = child.stdin.take().ok_or("e2b helper has no stdin")?;
        stdin
            .write_all(req.to_string().as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        drop(stdin); // EOF: the helper starts working once stdin closes
        let out = child.wait_with_output().await.map_err(|e| e.to_string())?;
        let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| {
            format!(
                "e2b helper {op}: bad output ({e}); stderr: {}",
                String::from_utf8_lossy(&out.stderr)
            )
        })?;
        if v["ok"] != json!(true) {
            return Err(format!(
                "e2b {op}: {}",
                v["error"].as_str().unwrap_or("unknown error")
            ));
        }
        serde_json::from_value(v).map_err(|e| format!("e2b helper {op}: {e}"))
    }

    /// Create a private sandbox from `template`, tagged with `metadata`.
    pub async fn create(&self, template: &str, metadata: Value) -> Result<Created, String> {
        self.call(
            "create",
            json!({ "template": template, "metadata": metadata, "timeoutMs": 3_600_000 }),
        )
        .await
    }

    /// Write a file as `user` with an optional octal `mode`.
    pub async fn write(
        &self,
        id: &str,
        path: &str,
        bytes: &[u8],
        user: &str,
        mode: Option<u32>,
    ) -> Result<(), String> {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        let _: Value = self
            .call(
                "write",
                json!({ "sandboxId": id, "path": path, "base64": b64, "user": user, "mode": mode }),
            )
            .await?;
        Ok(())
    }

    /// Run a command and wait for it.
    pub async fn run(&self, id: &str, cmd: &str, user: &str) -> Result<RunResult, String> {
        self.call("run", json!({ "sandboxId": id, "cmd": cmd, "user": user }))
            .await
    }

    /// Run a command that must succeed; a non-zero exit becomes an error with its stderr.
    pub async fn run_ok(&self, id: &str, cmd: &str, user: &str) -> Result<RunResult, String> {
        let r = self.run(id, cmd, user).await?;
        if r.exit_code != 0 {
            return Err(format!(
                "command failed (exit {}): {cmd}: {}",
                r.exit_code,
                r.stderr.trim()
            ));
        }
        Ok(r)
    }

    /// Start a long-running command and return immediately.
    pub async fn run_background(&self, id: &str, cmd: &str, user: &str) -> Result<(), String> {
        let _: Value = self
            .call(
                "run",
                json!({ "sandboxId": id, "cmd": cmd, "user": user, "background": true }),
            )
            .await?;
        Ok(())
    }

    pub async fn kill(&self, id: &str) -> Result<(), String> {
        let _: Value = self.call("kill", json!({ "sandboxId": id })).await?;
        Ok(())
    }
}
