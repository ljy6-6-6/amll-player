use tauri::{AppHandle, State};

use crate::ttml_db::{
    LyricDbReader, get_index_file_path, get_lyric_db_dir, get_or_create_reader,
    model::{LyricSearchResult, SearchFilter, SyncResult, SyncStatus},
    refresh_shared_reader, sync,
};

#[tauri::command]
pub async fn sync_lyrics(
    app: AppHandle,
    reader_state: State<'_, LyricDbReader>,
) -> Result<SyncResult, String> {
    let data_dir = get_lyric_db_dir(&app)?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create lyric-db dir: {e}"))?;

    let mut syncer = sync::LyricSyncer::new(data_dir);
    let result = syncer.sync().await.map_err(|e| format!("{:#}", e))?;

    if result.status == SyncStatus::Updated {
        let index_file = get_index_file_path(&app)?;
        if index_file.exists() {
            let _ = refresh_shared_reader(&reader_state, &index_file).await;
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn search_lyrics(
    app: AppHandle,
    reader_state: State<'_, LyricDbReader>,
    filters: Vec<SearchFilter>,
) -> Result<Vec<LyricSearchResult>, String> {
    let index_file = get_index_file_path(&app)?;

    if !index_file.exists() {
        return Ok(Vec::new());
    }

    get_or_create_reader(&reader_state, &index_file).await?;

    let reader_guard = reader_state.read().await;
    let reader = reader_guard
        .as_ref()
        .ok_or_else(|| "Reader not initialized".to_string())?;

    Ok(reader.search(&filters))
}

#[tauri::command]
pub async fn get_lyric_detail(
    app: AppHandle,
    reader_state: State<'_, LyricDbReader>,
    file_path: String,
) -> Result<Option<String>, String> {
    let index_file = get_index_file_path(&app)?;

    if !index_file.exists() {
        return Ok(None);
    }

    get_or_create_reader(&reader_state, &index_file).await?;

    let reader_guard = reader_state.read().await;
    let reader = reader_guard
        .as_ref()
        .ok_or_else(|| "Reader not initialized".to_string())?;

    Ok(reader.get_lyric_detail(&file_path))
}
