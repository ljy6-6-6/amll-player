pub mod m20260614_000001_init;
pub mod m20260614_000002_add_modified_at_and_playlist_song_sources;
pub mod m20260721_000003_add_song_rhythm_analyses;

use sea_orm_migration::prelude::*;
use sea_orm::{ConnectionTrait, DatabaseConnection, TransactionTrait};

const RHYTHM_MIGRATION_NAME: &str = "m20260721_000003_add_song_rhythm_analyses";
const RHYTHM_MIGRATION_TABLE: &str = "seaql_rhythm_migrations";

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20260614_000001_init::Migration),
            Box::new(m20260614_000002_add_modified_at_and_playlist_song_sources::Migration),
        ]
    }
}

pub struct RhythmMigrator;

#[async_trait::async_trait]
impl MigratorTrait for RhythmMigrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![Box::new(
            m20260721_000003_add_song_rhythm_analyses::Migration,
        )]
    }

    fn migration_table_name() -> DynIden {
        Alias::new(RHYTHM_MIGRATION_TABLE).into_iden()
    }
}

/// Apply the legacy and rhythm schemas atomically while keeping the default
/// migration ledger readable by player builds that predate rhythm analysis.
pub async fn run_migrations(db: &DatabaseConnection) -> Result<(), DbErr> {
    let transaction = db.begin().await?;

    // `install` also covers fresh databases, so the compatibility delete below
    // remains an exact, harmless no-op when the legacy ledger has no rhythm row.
    Migrator::install(&transaction).await?;
    let remove_legacy_rhythm_marker = format!(
        "DELETE FROM \"seaql_migrations\" WHERE \"version\" = '{RHYTHM_MIGRATION_NAME}'"
    );
    transaction
        .execute_unprepared(&remove_legacy_rhythm_marker)
        .await?;

    Migrator::up(&transaction, None).await?;
    RhythmMigrator::up(&transaction, None).await?;
    transaction.commit().await
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    use super::*;

    /// Reproduces the migration list shipped before the rhythm ledger was
    /// separated for downgrade compatibility.
    struct PreviouslyDeployedMigrator;

    #[async_trait::async_trait]
    impl MigratorTrait for PreviouslyDeployedMigrator {
        fn migrations() -> Vec<Box<dyn MigrationTrait>> {
            vec![
                Box::new(m20260614_000001_init::Migration),
                Box::new(m20260614_000002_add_modified_at_and_playlist_song_sources::Migration),
                Box::new(m20260721_000003_add_song_rhythm_analyses::Migration),
            ]
        }
    }

    async fn scalar_i64(db: &DatabaseConnection, sql: &str) -> i64 {
        db.query_one(Statement::from_string(DbBackend::Sqlite, sql))
            .await
            .expect("query should succeed")
            .expect("query should return one row")
            .try_get("", "value")
            .expect("value should be an integer")
    }

    #[tokio::test]
    async fn fresh_database_uses_separate_ledgers() {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("in-memory SQLite should open");

        run_migrations(&db)
            .await
            .expect("fresh migrations should apply");

        assert_eq!(
            scalar_i64(&db, "SELECT COUNT(*) AS value FROM seaql_migrations").await,
            2,
        );
        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) AS value FROM seaql_rhythm_migrations",
            )
            .await,
            1,
        );
        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) AS value FROM sqlite_master \
                 WHERE type = 'table' AND name = 'song_rhythm_analyses'",
            )
            .await,
            1,
        );
    }

    #[tokio::test]
    async fn upgrades_database_with_only_legacy_migrations() {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("in-memory SQLite should open");

        Migrator::up(&db, None)
            .await
            .expect("legacy migrations should apply");
        run_migrations(&db)
            .await
            .expect("rhythm migration should apply separately");

        assert_eq!(
            scalar_i64(&db, "SELECT COUNT(*) AS value FROM seaql_migrations").await,
            2,
        );
        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) AS value FROM seaql_rhythm_migrations",
            )
            .await,
            1,
        );
    }

    #[tokio::test]
    async fn moves_rhythm_marker_without_losing_cache_or_breaking_legacy_migrator() {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("in-memory SQLite should open");

        PreviouslyDeployedMigrator::up(&db, None)
            .await
            .expect("previous migrations should apply");
        db.execute_unprepared(
            "INSERT INTO songs (id, file_path, song_name, song_artists, song_album, \
             duration, lyric_format, lyric) VALUES \
             ('song-1', 'song.flac', 'Song', 'Artist', 'Album', 180.0, 'lrc', '')",
        )
        .await
        .expect("song fixture should insert");
        db.execute_unprepared(
            "INSERT INTO song_rhythm_analyses \
             (song_id, analyzer_version, source_modified_at, source_file_size, \
              analyzed_at, payload_json) VALUES \
             ('song-1', 1, 100, 200, 300, '{\"beats\":[1.0]}')",
        )
        .await
        .expect("rhythm cache fixture should insert");

        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) AS value FROM seaql_migrations \
                 WHERE version = 'm20260721_000003_add_song_rhythm_analyses'",
            )
            .await,
            1,
        );

        run_migrations(&db)
            .await
            .expect("compatibility migration should succeed");
        run_migrations(&db)
            .await
            .expect("compatibility migration should remain idempotent");

        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) AS value FROM seaql_migrations",
            )
            .await,
            2,
        );
        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) AS value FROM seaql_migrations \
                 WHERE version = 'm20260721_000003_add_song_rhythm_analyses'",
            )
            .await,
            0,
        );
        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) AS value FROM seaql_rhythm_migrations \
                 WHERE version = 'm20260721_000003_add_song_rhythm_analyses'",
            )
            .await,
            1,
        );
        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) AS value FROM song_rhythm_analyses \
                 WHERE song_id = 'song-1' AND payload_json = '{\"beats\":[1.0]}'",
            )
            .await,
            1,
        );

        Migrator::up(&db, None)
            .await
            .expect("legacy migrator should ignore the separate rhythm ledger");
        assert_eq!(
            scalar_i64(
                &db,
                "SELECT COUNT(*) AS value FROM song_rhythm_analyses WHERE song_id = 'song-1'",
            )
            .await,
            1,
        );
    }
}
