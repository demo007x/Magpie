//! Obsidian 接入（docs/07）：vault 文件直写——划词/识图/结果按模板落进 vault。
//! 无状态一次性送达：追加即完，不建队列、不存第二份状态。
//! 安全边界：目标路径必须位于 vault 内（拒绝 .. 逃逸与绝对路径注入），
//! 相对路径与模板内容均由 TS 渲染后传入，Rust 只负责安全写入。

use std::path::{Component, Path, PathBuf};

/// vault 相对路径安全拼接：拒绝 `..` 逃逸与绝对路径注入
fn safe_join(vault: &str, rel: &str) -> Option<PathBuf> {
    let rel = rel.trim().trim_start_matches(['/', '\\']);
    if rel.is_empty() {
        return None;
    }
    let rel_path = Path::new(rel);
    if rel_path
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
        return None;
    }
    Some(Path::new(vault).join(rel_path))
}

/// 追加内容到 vault 内的文件（末尾；已有内容时先补一个空行分隔块）。
/// 文件不存在则连同父目录一起创建（如当日日记首条）。
/// rel_path 为 vault 相对路径（如 "2026-09-25.md" 或 "Notes/收集.md"）；
/// content 为模板渲染后的完整追加块（UTF-8，LF 结尾不作要求）。
#[tauri::command]
pub fn obsidian_append(
    app: tauri::AppHandle,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    use std::io::Write;

    let vault = crate::settings::current(&app).obsidian.vault_path;
    if vault.trim().is_empty() {
        return Err("未配置 Obsidian vault 目录".into());
    }
    let path = safe_join(&vault, &rel_path).ok_or_else(|| "路径不合法".to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("无法创建目录：{e}"))?;
    }

    let needs_sep = std::fs::metadata(&path).map(|m| m.len() > 0).unwrap_or(false);
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("无法打开文件：{e}"))?;
    if needs_sep {
        f.write_all(b"\n").map_err(|e| e.to_string())?;
    }
    f.write_all(content.as_bytes())
        .map_err(|e| format!("写入失败：{e}"))?;
    if !content.ends_with('\n') {
        f.write_all(b"\n").map_err(|e| e.to_string())?;
    }
    Ok(())
}
