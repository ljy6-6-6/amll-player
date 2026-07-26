use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::Path,
    sync::Mutex,
    time::Duration,
};

use amll_player_core::RHYTHM_ANALYZER_VERSION;
use sea_orm::{EntityTrait, QuerySelect};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::warn;

use crate::db::{
    DbConnection,
    entity::{song, song_rhythm_analysis},
    rhythm::{
        RhythmAnalysisState, analyze_and_store, load_valid_cached_analysis, source_signature,
    },
};

pub const RHYTHM_PRECACHE_PROGRESS_EVENT: &str = "rhythm-precache-progress";

/// 推送给前端进度提示的快照。total 只统计本轮真正需要(重新)分析的歌曲,
/// 缓存完好的歌不会出现在计数里。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhythmPrecacheProgress {
    pub active: bool,
    pub total: u32,
    pub done: u32,
    pub failed: u32,
    pub current_song_name: Option<String>,
}

#[derive(Default)]
struct PrecacheQueue {
    pending: VecDeque<String>,
    queued: HashSet<String>,
    worker_running: bool,
    total: u32,
    done: u32,
    failed: u32,
    current_song_name: Option<String>,
}

#[derive(Default)]
pub struct RhythmPrecacheState {
    queue: Mutex<PrecacheQueue>,
}

impl RhythmPrecacheState {
    fn snapshot(&self) -> RhythmPrecacheProgress {
        let queue = self
            .queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        RhythmPrecacheProgress {
            active: queue.worker_running,
            total: queue.total,
            done: queue.done,
            failed: queue.failed,
            current_song_name: queue.current_song_name.clone(),
        }
    }
}

fn emit_progress(app: &AppHandle) {
    let state = app.state::<RhythmPrecacheState>();
    let progress = state.snapshot();
    if let Err(error) = app.emit(RHYTHM_PRECACHE_PROGRESS_EVENT, &progress) {
        warn!("failed to emit rhythm precache progress: {error}");
    }
}

