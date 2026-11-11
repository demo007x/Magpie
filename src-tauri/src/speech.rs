//! 本地朗读（TTS）：Kokoro-82M fp32 ONNX 模型 + sherpa-onnx 命令行引擎。
//!
//! 为什么是「按需下载」而不是打进安装包：模型与引擎解压后约 590MB，不朗读的
//! 用户不该为它付出安装体积；下载源是 GitHub Releases 的公开直链，装完即离线。
//!
//! 为什么推理走子进程：onnxruntime 是 C++ 库，崩溃无法在 Rust 里兜住（与
//! ocr_helper 同一隔离取向）。合成完输出 wav，播放 macOS 用自带 afplay、
//! Windows 用 PowerShell SoundPlayer；停止 = 杀掉合成与播放子进程，不做
//! 进程内音频状态机。
//!
//! 音色：模型 voices.bin 里 103 个音色，sid 即索引（0-2 英文、3-57 中文女声、
//! 58-102 中文男声）。产品只暴露精选列表（见前端 SpeechPage），默认音色存
//! Settings.tts。合成时中文挂 number/date/phone 三条规则 FST（数字读法）。

use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// 引擎包（macOS universal2：Intel 与 Apple Silicon 同一份二进制）
#[cfg(target_os = "macos")]
const ENGINE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-osx-universal2-shared.tar.bz2";
/// 引擎包（Windows x64，MD/Release：bin/ 下含 sherpa-onnx-offline-tts.exe，
/// onnxruntime.dll 与 exe 同目录，Windows 的 DLL 搜索路径天然覆盖）
#[cfg(all(windows, target_arch = "x86_64"))]
const ENGINE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-win-x64-shared-MD-Release.tar.bz2";
/// 引擎包（Windows ARM64 原生，与 x64 同款布局）。x64 包在 ARM 机器上要过指令
/// 仿真，模型装载和推理都慢一倍以上（同句实测 10s → 4.4-5.7s），ARM 机器必须
/// 用原生包
#[cfg(all(windows, target_arch = "aarch64"))]
const ENGINE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-win-arm64-shared-MD-Release.tar.bz2";
/// 模型包（v1.1 中英双语，103 音色，fp32 完整精度，与平台无关）。曾用 int8
/// 量化版（140MB），真机对比英文音色塑料感明显、中文几乎无差，换回完整精度
const MODEL_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2";
const MODEL_DIR_NAME: &str = "kokoro-multi-lang-v1_1";

/// 下载源列表：GitHub 直连优先，其后是几个对 Release 直链做整段代理的国内加速
/// 实例。GitHub 在国内间歇性被掐（本机开发期实测时通时断），哪个域名单独被墙
/// 也说不准——逐个尝试、谁先成功用谁。注意：代理实例能改写传输内容，属于可用性
/// 与完整性的折中（上游未发布校验和，无法强校验）
fn source_urls(url: &str) -> Vec<String> {
    [
        "",
        "https://gh-proxy.com/",
        "https://ghfast.top/",
        "https://gh.llkk.cc/",
    ]
    .iter()
    .map(|prefix| format!("{prefix}{url}"))
    .collect()
}

/// 依次尝试各下载源，全部失败才报错（各源的具体错误进日志）
async fn fetch_any(app: &AppHandle, url: &str, dest: &Path, stage: &str) -> Result<(), String> {
    for (i, u) in source_urls(url).iter().enumerate() {
        match fetch(app, u, dest, stage).await {
            Ok(()) => {
                crate::user_log(&format!("[tts] 第 {} 个下载源成功", i + 1));
                return Ok(());
            }
            Err(e) => {
                crate::user_log(&format!("[tts] 下载源 {} 失败：{e}", i + 1));
            }
        }
    }
    Err("所有下载源均无法连接，请稍后重试".into())
}

/// 引擎 CLI 的相对路径（两平台包内布局同名不同后缀）
#[cfg(windows)]
const ENGINE_EXE: &str = "bin/sherpa-onnx-offline-tts.exe";
#[cfg(not(windows))]
const ENGINE_EXE: &str = "bin/sherpa-onnx-offline-tts";

/// 下载中闸门：重复点击「下载」不再起第二个并发下载（两个线程写同一文件必坏）
static DOWNLOADING: AtomicBool = AtomicBool::new(false);
/// 合成子进程表，每项 (代次, 块号, 子进程)：停止时逐个 kill（合成中停止 = 这次
/// 朗读作废）；并发预合成同时有多个在跑，驱动线程按「自己的代次 + 块号」认领
/// 各自的子进程。带代次是因为新旧两轮的驱动线程会短暂并存——早先按块号做下标、
/// 每轮开头整表重置，新一轮清表后旧线程还在按下标取，越界 panic 后锁被毒化，
/// 之后每次朗读都死在取锁上（点了没声音，重启才恢复）
static SYNTH: Mutex<Vec<(u64, usize, Child)>> = Mutex::new(Vec::new());
/// 播放子进程 PID（0 = 未播放）。播放要等到自然结束才能发「结束」事件，
/// 所以这里不持有 Child，只用 PID 支持中途 kill
static PLAYER_PID: AtomicU32 = AtomicU32::new(0);
/// 朗读代次：每次开始/停止都 +1。工作线程只认自己那一代，代次对不上就立刻收工
/// ——长文分块朗读时，旧线程不能把新一轮的「播放中」状态和进度事件搅乱
static RUN: AtomicU64 = AtomicU64::new(0);
/// 引擎+模型压缩包总字节数（HEAD content-length 实测）。None = 还没探到过
/// （网络不可达时前端显示不带数字的文案），探到就缓存、页面反复进入不再发请求
static REMOTE_SIZES: Mutex<Option<u64>> = Mutex::new(None);

