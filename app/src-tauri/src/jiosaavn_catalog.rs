//! jiosaavn_catalog.rs — JioSaavn implementation of the Catalog trait.
//!
//! This module wraps the existing JioSaavn API code to implement the source-agnostic
//! Catalog trait. Note: JioSaavn is an unofficial API and should be considered
//! for testing/development only. For production, use legal catalog sources
//! (Audius, Jamendo, etc.).

use async_trait::async_trait;
use reqwest::Client;

use crate::catalog::{
    Catalog, CatalogConfig, CatalogError, EntityPage, FeedItem, FeedItemKind,
    FeedSection, HomeFeed, RadioPage, SearchPage, Suggestions,
};
use crate::jiosaavn::{Probe, Song, Track};
use crate::official;

/// Convert official::FeedItem to catalog::FeedItem with inferred kind
fn convert_feed_item(item: official::FeedItem, kind: FeedItemKind) -> FeedItem {
    FeedItem {
        id: item.id,
        title: item.title,
        subtitle: item.subtitle,
        image: item.image,
        kind,
    }
}

/// JioSaavn catalog implementation.
pub struct JioSaavnCatalog {
    client: Client,
}

impl JioSaavnCatalog {
    pub fn new(client: Client) -> Self {
        Self { client }
    }
}

#[async_trait]
impl Catalog for JioSaavnCatalog {
    fn name(&self) -> &str {
        "JioSaavn"
    }

    fn config(&self) -> CatalogConfig {
        CatalogConfig {
            requires_auth: false,
            is_legal: false, // JioSaavn is an unofficial API
            quality_tiers: vec![
                "12kbps".to_string(),
                "48kbps".to_string(),
                "96kbps".to_string(),
                "160kbps".to_string(),
                "320kbps".to_string(),
            ],
            max_page_size: 40,
        }
    }

    async fn search_songs(
        &self,
        query: &str,
        limit: u32,
        page: u32,
    ) -> Result<SearchPage, CatalogError> {
        let page = crate::jiosaavn::search_songs(&self.client, query, limit, page)
            .await
            .map_err(|_e| CatalogError::Network {
                code: "SEARCH_FAILED".to_string(),
                message: "Search failed".to_string(),
            })?;

        Ok(SearchPage {
            tracks: page.tracks,
            page_full: page.page_full,
        })
    }

    async fn search_entities(
        &self,
        query: &str,
        kind: &str,
        limit: u32,
        page: u32,
    ) -> Result<EntityPage, CatalogError> {
        let page = official::search_entities(&self.client, query, kind, limit, page)
            .await
            .map_err(|_e| CatalogError::NotFound {
                resource: "entity".to_string(),
                id: query.to_string(),
            })?;

        Ok(EntityPage {
            total: page.items.len() as u32,
            start: 0,
            items: page.items.into_iter().map(|i| convert_feed_item(i, FeedItemKind::Playlist)).collect(),
            page_full: !page.items.is_empty(),
        })
    }

    async fn suggestions(&self, query: &str) -> Result<Suggestions, CatalogError> {
        let sugg = official::suggestions(&self.client, query)
            .await
            .map_err(|_e| CatalogError::NotFound {
                resource: "suggestions".to_string(),
                id: query.to_string(),
            })?;

        // Convert official::Suggestions to catalog::Suggestions
        let top_track = if let Some(top) = sugg.top {
            // If top is a song, we need to fetch its full track data
            // For now, just return None as this is complex
            None
        } else {
            None
        };

        Ok(Suggestions {
            top: top_track,
            songs: Vec::new(), // official returns FeedItems, not Tracks
            albums: sugg.albums.into_iter().map(|i| convert_feed_item(i, FeedItemKind::Album)).collect(),
            artists: sugg.artists.into_iter().map(|i| convert_feed_item(i, FeedItemKind::Artist)).collect(),
            playlists: sugg.playlists.into_iter().map(|i| convert_feed_item(i, FeedItemKind::Playlist)).collect(),
        })
    }

    async fn fetch_song(&self, id: &str) -> Result<Song, CatalogError> {
        crate::jiosaavn::fetch_song(&self.client, id)
            .await
            .map_err(|_e| CatalogError::NotFound {
                resource: "song".to_string(),
                id: id.to_string(),
            })
    }