/// 扫描曲库,把缓存缺失、分析器版本过期或源文件已变化的歌曲加入后台
/// 分析队列,并在需要时启动 worker。导入完成与应用启动时都会调用;
/// 分析器版本升级后由启动扫描自动重建全库缓存。
#[tauri::command]
pub async fn start_rhythm_precache(
    app: AppHandle,
    db: State<'_, DbConnection>,
    state: State<'_, RhythmPrecacheState>,
) -> Result<RhythmPrecacheProgress, String> {
    let songs = song::Entity::find()
        .all(&*db)
        .await
        .map_err(|e| format!("Failed to list songs for rhythm precache: {e}"))?;
    // 只取签名列,避免把全库分析 JSON 一次性载入内存。
    let cached_rows: Vec<(String, i32, i64, i64)> = song_rhythm_analysis::Entity::find()
        .select_only()
        .column(song_rhythm_analysis::Column::SongId)
        .column(song_rhythm_analysis::Column::AnalyzerVersion)
        .column(song_rhythm_analysis::Column::SourceModifiedAt)
        .column(song_rhythm_analysis::Column::SourceFileSize)
        .into_tuple()
        .all(&*db)
        .await
        .map_err(|e| format!("Failed to list rhythm caches: {e}"))?;
    let cache_index: HashMap<String, (i32, i64, i64)> = cached_rows
        .into_iter()
        .map(|(song_id, version, modified_at, file_size)| {
            (song_id, (version, modified_at, file_size))
        })
        .collect();
    let expected_version = i32::try_from(RHYTHM_ANALYZER_VERSION)
        .map_err(|_| "Rhythm analyzer version is out of range".to_string())?;

    // 每首歌都要 stat 一次源文件,放到阻塞线程完成。
    let needing = tokio::task::spawn_blocking(move || {
        songs
            .into_iter()
            .filter(|entry| match cache_index.get(&entry.id) {
                None => true,
                Some(&(version, modified_at, file_size)) => {
                    if version != expected_version {
                        return true;
                    }
                    match source_signature(Path::new(&entry.file_path)) {
                        Ok(signature) => {
                            signature.modified_at != modified_at
                                || signature.file_size != file_size
                        }
                        // 文件暂不可读:预扫不重试,交给播放路径按需处理。
                        Err(_) => false,
                    }
                }
            })
            .map(|entry| entry.id)
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| format!("Rhythm precache scan task failed: {e}"))?;

    let mut spawn_worker = false;
    {
        let mut queue = state
            .queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !queue.worker_running && queue.pending.is_empty() {
            // 新一轮扫描重新计数,让进度提示只反映本轮批次。
            queue.total = 0;
            queue.done = 0;
            queue.failed = 0;
        }
        for song_id in needing {
            if queue.queued.insert(song_id.clone()) {
                queue.pending.push_back(song_id);
                queue.total += 1;
            }
        }
        if !queue.worker_running && !queue.pending.is_empty() {
            queue.worker_running = true;
            spawn_worker = true;
        }
    }
    if spawn_worker {
        let worker_app = app.clone();
        tauri::async_runtime::spawn(async move {
            run_worker(worker_app).await;
        });
    }
    emit_progress(&app);
    Ok(state.snapshot())
}

/// 前端挂载时用来补拉当前进度,避免错过 worker 已经发出的事件。
#[tauri::command]
pub fn get_rhythm_precache_progress(
    state: State<'_, RhythmPrecacheState>,
) -> RhythmPrecacheProgress {
    state.snapshot()
}

async fn run_worker(app: AppHandle) {
    loop {
        // 播放路径的分析请求在场时后台完全静默,把解码线程让给当前歌曲。
        if app.state::<RhythmAnalysisState>().has_foreground_pending() {
            tokio::time::sleep(Duration::from_millis(300)).await;
            continue;
        }

        let next_song_id = {
            let state = app.state::<RhythmPrecacheState>();
            let mut queue = state
                .queue
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match queue.pending.pop_front() {
                Some(song_id) => {
                    queue.queued.remove(&song_id);
                    Some(song_id)
                }
                None => {
                    queue.worker_running = false;
                    queue.current_song_name = None;
                    None
                }
            }
        };
        let Some(song_id) = next_song_id else {
            emit_progress(&app);
            return;
        };

        let song_name = {
            let db = app.state::<DbConnection>();
            song::Entity::find_by_id(song_id.clone())
                .one(&*db)
                .await
                .ok()
                .flatten()
                .map(|entry| entry.song_name)
        };
        {
            let state = app.state::<RhythmPrecacheState>();
            let mut queue = state
                .queue
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            queue.current_song_name = song_name.or_else(|| Some(song_id.clone()));
        }
        emit_progress(&app);

        let result = precache_song(&app, &song_id).await;
        {
            let state = app.state::<RhythmPrecacheState>();
            let mut queue = state
                .queue
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match &result {
                Ok(()) => queue.done += 1,
                Err(_) => queue.failed += 1,
            }
            queue.current_song_name = None;
        }
        if let Err(error) = result {
            warn!("rhythm precache failed for song {song_id}: {error}");
        }
        emit_progress(&app);
    }
}

async fn precache_song(app: &AppHandle, song_id: &str) -> Result<(), String> {
    let semaphore = app.state::<RhythmAnalysisState>().semaphore();
    let _permit = semaphore
        .acquire_owned()
        .await
        .map_err(|_| "Rhythm analysis queue has been closed".to_string())?;
    let db = app.state::<DbConnection>();
    // 权威复查:播放路径或上一轮扫描可能已经补好缓存。
    if load_valid_cached_analysis(&db, song_id, true).await?.is_some() {
        return Ok(());
    }
    analyze_and_store(&db, song_id).await.map(|_| ())
}