/// 每块朗读的字数目标。首块短：合成「首块」的时间就是用户等待出声的时间，
/// 实测 CPU 推理 RTF≈0.5（1 秒音频算 0.5 秒），36 字≈7-8 秒音频≈3 秒出声；
/// 后续块长：合成速度是播放速度的两倍，120 字能在当前块播完前算好下一块，
/// 块间无缝。英文按字符计（1 词≈5 字符），同一阈值对两种语言都近似成立
const FIRST_CHUNK: usize = 36;
const REST_CHUNK: usize = 120;

/// 并发合成路数。每个合成进程都要装载一份模型（几百 MB 内存）、各占 4 线程，
/// 不开更多路；2 路让合成吞吐 ≈ 播放速度的 4 倍（RTF≈0.5），块间永远不用等合成
const PAR_SYNTH: usize = 2;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsStatus {
    /// 本平台是否具备朗读能力（macOS 与 Windows 已接入）
    pub supported: bool,
    /// 朗读功能开关（关闭时入口隐藏，音色包已被卸载）
    pub enabled: bool,
    /// 引擎 + 模型都已就绪
    pub installed: bool,
    /// 正在下载/安装（页面重新进入时据此恢复进度界面）
    pub downloading: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    /// "engine" | "model" | "extract-model"（下载/解压各段）
    stage: String,
    percent: f64,
}

fn root(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("tts")
}

fn model_dir(app: &AppHandle) -> PathBuf {
    root(app).join(MODEL_DIR_NAME)
}