    async fn home(&self) -> Result<HomeFeed, CatalogError> {
        let feed = official::home(&self.client)
            .await
            .map_err(|_e| CatalogError::Network {
                code: "HOME_FAILED".to_string(),
                message: "Failed to fetch home feed".to_string(),
            })?;

        // Convert official::HomeFeed to catalog::HomeFeed
        let mut sections = Vec::new();

        if let Some(spotlight) = feed.spotlight {
            sections.push(FeedSection {
                title: "Featured".to_string(),
                items: vec![convert_feed_item(spotlight, FeedItemKind::Playlist)],
            });
        }

        if !feed.playlists.is_empty() {
            sections.push(FeedSection {
                title: "Playlists".to_string(),
                items: feed
                    .playlists
                    .into_iter()
                    .map(|i| convert_feed_item(i, FeedItemKind::Playlist))
                    .collect(),
            });
        }

        if !feed.charts.is_empty() {
            sections.push(FeedSection {
                title: "Charts".to_string(),
                items: feed
                    .charts
                    .into_iter()
                    .map(|i| convert_feed_item(i, FeedItemKind::Playlist))
                    .collect(),
            });
        }

        if !feed.albums.is_empty() {
            sections.push(FeedSection {
                title: "New Releases".to_string(),
                items: feed
                    .albums
                    .into_iter()
                    .map(|i| convert_feed_item(i, FeedItemKind::Album))
                    .collect(),
            });
        }

        if !feed.artists.is_empty() {
            sections.push(FeedSection {
                title: "Featured Artists".to_string(),
                items: feed
                    .artists
                    .into_iter()
                    .map(|i| convert_feed_item(i, FeedItemKind::Artist))
                    .collect(),
            });
        }

        if !feed.daily.is_empty() {
            sections.push(FeedSection {
                title: "Daily".to_string(),
                items: feed
                    .daily
                    .into_iter()
                    .map(|i| convert_feed_item(i, FeedItemKind::Playlist))
                    .collect(),
            });
        }

        Ok(HomeFeed { sections })
    }

    async fn album_tracks(&self, token: &str) -> Result<Vec<Track>, CatalogError> {
        official::album_tracks(&self.client, token)
            .await
            .map_err(|_e| CatalogError::NotFound {
                resource: "album".to_string(),
                id: token.to_string(),
            })
    }

    async fn artist_tracks(
        &self,
        token: &str,
        page: u32,
    ) -> Result<Vec<Track>, CatalogError> {
        let page = official::artist_tracks(&self.client, token, page)
            .await
            .map_err(|_e| CatalogError::NotFound {
                resource: "artist".to_string(),
                id: token.to_string(),
            })?;

        Ok(page.tracks)
    }

    async fn artist_overview(&self, token: &str) -> Result<crate::catalog::ArtistOverview, CatalogError> {
        let overview = official::artist_overview(&self.client, token)
            .await
            .map_err(|_e| CatalogError::NotFound {
                resource: "artist".to_string(),
                id: token.to_string(),
            })?;

        Ok(crate::catalog::ArtistOverview {
            id: token.to_string(),
            name: overview.name,
            image: overview.image,
            verified: overview.verified,
            followers: Some(overview.listeners),
            top_tracks: Vec::new(),
        })
    }

    async fn playlist_tracks(&self, id: &str) -> Result<Vec<Track>, CatalogError> {
        official::playlist_tracks(&self.client, id)
            .await
            .map_err(|_e| CatalogError::NotFound {
                resource: "playlist".to_string(),
                id: id.to_string(),
            })
    }

    async fn lyrics(&self, id: &str) -> Result<String, CatalogError> {
        let lyrics = official::lyrics(&self.client, id)
            .await
            .map_err(|_e| CatalogError::NotSupported {
                feature: "lyrics".to_string(),
            })?;

        Ok(lyrics.map(|(l, _)| l).unwrap_or_default())
    }

    async fn recommend(
        &self,
        song: Option<&str>,
        station: Option<&str>,
    ) -> Result<RadioPage, CatalogError> {
        let radio = official::recommend(&self.client, song, station)
            .await
            .map_err(|e| CatalogError::Network {
                code: "RECOMMEND_FAILED".to_string(),
                message: e,
            })?;

        Ok(RadioPage {
            tracks: radio.tracks,
            station: Some(radio.station),
        })
    }

    async fn qualify_url(&self, url: &str) -> Result<Probe, CatalogError> {
        crate::jiosaavn::qualify_url(&self.client, url)
            .await
            .map_err(|e| CatalogError::Network {
                code: "QUALIFY_FAILED".to_string(),
                message: e,
            })
    }
}
