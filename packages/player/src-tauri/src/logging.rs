use std::path::Path;
use tracing::*;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

#[expect(dead_code)]
pub struct LogGuard(tracing_appender::non_blocking::WorkerGuard);

pub fn init_logging(log_dir: &Path) -> LogGuard {
    let _ = std::fs::create_dir_all(log_dir);

    let file_appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("amll-player")
        .filename_suffix("log")
        .max_log_files(3)
        .build(log_dir)
        .expect("无法初始化 RollingFileAppender");

    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new(
            "amll_player=trace,wry=info,taskbar_lyric=warn,now_playing_controls=warn,ffmpeg=warn",
        )
    });

    let file_layer = fmt::layer()
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_thread_names(true)
        .with_timer(tracing_subscriber::fmt::time::uptime());

    let stdout_layer = fmt::layer()
        .with_writer(std::io::stdout)
        .with_ansi(true)
        .with_thread_names(true)
        .with_timer(tracing_subscriber::fmt::time::uptime());

    tracing_subscriber::registry()
        .with(env_filter)
        .with(file_layer)
        .with(stdout_layer)
        .init();

    std::panic::set_hook(Box::new(move |info| {
        error!("Fatal error occurred! AMLL Player will exit now.");
        error!("Error: {info}");
        error!("{info:#?}");
    }));

    LogGuard(guard)
}
