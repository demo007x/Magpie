//! 本地朗读（TTS）：Kokoro-82M int8 ONNX 模型 + sherpa-onnx 命令行引擎。
//!
//! 为什么是「按需下载」而不是打进安装包：模型与引擎解压后约 320MB，不朗读的
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
#[cfg(windows)]
const ENGINE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.1/sherpa-onnx-v2.0.1-win-x64-shared-MD-Release.tar.bz2";
/// 模型包（v1.1 中英双语，103 音色，int8 量化，与平台无关）
const MODEL_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2";
const MODEL_DIR_NAME: &str = "kokoro-int8-multi-lang-v1_1";

/// 引擎 CLI 的相对路径（两平台包内布局同名不同后缀）
#[cfg(windows)]
const ENGINE_EXE: &str = "bin/sherpa-onnx-offline-tts.exe";
#[cfg(not(windows))]
const ENGINE_EXE: &str = "bin/sherpa-onnx-offline-tts";

/// 下载中闸门：重复点击「下载」不再起第二个并发下载（两个线程写同一文件必坏）
static DOWNLOADING: AtomicBool = AtomicBool::new(false);
/// 合成子进程槽位（按块号索引）：停止时逐个 kill（合成中停止 = 这次朗读作废）。
/// 并发预合成同时有多个在跑，Vec 槽位让驱动线程按块号等待各自的完成
static SYNTH: Mutex<Vec<Option<Child>>> = Mutex::new(Vec::new());
/// 播放子进程 PID（0 = 未播放）。播放要等到自然结束才能发「结束」事件，
/// 所以这里不持有 Child，只用 PID 支持中途 kill
static PLAYER_PID: AtomicU32 = AtomicU32::new(0);
/// 朗读代次：每次开始/停止都 +1。工作线程只认自己那一代，代次对不上就立刻收工
/// ——长文分块朗读时，旧线程不能把新一轮的「播放中」状态和进度事件搅乱
static RUN: AtomicU64 = AtomicU64::new(0);

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
    /// 本平台是否具备朗读能力（当前仅 macOS）
    pub supported: bool,
    /// 引擎 + 模型都已就绪
    pub installed: bool,
    /// 正在下载/安装（页面重新进入时据此恢复进度界面）
    pub downloading: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    /// "engine" | "model" | "extract"
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