/// 引擎二进制：解压目录名 = 包名去 .tar.bz2（sherpa-onnx 各 release 一贯如此），
/// 按目录名精确匹配——升级引擎版本/换架构（如 ARM64 机器从 x64 包换原生包）后，
/// 旧目录里的引擎是错的，绝不能拿去用；macOS 只有 universal2 一个包，保持按 exe
/// 查找的旧逻辑不变
fn engine_bin(app: &AppHandle) -> Option<PathBuf> {
    let engine_root = root(app).join("engine");
    let entries = std::fs::read_dir(&engine_root).ok()?;
    let expected = if cfg!(target_os = "macos") {
        None
    } else {
        Some(engine_dir_name())
    };
    for e in entries.flatten() {
        if let Some(want) = &expected {
            if e.file_name().to_str() != Some(want.as_str()) {
                continue;
            }
        }
        let p = e.path().join(ENGINE_EXE);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// 当前 ENGINE_URL 对应的解压目录名
fn engine_dir_name() -> String {
    ENGINE_URL
        .rsplit('/')
        .next()
        .unwrap()
        .trim_end_matches(".tar.bz2")
        .to_string()
}

fn model_ready(app: &AppHandle) -> bool {
    model_dir(app).join("model.onnx").exists()
}

fn installed(app: &AppHandle) -> bool {
    engine_bin(app).is_some() && model_ready(app)
}

fn cache_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
}

/// 清理异常退出残留的合成临时文件（tts-*.wav / tts-*.err）：正常路径上驱动线程
/// 收尾会删干净，但进程被杀/崩溃时来不及删，缓存目录会慢慢攒垃圾（每块 wav 约
/// 1MB）。只动修改时间超过 1 小时的——进行中的朗读会话文件都是新的，不会误删
fn sweep_stale_temp(app: &AppHandle) {
    let Ok(entries) = std::fs::read_dir(cache_dir(app)) else {
        return;
    };
    let stale = Duration::from_secs(3600);
    let now = std::time::SystemTime::now();
    for e in entries.flatten() {
        let p = e.path();
        let is_temp = p
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("tts-") && (n.ends_with(".wav") || n.ends_with(".err")));
        if !is_temp {
            continue;
        }
        let is_old = e
            .metadata()
            .and_then(|m| m.modified())
            .map(|m| now.duration_since(m).unwrap_or(stale) >= stale)
            .unwrap_or(false);
        if is_old {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// 合成缓存路径：键 = 模型代 + 音色 + 语速 + 中文规则路数 + 块文本 的散列（尾部
/// 带字数，进一步压低碰撞危害）。同句同音色同语速重播直接复用现成 wav，不再等
/// 一遍模型装载；语速进键——不同档位是不同音频，混用会串。不绑窗口生命周期：
/// 浮窗常驻隐藏、关闭≠销毁，且缓存的价值正在于跨窗口复用
fn cache_path(base: &Path, sid: u32, speed: f64, zh: bool, text: &str) -> PathBuf {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    (MODEL_DIR_NAME, sid, speed.to_bits(), zh, text).hash(&mut h);
    let chars = text.chars().count();
    base.join("tts-cache")
        .join(format!("{:016x}-{chars}.wav", h.finish()))
}

/// 缓存总量上限：一百 MB ≈ 上千句短句。超过按修改时间从旧到新淘汰——
/// 淘汰不绑窗口关闭（浮窗常驻隐藏，关闭事件基本不会来），写满即收就自维护了
const TTS_CACHE_CAP: u64 = 100 * 1024 * 1024;

/// 淘汰最近 10 分钟内写入的文件：别的朗读会话可能马上要播它
fn prune_cache(base: &Path) {
    let Ok(entries) = std::fs::read_dir(base.join("tts-cache")) else {
        return;
    };
    let now = std::time::SystemTime::now();
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let md = e.metadata().ok()?;
            if p.extension().and_then(|x| x.to_str()) != Some("wav") {
                return None;
            }
            Some((p, md.len(), md.modified().ok()?))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= TTS_CACHE_CAP {
        return;
    }
    files.sort_by_key(|f| f.2);
    for (p, size, mtime) in files {
        if total <= TTS_CACHE_CAP {
            break;
        }
        let fresh = now
            .duration_since(mtime)
            .map(|d| d < Duration::from_secs(600))
            .unwrap_or(true);
        if fresh || std::fs::remove_file(&p).is_err() {
            continue;
        }
        total -= size;
    }
}

#[tauri::command]
pub fn tts_status(app: AppHandle) -> TtsStatus {
    TtsStatus {
        // macOS 与 Windows x64 都已接入（引擎/播放均有对应实现）
        supported: cfg!(any(target_os = "macos", target_os = "windows")),
        enabled: crate::settings::current(&app).tts.enabled,
        installed: installed(&app),
        downloading: DOWNLOADING.load(Ordering::SeqCst),
    }
}

#[tauri::command]
pub async fn tts_download(app: AppHandle) -> Result<(), String> {
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        return Err("正在下载中".into());
    }
    let result = download_all(&app).await;
    DOWNLOADING.store(false, Ordering::SeqCst);
    match &result {
        Ok(()) => crate::user_log("[tts] 音色包安装完成"),
        Err(e) => crate::user_log(&format!("[tts] 安装失败：{e}")),
    }
    if result.is_ok() {
        // 装好即广播：已开着的朗读窗立刻亮出入口，不必重开
        let _ = app.emit("tts://changed", ());
    }
    result
}

async fn download_all(app: &AppHandle) -> Result<(), String> {
    let root = root(app);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    if engine_bin(app).is_none() {
        let tar = root.join("engine.tar.bz2");
        fetch_any(app, ENGINE_URL, &tar, "engine").await?;
        // 引擎解压（2-4 秒）不发进度事件：界面上进度条和文案一起冻结，
        // 用户感知只是「下载停了一下」；任何状态切换反而显得卡住
        extract(&tar, &root.join("engine"))?;
        // 换架构/升级版本后旧引擎目录作废（一份 ~150MB），顺手清掉
        #[cfg(windows)]
        cleanup_old_engines(app, &root.join("engine").join(engine_dir_name()));
        let _ = std::fs::remove_file(&tar);
    }
    if !model_ready(app) {
        let tar = root.join("model.tar.bz2");
        fetch_any(app, MODEL_URL, &tar, "model").await?;
        emit(app, "extract-model", 0.0);
        // 模型包顶层目录就是 MODEL_DIR_NAME，直接解到 tts 根下
        extract(&tar, &root)?;
        cleanup_old_models(app);
        emit(app, "extract-model", 100.0);
        let _ = std::fs::remove_file(&tar);
    }
    Ok(())
}

/// 清掉 tts 根下其他 kokoro-* 模型目录（换模型版本后旧包作废，一份几百 MB）：
/// 只删「名字以 kokoro- 开头且含模型文件」的目录，当前这份除外。
/// 引擎的同类清理只对 Windows 需要（目录名带架构），模型与平台无关、两平台共用
fn cleanup_old_models(app: &AppHandle) {
    let tts_root = root(app);
    let Ok(entries) = std::fs::read_dir(&tts_root) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        let name = p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("kokoro-"));
        let is_model = p.join("model.onnx").exists() || p.join("model.int8.onnx").exists();
        if name && is_model && !p.ends_with(MODEL_DIR_NAME) {
            let _ = std::fs::remove_dir_all(p);
        }
    }
}

/// 各阶段在「一条总进度」里的区间：引擎下载 0-18 → 音色下载 22-86 →
/// 音色解压 86-100（引擎解压 18-22 不发事件，进度冻结见 download_all 注释）。
/// 权重按下载体积与解压耗时近似——下载主导总时长。用户心智里这就是
/// 「一个音色包」，推理框架是实现细节，不该在界面上拆成两条进度、
/// 更不该让进度条中途归零重来
const STAGE_RANGE: &[(&str, f64, f64)] = &[
    ("engine", 0.0, 18.0),
    ("model", 22.0, 86.0),
    ("extract-model", 86.0, 100.0),
];

