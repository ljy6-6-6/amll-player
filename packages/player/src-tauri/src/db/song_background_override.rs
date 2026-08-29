use sea_orm::{
    ColumnTrait, EntityTrait, QueryFilter, Set, TransactionTrait,
    sea_query::{Expr, OnConflict},
};
use serde::Deserialize;
use tauri::State;

use crate::db::DbConnection;
use crate::db::entity::{song, song_background_override};
use crate::db_events;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSongBackgroundOverridePayload {
    pub song_id: String,
    pub renderer_mode: String,
    pub dual_layer: bool,
    pub video_opacity: f64,
    pub video_base_renderer_mode: String,
    pub video_base_css_background: String,
}

fn validate_payload(payload: &SaveSongBackgroundOverridePayload) -> Result<(), String> {
    if !matches!(
        payload.renderer_mode.as_str(),
        "mesh" | "pixi" | "css-bg" | "video"
    ) {
        return Err("Invalid song background renderer mode".into());
    }
    if !payload.video_opacity.is_finite()
        || payload.video_opacity < 0.0
        || payload.video_opacity > 1.0
    {
        return Err("Song video background opacity must be between 0 and 1".into());
    }
    if !matches!(
        payload.video_base_renderer_mode.as_str(),
        "mesh" | "pixi" | "css-bg"
    ) {
        return Err("Invalid song video base renderer mode".into());
    }
    let css_background = payload.video_base_css_background.trim();
    if css_background.is_empty() || css_background.len() > 1_024 {
        return Err("Song video base CSS background must contain 1 to 1024 bytes".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn get_song_background_override(
    song_id: String,
    db: State<'_, DbConnection>,
) -> Result<Option<song_background_override::Model>, String> {
    song_background_override::Entity::find_by_id(song_id)
        .one(&*db)
        .await
        .map_err(|error| format!("Failed to get song background override: {error}"))
}

#[tauri::command]
pub async fn save_song_background_override(
    payload: SaveSongBackgroundOverridePayload,
    db: State<'_, DbConnection>,
) -> Result<song_background_override::Model, String> {
    validate_payload(&payload)?;
    let transaction = db
        .begin()
        .await
        .map_err(|error| format!("Failed to begin song background override save: {error}"))?;
    song::Entity::find_by_id(&payload.song_id)
        .one(&transaction)
        .await
        .map_err(|error| format!("Failed to find song: {error}"))?
        .ok_or_else(|| format!("Song {} not found", payload.song_id))?;

    let model = song_background_override::ActiveModel {
        song_id: Set(payload.song_id.clone()),
        override_enabled: Set(true),
        renderer_mode: Set(payload.renderer_mode),
        dual_layer: Set(payload.dual_layer),
        video_opacity: Set(payload.video_opacity),
        video_base_renderer_mode: Set(payload.video_base_renderer_mode),
        video_base_css_background: Set(payload.video_base_css_background),
        updated_at: Set(chrono::Utc::now().timestamp_millis()),
    };
    song_background_override::Entity::insert(model)
        .on_conflict(
            OnConflict::column(song_background_override::Column::SongId)
                .update_columns([
                    song_background_override::Column::OverrideEnabled,
                    song_background_override::Column::RendererMode,
                    song_background_override::Column::DualLayer,
                    song_background_override::Column::VideoOpacity,
                    song_background_override::Column::VideoBaseRendererMode,
                    song_background_override::Column::VideoBaseCssBackground,
                    song_background_override::Column::UpdatedAt,
                ])
                .to_owned(),
        )
        .exec(&transaction)
        .await
        .map_err(|error| format!("Failed to save song background override: {error}"))?;
    let saved = song_background_override::Entity::find_by_id(&payload.song_id)
        .one(&transaction)
        .await
        .map_err(|error| format!("Failed to read saved song background override: {error}"))?
        .ok_or_else(|| "Saved song background override could not be read back".to_string())?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit song background override: {error}"))?;
    db_events::emit_event(
        "song_background_overrides",
        "upsert",
        serde_json::json!(&saved.song_id),
    );
    Ok(saved)
}

#[tauri::command]
pub async fn delete_song_background_override(
    song_id: String,
    db: State<'_, DbConnection>,
) -> Result<(), String> {
    let result = song_background_override::Entity::update_many()
        .col_expr(
            song_background_override::Column::OverrideEnabled,
            Expr::value(false),
        )
        .col_expr(
            song_background_override::Column::UpdatedAt,
            Expr::value(chrono::Utc::now().timestamp_millis()),
        )
        .filter(song_background_override::Column::SongId.eq(&song_id))
        .exec(&*db)
        .await
        .map_err(|error| format!("Failed to disable song background override: {error}"))?;
    if result.rows_affected > 0 {
        db_events::emit_event(
            "song_background_overrides",
            "upsert",
            serde_json::json!(song_id),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> SaveSongBackgroundOverridePayload {
        SaveSongBackgroundOverridePayload {
            song_id: "song-1".into(),
            renderer_mode: "video".into(),
            dual_layer: true,
            video_opacity: 0.4,
            video_base_renderer_mode: "css-bg".into(),
            video_base_css_background: "#000000".into(),
        }
    }

    #[test]
    fn payload_validation_accepts_video_composition_defaults() {
        validate_payload(&payload()).expect("video composition defaults should be valid");
    }

    #[test]
    fn payload_validation_rejects_video_as_a_base_renderer_and_blank_css() {
        let mut invalid_renderer = payload();
        invalid_renderer.video_base_renderer_mode = "video".into();
        assert!(validate_payload(&invalid_renderer).is_err());

        let mut blank_css = payload();
        blank_css.video_base_css_background = "   ".into();
        assert!(validate_payload(&blank_css).is_err());
    }
}