/// 引擎二进制：解压目录名带版本号（sherpa-onnx-vX-osx-... / ...-win-...），按内容
/// 查找而不是拼死路径——升级引擎版本时只改 URL，不必同步改路径
fn engine_bin(app: &AppHandle) -> Option<PathBuf> {
    let engine_root = root(app).join("engine");
    let entries = std::fs::read_dir(&engine_root).ok()?;
    for e in entries.flatten() {
        let p = e.path().join(ENGINE_EXE);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn model_ready(app: &AppHandle) -> bool {
    model_dir(app).join("model.int8.onnx").exists()
}

fn installed(app: &AppHandle) -> bool {
    engine_bin(app).is_some() && model_ready(app)
}

fn cache_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
}

#[tauri::command]
pub fn tts_status(app: AppHandle) -> TtsStatus {
    TtsStatus {
        // macOS 与 Windows x64 都已接入（引擎/播放均有对应实现）
        supported: cfg!(any(target_os = "macos", target_os = "windows")),
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
    result
}

async fn download_all(app: &AppHandle) -> Result<(), String> {
    let root = root(app);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    if engine_bin(app).is_none() {
        let tar = root.join("engine.tar.bz2");
        fetch(app, ENGINE_URL, &tar, "engine").await?;
        emit(app, "extract", 0.0);
        extract(&tar, &root.join("engine"))?;
        let _ = std::fs::remove_file(&tar);
    }
    if !model_ready(app) {
        let tar = root.join("model.tar.bz2");
        fetch(app, MODEL_URL, &tar, "model").await?;
        emit(app, "extract", 0.0);
        // 模型包顶层目录就是 MODEL_DIR_NAME，直接解到 tts 根下
        extract(&tar, &root)?;
        let _ = std::fs::remove_file(&tar);
    }
    Ok(())
}

fn emit(app: &AppHandle, stage: &str, percent: f64) {
    let _ = app.emit(
        "tts://progress",
        Progress {
            stage: stage.into(),
            percent,
        },
    );
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
            let percent = if total > 0 {
                (got as f64 / total as f64 * 100.0).min(99.0)
            } else {
                0.0
            };
            emit(app, stage, percent);
        }
    }
    let _ = file.flush();
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
    let sid = sid.unwrap_or_else(|| {
        let s = crate::settings::current(&app);
        if lang == "en" {
            s.tts.en_voice
        } else {
            s.tts.zh_voice
        }
    });
    stop_playback();
    let run = RUN.fetch_add(1, Ordering::SeqCst) + 1;
    let chunks = chunk_text(&text, FIRST_CHUNK, REST_CHUNK);
    let label = window.label().to_string();

    // 中文数字/日期/电话读法靠规则 FST；英文不挂，避免规则误伤
    let mut args: Vec<String> = vec![
        format!("--kokoro-model={}", m.join("model.int8.onnx").display()),
        format!("--kokoro-voices={}", m.join("voices.bin").display()),
        format!("--kokoro-tokens={}", m.join("tokens.txt").display()),
        format!(
            "--kokoro-lexicon={},{}",
            m.join("lexicon-us-en.txt").display(),
            m.join("lexicon-zh.txt").display()
        ),
        "--num-threads=4".into(),
        format!("--sid={sid}"),
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
        let n = chunks.len();
        let mut made: Vec<PathBuf> = Vec::new();
        let mut wavs: Vec<PathBuf> = Vec::new();
        {
            let mut g = SYNTH.lock().unwrap();
            g.clear();
            g.extend((0..n).map(|_| None));
        }
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
                let running = SYNTH.lock().unwrap().iter().filter(|s| s.is_some()).count();
                if running >= PAR_SYNTH {
                    break;
                }
                let wav = dir.join(format!("tts-{run}-{next}.wav"));
                let err = dir.join(format!("tts-{run}-{next}.err"));
                made.push(wav.clone());
                made.push(err.clone());
                wavs.push(wav.clone());
                match spawn_synth(&bin, &args, &wav, &chunks[next], &err) {
                    Ok(c) => {
                        SYNTH.lock().unwrap()[next] = Some(c);
                        next += 1;
                    }
                    Err(e) => {
                        crate::user_log(&format!("[tts] 合成进程启动失败：{e}"));
                        break 'outer;
                    }
                }
            }
            // 等第 i 块合成完成
            let wav = wavs[i].clone();
            loop {
                if RUN.load(Ordering::SeqCst) != run {
                    break 'outer;
                }
                let poll = SYNTH.lock().unwrap()[i]
                    .as_mut()
                    .map(|c| c.try_wait().ok().flatten());
                match poll {
                    None => break 'outer, // 被 stop 清空 = 作废
                    Some(None) => std::thread::sleep(Duration::from_millis(40)),
                    Some(Some(st)) => {
                        SYNTH.lock().unwrap()[i] = None;
                        if !st.success() {
                            // 引擎报错只在 stderr（已落到旁路文件），带出来才有诊断价值
                            let errtxt = std::fs::read_to_string(dir.join(format!("tts-{run}-{i}.err")))
                                .unwrap_or_default();
                            crate::user_log(&format!(
                                "[tts] 第 {}/{} 块合成失败：{}",
                                i + 1,
                                n,
                                errtxt.trim().chars().rev().take(200).collect::<String>().chars().rev().collect::<String>()
                            ));
                            break 'outer;
                        }
                        break;
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
        // 收掉还在跑的合成子进程（失败/停止路径会有残余）
        {
            let mut g = SYNTH.lock().unwrap();
            for s in g.iter_mut() {
                if let Some(mut c) = s.take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
            g.clear();
        }
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

fn stop_playback() {
    // 先推代次：工作线程下次检查即退出，不再动刚被新一轮接管的子进程
    RUN.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut g) = SYNTH.lock() {
        for s in g.iter_mut() {
            if let Some(mut c) = s.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
        g.clear();
    }
    let pid = PLAYER_PID.swap(0, Ordering::SeqCst);
    if pid > 0 {
        // 不持有播放子进程（它要等自然结束才能回报），按 PID 终止即可
        kill_player(pid);
    }
}