fn emit(app: &AppHandle, stage: &str, percent: f64) {
    // 无总长度的源发 -1（进度未知），原样透传——前端据此只留文字不画假进度条
    let percent = if percent < 0.0 {
        percent
    } else {
        match STAGE_RANGE.iter().find(|(s, _, _)| *s == stage) {
            Some((_, from, to)) => from + (to - from) * percent / 100.0,
            None => percent,
        }
    };
    let _ = app.emit(
        "tts://progress",
        Progress {
            stage: stage.into(),
            percent,
        },
    );
}

/// 清掉引擎目录下其他 sherpa-onnx-* 包（换架构/升级版本后旧包作废，一份
/// ~150MB）：只删「名字以 sherpa-onnx- 开头且含引擎 exe」的目录，刚解压的这份
/// 除外，其余内容一概不动
#[cfg(windows)]
fn cleanup_old_engines(app: &AppHandle, fresh_dir: &Path) {
    let engine_root = root(app).join("engine");
    let Ok(entries) = std::fs::read_dir(&engine_root) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p == fresh_dir
            || !p
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("sherpa-onnx-"))
            || !p.join(ENGINE_EXE).exists()
        {
            continue;
        }
        let _ = std::fs::remove_dir_all(p);
    }
}

/// 流式下载到文件，每约 1MB 回报一次进度（GitHub 会 302 到对象存储，reqwest
/// 默认跟随；不设总超时——220MB 在慢网下可能几分钟）
async fn fetch(app: &AppHandle, url: &str, dest: &Path, stage: &str) -> Result<(), String> {
    use futures_util::StreamExt;
    let client = reqwest::Client::builder()
        .user_agent("magpie-tts")
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败（服务器返回 {}）", resp.status().as_u16()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut got: u64 = 0;
    let mut reported: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断：{e}"))?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        if got - reported > 1_000_000 {
            reported = got;
            // 代理源常用 chunked 传输（无 content-length）：-1 表示进度未知，
            // 前端显示「正在下载…」而非一个假的 0%
            let percent = if total > 0 {
                (got as f64 / total as f64 * 100.0).min(99.0)
            } else {
                -1.0
            };
            emit(app, stage, percent);
        }
    }
    let _ = file.flush();
    // 有总量的源已经在流里报过真实进度，这里统一收口到 100%
    emit(app, stage, 100.0);
    // 下载完成但文件为空 = 磁盘/网络异常，别把坏包当成功
    if got == 0 {
        return Err("下载失败：文件为空".into());
    }
    Ok(())
}

/// 解压 tar.bz2：Rust 侧解压（bzip2 + tar crate），不依赖用户系统的解压命令
/// ——Windows 自带 tar.exe 对 bz2 的支持不可控（各版本行为不一致），macOS 的
/// bsdtar 虽然可靠，但两平台走同一实现，行为一致、失败原因也只有一种
fn extract(tar: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let f = std::fs::File::open(tar).map_err(|e| e.to_string())?;
    let bz = bzip2::read::BzDecoder::new(std::io::BufReader::new(f));
    tar::Archive::new(bz)
        .unpack(dest)
        .map_err(|e| format!("解压失败：{e}"))
}

/// 控制台子进程不弹黑窗（Windows 上 GUI 进程默认会给子进程开控制台）
#[cfg(windows)]
fn no_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn no_console(_cmd: &mut Command) {}

/// 播放一块 wav 的子进程，返回 Child 供顺序播放与中途 kill。
/// macOS 用自带 afplay；Windows 用系统 PowerShell 的 SoundPlayer（.NET 自带，
/// PlaySync 同步播完即退出），不引第三方音频栈。路径插进 PS 单引号字符串，
/// 路径里的单引号按 PS 规则双写转义（用户名可能带 '）
#[cfg(windows)]
fn spawn_player(wav: &Path) -> std::io::Result<Child> {
    let path = wav.display().to_string().replace('\'', "''");
    let script = format!("(New-Object Media.SoundPlayer '{path}').PlaySync()");
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", script.as_str()])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_console(&mut cmd);
    cmd.spawn()
}

#[cfg(not(windows))]
fn spawn_player(wav: &Path) -> std::io::Result<Child> {
    Command::new("afplay")
        .arg(wav)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

/// 按 PID 终止播放进程。unix 发 TERM 即可；Windows 用 taskkill /F
/// （kill 命令不存在，TERM 语义也没有）
#[cfg(windows)]
fn kill_player(pid: u32) {
    let arg = pid.to_string();
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", arg.as_str(), "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_console(&mut cmd);
    let _ = cmd.status();
}

#[cfg(not(windows))]
fn kill_player(pid: u32) {
    let _ = Command::new("kill").arg(pid.to_string()).status();
}

/// 取合成子进程表的锁，容忍 poison：表在任何时刻都是合法状态，不该因为某个
/// 线程 panic 过就让之后的朗读全部报废
fn synth() -> std::sync::MutexGuard<'static, Vec<(u64, usize, Child)>> {
    SYNTH.lock().unwrap_or_else(|e| e.into_inner())
}

