//! catalog.rs — Source-agnostic music catalog abstraction.
//!
//! This trait abstracts music sources (JioSaavn, Audius, Jamendo, etc.) so the
//! player can be source-agnostic and support legal catalogs. Each catalog
//! implementation provides:
//! - Search (songs, albums, artists, playlists)
//! - Metadata fetch (track, album, artist, playlist)
//! - Playback URLs with quality options
//! - Home feed and recommendations
//! - Lyrics (optional)
//!
//! Catalog implementations must NOT know about HTTP servers (that is proxy.rs's job).
//! They return standard types that the proxy layer can work with.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::jiosaavn::{Probe, Song, Track};

/// A search result page with pagination info.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SearchPage {
    pub tracks: Vec<Track>,
    /// Whether upstream still had rows after this page.
    pub page_full: bool,
}

/// A home feed with curated content.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HomeFeed {
    pub sections: Vec<FeedSection>,
}

/// A section in the home feed (e.g., "Top Hits", "New Releases").
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct FeedSection {
    pub title: String,
    pub items: Vec<FeedItem>,
}

/// A feed item (album, artist, playlist, or track).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct FeedItem {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub image: String,
    pub kind: FeedItemKind,
}

/// The type of a feed item.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedItemKind {
    Album,
    Artist,
    Playlist,
    Track,
}

/// Search suggestions (autocomplete).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct Suggestions {
    pub top: Option<Track>,
    pub songs: Vec<Track>,
    pub albums: Vec<FeedItem>,
    pub artists: Vec<FeedItem>,
    pub playlists: Vec<FeedItem>,
}

/// Entity search results (albums, artists, playlists).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct EntityPage {
    pub total: u32,
    pub start: u32,
    pub items: Vec<FeedItem>,
    pub page_full: bool,
}

/// Artist overview with biography and top tracks.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtistOverview {
    pub id: String,
    pub name: String,
    pub image: String,
    pub verified: bool,
    pub followers: Option<u64>,
    pub top_tracks: Vec<Track>,
}

/// Radio/recommendation feed.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RadioPage {
    pub tracks: Vec<Track>,
    pub station: Option<String>,
}

/// Catalog configuration and metadata.
#[derive(Clone, Debug)]
pub struct CatalogConfig {
    /// Whether this catalog requires authentication.
    pub requires_auth: bool,
    /// Whether this catalog is a legal source (licensed content).
    pub is_legal: bool,
    /// Supported quality tiers (e.g., ["96kbps", "160kbps", "320kbps"]).
    pub quality_tiers: Vec<String>,
    /// Maximum results per search page.
    pub max_page_size: u32,
}

/// The source-agnostic catalog trait.
///
/// Implement this for each music source (JioSaavn, Audius, Jamendo, etc.).
/// The proxy layer uses this trait to fetch metadata and URLs without knowing
/// the specific source implementation.
#[async_trait]
pub trait Catalog: Send + Sync {
    /// Get catalog metadata (name, config, etc.).
    fn name(&self) -> &str;
    fn config(&self) -> CatalogConfig;

    /// Search for songs.
    async fn search_songs(
        &self,
        query: &str,
        limit: u32,
        page: u32,
    ) -> Result<SearchPage, CatalogError>;

    /// Search for entities (albums, artists, playlists).
    async fn search_entities(
        &self,
        query: &str,
        kind: &str,
        limit: u32,
        page: u32,
    ) -> Result<EntityPage, CatalogError>;

    /// Get search suggestions (autocomplete).
    async fn suggestions(&self, query: &str) -> Result<Suggestions, CatalogError>;

    /// Fetch a song by ID with all quality renditions.
    async fn fetch_song(&self, id: &str) -> Result<Song, CatalogError>;

    /// Get the home feed (curated content).
    async fn home(&self) -> Result<HomeFeed, CatalogError>;

    /// Fetch tracks from an album.
    async fn album_tracks(&self, token: &str) -> Result<Vec<Track>, CatalogError>;

    /// Fetch tracks from an artist (paginated).
    async fn artist_tracks(
        &self,
        token: &str,
        page: u32,
    ) -> Result<Vec<Track>, CatalogError>;

    /// Fetch artist overview (bio, top tracks, etc.).
    async fn artist_overview(&self, token: &str) -> Result<ArtistOverview, CatalogError>;

    /// Fetch tracks from a playlist.
    async fn playlist_tracks(&self, id: &str) -> Result<Vec<Track>, CatalogError>;

    /// Get lyrics for a song (optional; may return not supported).
    async fn lyrics(&self, id: &str) -> Result<String, CatalogError>;

    /// Get radio/recommendations based on a seed song or station.
    async fn recommend(
        &self,
        song: Option<&str>,
        station: Option<&str>,
    ) -> Result<RadioPage, CatalogError>;

    /// Qualify a stream URL (check range support, content length, etc.).
    async fn qualify_url(&self, url: &str) -> Result<Probe, CatalogError>;
}

/// Typed catalog errors using thiserror for proper error handling.
#[derive(Clone, Debug, Error, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogError {
    /// Network request failed.
    #[error("Network error [{code}]: {message}")]
    Network { code: String, message: String },

    /// Upstream API error.
    #[error("Upstream error [{code}]: {message}")]
    Upstream { code: String, message: String },

    /// Parse/deserialization error.
    #[error("Parse error: {message}")]
    Parse { message: String },

    /// Invalid input (e.g., empty query, malformed ID).
    #[error("Invalid input: {message}")]
    InvalidInput { message: String },

    /// Not found (track, album, etc. doesn't exist).
    #[error("{resource} not found: {id}")]
    NotFound { resource: String, id: String },

    /// Not supported by this catalog.
    #[error("Feature not supported: {feature}")]
    NotSupported { feature: String },

    /// Authentication required.
    #[error("Authentication required")]
    AuthRequired,

    /// Rate limited.
    #[error("Rate limited, retry after {retry_after_secs:?}")]
    RateLimited { retry_after_secs: Option<u64> },

    /// Other error.
    #[error("Error: {message}")]
    Other { message: String },
}

/// Convert String errors to CatalogError (for existing code compatibility).
impl From<String> for CatalogError {
    fn from(s: String) -> Self {
        CatalogError::Other { message: s }
    }
}

/// Convert &str errors to CatalogError.
impl From<&str> for CatalogError {
    fn from(s: &str) -> Self {
        CatalogError::Other {
            message: s.to_string(),
        }
    }
}