/// OOV 兜底改写：整块全是词典查不到的词（缩写/品牌名/标识符/表情）时，引擎
/// 会把所有词都跳过 → 零 token → 直接报错（普通单词 hello/apple 都能读，
/// GPT/iPhone/v2/en_voice 这类不行）。重试前把文本改写成词典可查的形态：
/// 驼峰拆词（iPhone→i Phone）、全大写缩写逐字母（GPT→G P T）、字母数字
/// 分界（v2→v 2）、其余符号转空格（en_voice→en voice）。改写无变化不重试
fn oov_fallback(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if !c.is_ascii_alphanumeric() {
            out.push(' ');
            continue;
        }
        if let Some(&p) = i.checked_sub(1).and_then(|j| chars.get(j)) {
            if p.is_ascii_alphanumeric() {
                // 词内分界：大小写交界（i|Phone）、大写缩写字母间（G|P|T）、
                // 字母与数字交界（v|2）处补空格
                let split = (p.is_ascii_uppercase() && c.is_ascii_uppercase())
                    || (p.is_ascii_lowercase() && c.is_ascii_uppercase())
                    || (p.is_ascii_digit() != c.is_ascii_digit());
                if split {
                    out.push(' ');
                }
            }
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::oov_fallback;

    #[test]
    fn oov_rewrite() {
        assert_eq!(oov_fallback("GPT"), "G P T");
        assert_eq!(oov_fallback("iPhone"), "i Phone");
        assert_eq!(oov_fallback("v2"), "v 2");
        assert_eq!(oov_fallback("en_voice"), "en voice");
        assert_eq!(oov_fallback("hello"), "hello"); // 普通词不变
        assert_eq!(oov_fallback("中文"), "  "); // 非 ASCII 全转空格（调用方据此跳过重试）
        assert_eq!(oov_fallback("GPT-4o"), "G P T 4 o");
    }
}

/// 朗读一段文字：`sid` 为空时按语言取设置里的默认音色（试听指定音色则直接传 sid，
/// 免得依赖「先落盘再朗读」的时序），后台合成后播放。
/// 立即返回，不阻塞 UI（长文本合成需要数秒）。
#[tauri::command]
pub fn tts_speak(
    app: AppHandle,
    window: tauri::WebviewWindow,
    text: String,
    lang: String,
    sid: Option<u32>,
) -> Result<(), String> {
    if !installed(&app) {
        return Err("音色包尚未安装".into());
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("没有可朗读的文字".into());
    }
    let bin = engine_bin(&app).ok_or("朗读引擎缺失，请重新下载")?;
    let m = model_dir(&app);
    // "auto" = 由内容判断（结果窗的译文可能是中文也可能是英文）
    let lang = if lang == "auto" || lang.is_empty() {
        detect_lang(&text).to_string()
    } else {
        lang
    };
    let (sid, speed) = {
        let s = crate::settings::current(&app);
        let sid = sid.unwrap_or_else(|| {
            if lang == "en" {
                s.tts.en_voice
            } else {
                s.tts.zh_voice
            }
        });
        // 语速钳制：配置可能被手改成离谱值，这里兜住引擎的合理区间
        (sid, s.tts.speed.clamp(0.5, 2.0))
    };
    sweep_stale_temp(&app);
    stop_playback();
    let run = RUN.fetch_add(1, Ordering::SeqCst) + 1;
    let chunks = chunk_text(&text, FIRST_CHUNK, REST_CHUNK);
    let label = window.label().to_string();

    // 中文数字/日期/电话读法靠规则 FST；英文不挂，避免规则误伤
    let mut args: Vec<String> = vec![
        format!("--kokoro-model={}", m.join("model.onnx").display()),
        format!("--kokoro-voices={}", m.join("voices.bin").display()),
        format!("--kokoro-tokens={}", m.join("tokens.txt").display()),
        format!(
            "--kokoro-lexicon={},{}",
            m.join("lexicon-us-en.txt").display(),
            m.join("lexicon-zh.txt").display()
        ),
        "--num-threads=4".into(),
        format!("--sid={sid}"),
        // 语速系数（>1 更慢）：设置页三档（1.1/1.0/0.9），默认 1.0 恒等不变形
        format!("--kokoro-length-scale={speed}"),
    ];
    if lang != "en" {
        args.push(format!(
            "--tts-rule-fsts={},{},{}",
            m.join("number-zh.fst").display(),
            m.join("date-zh.fst").display(),
            m.join("phone-zh.fst").display()
        ));
    }

    let chars = text.chars().count();
    std::thread::spawn(move || {
        let dir = cache_dir(&app);
        // 缓存目录就绪（首用/被清过也能落盘）
        let _ = std::fs::create_dir_all(dir.join("tts-cache"));
        let n = chunks.len();
        let mut made: Vec<PathBuf> = Vec::new();
        let mut wavs: Vec<PathBuf> = Vec::new();
        let mut cached = vec![false; n];
        crate::user_log(&format!(
            "[tts] 开始朗读：{chars} 字 / {n} 块 / lang={lang} / sid={sid} / 并发 {PAR_SYNTH}"
        ));
        // 单驱动线程循环：补满并发合成槽 → 等第 i 块合成完 → 等上一块播完 → 播第 i 块。
        // 合成（RTF≈0.5×2 路）远快于播放（1x），槽位始终有存货，块间无缝
        let mut next = 0usize;
        let mut player: Option<Child> = None;
        'outer: for i in 0..n {
            if RUN.load(Ordering::SeqCst) != run {
                break 'outer;
            }
            // 补满并发槽（槽位少一个才补一个，失败即整轮作废）
            while next < n {
                let running = synth().iter().filter(|s| s.0 == run).count();
                // 首块只开一路：每路进程都要完整装载一遍模型，首块等待期间两路
                // 并装在 CPU/磁盘上互相拖慢（4 核机器实测首块明显变慢）；进入下
                // 一迭代（首块已合成完）再补满并发，块间衔接不受影响
                let cap = if i == 0 { 1 } else { PAR_SYNTH };
                if running >= cap {
                    break;
                }
                let tmp = dir.join(format!("tts-{run}-{next}.wav"));
                let cache = cache_path(&dir, sid, speed, lang != "en", &chunks[next]);
                // 已合成过的内容直接用缓存里的现成 wav：不装模型、不等推理
                let hit = std::fs::metadata(&cache).map(|m| m.len() > 44).unwrap_or(false);
                wavs.push(cache);
                if hit {
                    cached[next] = true;
                    next += 1;
                } else {
                    let err = dir.join(format!("tts-{run}-{next}.err"));
                    made.push(tmp.clone());
                    made.push(err.clone());
                    match spawn_synth(&bin, &args, &tmp, &chunks[next], &err) {
                        Ok(c) => {
                            synth().push((run, next, c));
                            next += 1;
                        }
                        Err(e) => {
                            crate::user_log(&format!("[tts] 合成进程启动失败：{e}"));
                            break 'outer;
                        }
                    }
                }
            }
            // 等第 i 块合成完成（缓存命中的块已是现成 wav，无需等待）
            let wav = wavs[i].clone();
            if !cached[i] {
                // OOV 重试只做一次：改写形态再失败就是引擎侧的硬失败
                let mut retried = false;
                loop {
                    if RUN.load(Ordering::SeqCst) != run {
                        break 'outer;
                    }
                    let poll = synth()
                        .iter_mut()
                        .find(|s| s.0 == run && s.1 == i)
                        .map(|s| s.2.try_wait().ok().flatten());
                    match poll {
                        None => break 'outer, // 被 stop 清空 = 作废
                        Some(None) => std::thread::sleep(Duration::from_millis(40)),
                        Some(Some(st)) => {
                            synth().retain(|s| !(s.0 == run && s.1 == i));
                            if !st.success() {
                                // OOV 兜底：改写成词典可查的形态重试一次，成功产物
                                // 照常按原文进缓存；改写无效或重试仍失败才放弃
                                let alt = oov_fallback(&chunks[i]);
                                let retryable = !retried
                                    && alt != chunks[i]
                                    && alt.chars().any(|c| c.is_ascii_alphanumeric());
                                if retryable {
                                    retried = true;
                                    crate::user_log(&format!(
                                        "[tts] 第 {}/{} 块含词典外词，改写重试",
                                        i + 1,
                                        n
                                    ));
                                    let tmp = dir.join(format!("tts-{run}-{i}.wav"));
                                    let err = dir.join(format!("tts-{run}-{i}.err"));
                                    match spawn_synth(&bin, &args, &tmp, &alt, &err) {
                                        Ok(c) => {
                                            synth().push((run, i, c));
                                            continue;
                                        }
                                        Err(e) => {
                                            crate::user_log(&format!(
                                                "[tts] 合成进程启动失败：{e}"
                                            ));
                                            break 'outer;
                                        }
                                    }
                                }
                                // 引擎报错只在 stderr（已落到旁路文件），带出来才有诊断价值
                                let errtxt =
                                    std::fs::read_to_string(dir.join(format!("tts-{run}-{i}.err")))
                                        .unwrap_or_default();
                                crate::user_log(&format!(
                                    "[tts] 第 {}/{} 块合成失败：{}",
                                    i + 1,
                                    n,
                                    errtxt.trim().chars().rev().take(200).collect::<String>().chars().rev().collect::<String>()
                                ));
                                break 'outer;
                            }
                            // 缓存未命中的块：合成成功即收编进缓存（同卷改名，原子）。
                            // 改名失败不影响本次播放，退回播临时文件
                            let tmp = dir.join(format!("tts-{run}-{i}.wav"));
                            if std::fs::rename(&tmp, &wav).is_err() {
                                wavs[i] = tmp;
                            }
                            break;
                        }
                    }
                }
            }
            let bytes = std::fs::metadata(&wav).map(|m| m.len()).unwrap_or(0);
            crate::user_log(&format!(
                "[tts] 第 {}/{} 块就绪：{} 字 / {}KB",
                i + 1,
                n,
                chunks[i].chars().count(),
                bytes / 1024
            ));
            // 等上一块播完（本块播放期间下一块已在合成）。应播/实播一起记：
            // 实播 ≈ 应播 = 正常；实播远小于应播 = 播放进程提前退出（无声根因）
            if let Some(mut p) = player.take() {
                let started = std::time::Instant::now();
                let st = p.wait();
                // 清零要带代次守卫：被新一轮顶掉时新一轮可能已写入自己的播放
                // PID，无条件清零会把它抹掉，之后停止就杀不到新进程
                if RUN.load(Ordering::SeqCst) == run {
                    PLAYER_PID.store(0, Ordering::SeqCst);
                }
                crate::user_log(&format!(
                    "[tts] 播完一块：应播 {}ms / 实播 {}ms / exit={}",
                    wav_ms(&wavs[i - 1]),
                    started.elapsed().as_millis(),
                    st.ok().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1)
                ));
                if RUN.load(Ordering::SeqCst) != run {
                    break 'outer;
                }
            }
            let child = match spawn_player(&wav) {
                Ok(c) => c,
                Err(e) => {
                    crate::user_log(&format!("[tts] 播放失败：{e}"));
                    break 'outer;
                }
            };
            PLAYER_PID.store(child.id(), Ordering::SeqCst);
            player = Some(child);
        }
        // 最后一块播完 / 停止时立即返回（停止路径上进程已被 kill）
        if let Some(mut p) = player.take() {
            let started = std::time::Instant::now();
            let st = p.wait();
            if RUN.load(Ordering::SeqCst) == run {
                PLAYER_PID.store(0, Ordering::SeqCst);
            }
            crate::user_log(&format!(
                "[tts] 播完一块：应播 {}ms / 实播 {}ms / exit={}",
                wav_ms(wavs.last().unwrap()),
                started.elapsed().as_millis(),
                st.ok().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1)
            ));
        }
        // 收掉还在跑的合成子进程（失败/停止路径会有残余）。只收自己这一轮的：
        // 被新一轮顶掉时表里已经是新一轮的子进程，不能连带杀掉
        {
            let mut g = synth();
            let (mine, rest): (Vec<_>, Vec<_>) =
                std::mem::take(&mut *g).into_iter().partition(|s| s.0 == run);
            *g = rest;
            for (_, _, mut c) in mine {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
        // 缓存总量超限则从最旧开始淘汰（刚收编/正在播的文件很新，不会被选中）
        prune_cache(&dir);
        // 代次没被顶掉（正常读完 / 用户按的是停止）才发结束事件；被新一轮接手时
        // 不发，否则会把新一轮刚点亮的「播放中」状态清掉
        if RUN.load(Ordering::SeqCst) == run {
            let _ = app.emit_to(label.as_str(), "tts://end", ());
        }
        for p in made {
            let _ = std::fs::remove_file(p);
        }
    });
    Ok(())
}

/// wav 应播毫秒数（字节 / 48：24000Hz × 2 字节采样）
fn wav_ms(wav: &Path) -> u128 {
    std::fs::metadata(wav)
        .map(|m| m.len() as u128 * 1000 / 48_000)
        .unwrap_or(0)
}

/// 起一个合成子进程。stderr 落到旁路文件：引擎报错只在 stderr，失败时读出来
/// 进用户日志，否则永远只能看到「失败」两个字
fn spawn_synth(
    bin: &Path,
    base_args: &[String],
    wav: &Path,
    text: &str,
    err: &Path,
) -> Result<Child, String> {
    let err_f = std::fs::File::create(err).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(bin);
    cmd.args(base_args)
        .arg(format!("--output-filename={}", wav.display()))
        .arg(text)
        .stdout(Stdio::null())
        .stderr(Stdio::from(err_f));
    no_console(&mut cmd);
    cmd.spawn().map_err(|e| e.to_string())
}

/// 判断朗读语言：汉字量达到字母量 1/5 就按中文读。结果窗的文本通常纯中文或
/// 纯英文，混排时以主体语言为准——夹几个英文术语不该让整段改用英文音色
fn detect_lang(text: &str) -> &'static str {
    let mut cjk = 0usize;
    let mut letters = 0usize;
    for ch in text.chars() {
        if ('\u{4e00}'..='\u{9fff}').contains(&ch) {
            cjk += 1;
        } else if ch.is_ascii_alphabetic() {
            letters += 1;
        }
    }
    if cjk > 0 && cjk * 5 >= letters {
        "zh"
    } else {
        "en"
    }
}

/// 切成朗读块：先按句末标点断句，再按字数目标装箱。首块用 `first_max` 尽快出声，
/// 之后用 `rest_max` 让合成赶上播放
fn chunk_text(text: &str, first_max: usize, rest_max: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for sentence in split_sentences(text) {
        for piece in hard_split(&sentence, 60) {
            let max = if out.is_empty() { first_max } else { rest_max };
            if cur.chars().count() + piece.chars().count() <= max {
                cur.push_str(&piece);
            } else {
                if !cur.trim().is_empty() {
                    out.push(cur.trim().to_string());
                }
                cur = piece;
            }
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    if out.is_empty() {
        out.push(text.trim().to_string());
    }
    out
}

fn split_sentences(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in text.chars() {
        cur.push(ch);
        if matches!(
            ch,
            '。' | '！' | '？' | '；' | '…' | '.' | '!' | '?' | ';' | '\n'
        ) {
            if !cur.trim().is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            cur.clear();
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

/// 单句过长时在标点/空格处断开；实在找不到标点就在 60 字后硬切，避免一块读半分钟
fn hard_split(s: &str, max: usize) -> Vec<String> {
    if s.chars().count() <= max {
        return vec![s.to_string()];
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut n = 0usize;
    for ch in s.chars() {
        cur.push(ch);
        n += 1;
        if n >= max && matches!(ch, '，' | ',' | '、' | '：' | ':' | ' ') || n >= max + 20 {
            if !cur.trim().is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            cur.clear();
            n = 0;
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

#[tauri::command]
pub fn tts_stop() {
    stop_playback();
}

/// 下载量（引擎+模型压缩包总字节）：对下载源逐个发 HEAD 取 content-length，
/// 拿不到（全被墙/代理不支持）返回 null，前端回退到不带数字的文案。成功即缓存
#[tauri::command]
pub async fn tts_remote_sizes() -> Option<u64> {
    if let Some(v) = REMOTE_SIZES.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return Some(v);
    }
    let client = reqwest::Client::builder()
        .user_agent("magpie-tts")
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .build()
        .ok()?;
    let mut total = 0u64;
    for url in [ENGINE_URL, MODEL_URL] {
        let mut got = None;
        for u in source_urls(url) {
            let size = client
                .head(&u)
                .send()
                .await
                .ok()?
                .error_for_status()
                .ok()?
                .content_length();
            if let Some(s) = size {
                got = Some(s);
                break;
            }
        }
        total += got?;
    }
    crate::user_log(&format!("[tts] 下载包总大小：{} MB", total / 1_000_000));
    *REMOTE_SIZES.lock().unwrap_or_else(|e| e.into_inner()) = Some(total);
    Some(total)
}

/// 目录实际占用的字节数（递归）
fn dir_size(p: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(p) {
        for e in entries.flatten() {
            let path = e.path();
            if path.is_dir() {
                total += dir_size(&path);
            } else if let Ok(md) = e.metadata() {
                total += md.len();
            }
        }
    }
    total
}

/// 音色包装机占用实测：tts 目录（引擎+模型）+ 合成缓存。卸载确认框里显示的
/// 数字用真实值，不再写死估算
#[tauri::command]
pub fn tts_installed_size(app: AppHandle) -> u64 {
    let mut total = dir_size(&root(&app));
    let cache = cache_dir(&app);
    total += dir_size(&cache.join("tts-cache"));
    if let Ok(entries) = std::fs::read_dir(&cache) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with("tts-") {
                total += e.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    total
}

/// 卸载音色包：删掉引擎、模型和合成缓存，朗读入口随之消失（重新下载即恢复）。
/// 设置里的音色偏好保留——重装后无需重选
#[tauri::command]
pub async fn tts_uninstall(app: AppHandle) -> Result<(), String> {
    if DOWNLOADING.load(Ordering::SeqCst) {
        return Err("正在下载中".into());
    }
    stop_playback();
    let tts_root = root(&app);
    if tts_root.exists() {
        // 刚被停掉的合成进程可能还没完全退出、引擎文件仍被占用，稍候重试一次
        if std::fs::remove_dir_all(&tts_root).is_err() {
            std::thread::sleep(Duration::from_millis(300));
            std::fs::remove_dir_all(&tts_root).map_err(|e| format!("删除失败：{e}"))?;
        }
    }
    let cache = cache_dir(&app);
    let _ = std::fs::remove_dir_all(cache.join("tts-cache"));
    // 散落的合成临时文件（tts-*.wav / tts-*.err）
    if let Ok(entries) = std::fs::read_dir(&cache) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with("tts-") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    crate::user_log("[tts] 音色包已卸载");
    let _ = app.emit("tts://changed", ());
    Ok(())
}

fn stop_playback() {
    // 先推代次：工作线程下次检查即退出，不再动刚被新一轮接管的子进程
    RUN.fetch_add(1, Ordering::SeqCst);
    for (_, _, mut c) in synth().drain(..) {
        let _ = c.kill();
        let _ = c.wait();
    }
    let pid = PLAYER_PID.swap(0, Ordering::SeqCst);
    if pid > 0 {
        // 不持有播放子进程（它要等自然结束才能回报），按 PID 终止即可
        kill_player(pid);
    }
}
