//! audius.rs — Audius catalog implementation (legal source).
//!
//! Audius is a decentralized, blockchain-based music platform with licensed content.
//! This module implements the Catalog trait for Audius, providing a legal music source.
//!
//! API documentation: https://docs.audius.org/

use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;

use crate::catalog::{
    Catalog, CatalogConfig, CatalogError, EntityPage, FeedItem, FeedItemKind,
    FeedSection, HomeFeed, RadioPage, SearchPage, Suggestions,
};
use crate::jiosaavn::{Probe, QualityUrl, Song, Track};

/// Audius API base URL.
const API_BASE: &str = "https://discoveryprovider.audius.co";

/// Audius catalog implementation.
pub struct AudiusCatalog {
    client: Client,
}

impl AudiusCatalog {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    /// Make a request to the Audius API.
    async fn call(&self, endpoint: &str) -> Result<serde_json::Value, CatalogError> {
        let url = format!("{}/{}", API_BASE, endpoint.trim_start_matches('/'));
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| CatalogError::Network {
                code: "REQUEST_FAILED".to_string(),
                message: e.to_string(),
            })?;

        if !resp.status().is_success() {
            return Err(CatalogError::Upstream {
                code: resp.status().as_u16().to_string(),
                message: format!("HTTP {}", resp.status()),
            });
        }

        resp.json()
            .await
            .map_err(|e| CatalogError::Parse {
                message: e.to_string(),
            })
    }
}

#[async_trait]
impl Catalog for AudiusCatalog {
    fn name(&self) -> &str {
        "Audius"
    }

    fn config(&self) -> CatalogConfig {
        CatalogConfig {
            requires_auth: false,
            is_legal: true, // Audius is a legal, licensed source
            quality_tiers: vec![
                "128kbps".to_string(),
                "256kbps".to_string(),
                "320kbps".to_string(),
            ],
            max_page_size: 25,
        }
    }

    async fn search_songs(
        &self,
        query: &str,
        limit: u32,
        page: u32,
    ) -> Result<SearchPage, CatalogError> {
        let endpoint = format!(
            "v1/tracks/search?query={}&limit={}&offset={}",
            urlencoding::encode(query),
            limit.min(25),
            (page - 1) * limit
        );

        let value = self.call(&endpoint).await?;

        let tracks: Vec<AudiusTrack> = serde_json::from_value(
            value
                .get("data")
                .ok_or_else(|| CatalogError::Parse {
                    message: "missing data field".to_string(),
                })?
                .clone(),
        )
        .map_err(|e| CatalogError::Parse {
            message: e.to_string(),
        })?;

        let converted: Vec<Track> = tracks
            .into_iter()
            .map(|t| Track {
                id: t.id,
                title: t.title,
                artist: t.artist_name,
                album: t.album_name.unwrap_or_default(),
                duration_secs: t.duration,
                duration: format_duration(t.duration),
                image: t.artwork.unwrap_or_default(),
                page_url: t.permalink_url.unwrap_or_default(),
                hq: true,
                plays: t.play_count.unwrap_or(0),
                has_lyrics: None,
                artist_ids: vec![t.artist_id],
                album_id: t.album_id.unwrap_or_default(),
                year: t.release_date.unwrap_or_default(),
                label: String::new(),
                language: String::new(),
                explicit: t.isrc.is_some(),
            })
            .collect();

        let page_full = converted.len() as u32 >= limit;

        Ok(SearchPage {
            tracks: converted,
            page_full,
        })
    }

    async fn search_entities(
        &self,
        query: &str,
        kind: &str,
        limit: u32,
        page: u32,
    ) -> Result<EntityPage, CatalogError> {
        let endpoint = match kind {
            "album" => format!(
                "v1/albums/search?query={}&limit={}&offset={}",
                urlencoding::encode(query),
                limit.min(25),
                (page - 1) * limit
            ),
            "artist" => format!(
                "v1/users/search?query={}&limit={}&offset={}",
                urlencoding::encode(query),
                limit.min(25),
                (page - 1) * limit
            ),
            "playlist" => format!(
                "v1/playlists/search?query={}&limit={}&offset={}",
                urlencoding::encode(query),
                limit.min(25),
                (page - 1) * limit
            ),
            _ => {
                return Err(CatalogError::InvalidInput {
                    message: format!("unsupported entity kind: {}", kind),
                })
            }
        };

        let value = self.call(&endpoint).await?;

        let items: Vec<FeedItem> = match kind {
            "album" => {
                let albums: Vec<AudiusAlbum> = serde_json::from_value(
                    value
                        .get("data")
                        .ok_or_else(|| CatalogError::Parse {
                            message: "missing data field".to_string(),
                        })?
                        .clone(),
                )
                .map_err(|e| CatalogError::Parse {
                    message: e.to_string(),
                })?;

                albums
                    .into_iter()
                    .map(|a| FeedItem {
                        id: a.id,
                        title: a.album_name,
                        subtitle: a.artist_name,
                        image: a.artwork.unwrap_or_default(),
                        kind: FeedItemKind::Album,
                    })
                    .collect()
            }
            "artist" => {
                let artists: Vec<AudiusUser> = serde_json::from_value(
                    value
                        .get("data")
                        .ok_or_else(|| CatalogError::Parse {
                            message: "missing data field".to_string(),
                        })?
                        .clone(),
                )
                .map_err(|e| CatalogError::Parse {
                    message: e.to_string(),
                })?;

                artists
                    .into_iter()
                    .map(|u| FeedItem {
                        id: u.id,
                        title: u.name,
                        subtitle: format!("{} followers", u.follower_count.unwrap_or(0)),
                        image: u.profile_picture.unwrap_or_default(),
                        kind: FeedItemKind::Artist,
                    })
                    .collect()
            }
            "playlist" => {
                let playlists: Vec<AudiusPlaylist> = serde_json::from_value(
                    value
                        .get("data")
                        .ok_or_else(|| CatalogError::Parse {
                            message: "missing data field".to_string(),
                        })?
                        .clone(),
                )
                .map_err(|e| CatalogError::Parse {
                    message: e.to_string(),
                })?;

                playlists
                    .into_iter()
                    .map(|p| FeedItem {
                        id: p.id,
                        title: p.playlist_name,
                        subtitle: format!("{} tracks", p.track_count.unwrap_or(0)),
                        image: p.artwork.unwrap_or_default(),
                        kind: FeedItemKind::Playlist,
                    })
                    .collect()
            }
            _ => vec![],
        };

        let page_full = items.len() as u32 >= limit;

        Ok(EntityPage {
            total: items.len() as u32,
            start: 0,
            items,
            page_full,
        })
    }

    async fn suggestions(&self, query: &str) -> Result<Suggestions, CatalogError> {
        // Audius doesn't have a dedicated suggestions endpoint
        // Fall back to search with limited results
        let tracks = self.search_songs(query, 5, 1).await?;
        Ok(Suggestions {
            top: tracks.tracks.first().cloned(),
            songs: tracks.tracks,
            albums: vec![],
            artists: vec![],
            playlists: vec![],
        })
    }

    async fn fetch_song(&self, id: &str) -> Result<Song, CatalogError> {
        let endpoint = format!("v1/tracks/{}", id);
        let value = self.call(&endpoint).await?;

        let track: AudiusTrack = serde_json::from_value(
            value
                .get("data")
                .ok_or_else(|| CatalogError::Parse {
                    message: "missing data field".to_string(),
                })?
                .clone(),
        )
        .map_err(|e| CatalogError::Parse {
            message: e.to_string(),
        })?;

        let qualities = vec![QualityUrl {
            quality: "320kbps".to_string(),
            url: track.stream_url.unwrap_or_default(),
        }];

        Ok(Song {
            track: Track {
                id: track.id,
                title: track.title,
                artist: track.artist_name,
                album: track.album_name.unwrap_or_default(),
                duration_secs: track.duration,
                duration: format_duration(track.duration),
                image: track.artwork.unwrap_or_default(),
                page_url: track.permalink_url.unwrap_or_default(),
                hq: true,
                plays: track.play_count.unwrap_or(0),
                has_lyrics: None,
                artist_ids: vec![track.artist_id],
                album_id: track.album_id.unwrap_or_default(),
                year: track.release_date.unwrap_or_default(),
                label: String::new(),
                language: String::new(),
                explicit: track.isrc.is_some(),
            },
            qualities,
        })
    }

    async fn home(&self) -> Result<HomeFeed, CatalogError> {
        // Audius doesn't have a curated home feed
        // Return trending tracks as a fallback
        let endpoint = "v1/tracks/trending?limit=20";
        let value = self.call(&endpoint).await?;

        let tracks: Vec<AudiusTrack> = serde_json::from_value(
            value
                .get("data")
                .ok_or_else(|| CatalogError::Parse {
                    message: "missing data field".to_string(),
                })?
                .clone(),
        )
        .map_err(|e| CatalogError::Parse {
            message: e.to_string(),
        })?;

        let items = tracks
            .into_iter()
            .map(|t| FeedItem {
                id: t.id,
                title: t.title,
                subtitle: t.artist_name,
                image: t.artwork.unwrap_or_default(),
                kind: FeedItemKind::Track,
            })
            .collect();

        Ok(HomeFeed {
            sections: vec![FeedSection {
                title: "Trending".to_string(),
                items,
            }],
        })
    }

    async fn album_tracks(&self, token: &str) -> Result<Vec<Track>, CatalogError> {
        let endpoint = format!("v1/albums/{}/tracks", token);
        let value = self.call(&endpoint).await?;

        let tracks: Vec<AudiusTrack> = serde_json::from_value(
            value
                .get("data")
                .ok_or_else(|| CatalogError::Parse {
                    message: "missing data field".to_string(),
                })?
                .clone(),
        )
        .map_err(|e| CatalogError::Parse {
            message: e.to_string(),
        })?;

        Ok(tracks
            .into_iter()
            .map(|t| Track {
                id: t.id,
                title: t.title,
                artist: t.artist_name,
                album: t.album_name.unwrap_or_default(),
                duration_secs: t.duration,
                duration: format_duration(t.duration),
                image: t.artwork.unwrap_or_default(),
                page_url: t.permalink_url.unwrap_or_default(),
                hq: true,
                plays: t.play_count.unwrap_or(0),
                has_lyrics: None,
                artist_ids: vec![t.artist_id],
                album_id: t.album_id.unwrap_or_default(),
                year: t.release_date.unwrap_or_default(),
                label: String::new(),
                language: String::new(),
                explicit: t.isrc.is_some(),
            })
            .collect())
    }

    async fn artist_tracks(
        &self,
        token: &str,
        page: u32,
    ) -> Result<Vec<Track>, CatalogError> {
        let endpoint = format!(
            "v1/users/{}/tracks?limit=25&offset={}",
            token,
            (page - 1) * 25
        );
        let value = self.call(&endpoint).await?;

        let tracks: Vec<AudiusTrack> = serde_json::from_value(
            value
                .get("data")
                .ok_or_else(|| CatalogError::Parse {
                    message: "missing data field".to_string(),
                })?
                .clone(),
        )
        .map_err(|e| CatalogError::Parse {
            message: e.to_string(),
        })?;

        Ok(tracks
            .into_iter()
            .map(|t| Track {
                id: t.id,
                title: t.title,
                artist: t.artist_name,
                album: t.album_name.unwrap_or_default(),
                duration_secs: t.duration,
                duration: format_duration(t.duration),
                image: t.artwork.unwrap_or_default(),
                page_url: t.permalink_url.unwrap_or_default(),
                hq: true,
                plays: t.play_count.unwrap_or(0),
                has_lyrics: None,
                artist_ids: vec![t.artist_id],
                album_id: t.album_id.unwrap_or_default(),
                year: t.release_date.unwrap_or_default(),
                label: String::new(),
                language: String::new(),
                explicit: t.isrc.is_some(),
            })
            .collect())
    }

    async fn artist_overview(&self, token: &str) -> Result<crate::catalog::ArtistOverview, CatalogError> {
        let endpoint = format!("v1/users/{}", token);
        let value = self.call(&endpoint).await?;

        let user: AudiusUser = serde_json::from_value(
            value
                .get("data")
                .ok_or_else(|| CatalogError::Parse {
                    message: "missing data field".to_string(),
                })?
                .clone(),
        )
        .map_err(|e| CatalogError::Parse {
            message: e.to_string(),
        })?;

        // Fetch top tracks
        let top_tracks = self.artist_tracks(token, 1).await?;

        Ok(crate::catalog::ArtistOverview {
            id: user.id,
            name: user.name,
            image: user.profile_picture.unwrap_or_default(),
            verified: user.is_verified.unwrap_or(false),
            followers: user.follower_count,
            top_tracks,
        })
    }

    async fn playlist_tracks(&self, id: &str) -> Result<Vec<Track>, CatalogError> {
        let endpoint = format!("v1/playlists/{}/tracks", id);
        let value = self.call(&endpoint).await?;

        let tracks: Vec<AudiusTrack> = serde_json::from_value(
            value
                .get("data")
                .ok_or_else(|| CatalogError::Parse {
                    message: "missing data field".to_string(),
                })?
                .clone(),
        )
        .map_err(|e| CatalogError::Parse {
            message: e.to_string(),
        })?;

        Ok(tracks
            .into_iter()
            .map(|t| Track {
                id: t.id,
                title: t.title,
                artist: t.artist_name,
                album: t.album_name.unwrap_or_default(),
                duration_secs: t.duration,
                duration: format_duration(t.duration),
                image: t.artwork.unwrap_or_default(),
                page_url: t.permalink_url.unwrap_or_default(),
                hq: true,
                plays: t.play_count.unwrap_or(0),
                has_lyrics: None,
                artist_ids: vec![t.artist_id],
                album_id: t.album_id.unwrap_or_default(),
                year: t.release_date.unwrap_or_default(),
                label: String::new(),
                language: String::new(),
                explicit: t.isrc.is_some(),
            })
            .collect())
    }

    async fn lyrics(&self, _id: &str) -> Result<String, CatalogError> {
        Err(CatalogError::NotSupported {
            feature: "lyrics".to_string(),
        })
    }

    async fn recommend(
        &self,
        _song: Option<&str>,
        _station: Option<&str>,
    ) -> Result<RadioPage, CatalogError> {
        // Audius doesn't have a radio/recommendation endpoint
        // Fall back to trending tracks
        let tracks = self.search_songs("", 20, 1).await?;
        Ok(RadioPage {
            tracks: tracks.tracks,
            station: None,
        })
    }

    async fn qualify_url(&self, _url: &str) -> Result<Probe, CatalogError> {
        // Audius streams are direct URLs without range support
        // Return a basic probe result
        Ok(Probe {
            range_status: crate::jiosaavn::RangeStatus::Unrestricted,
            content_length: None,
        })
    }
}

// ---------------------------------------------------------------------------
// Audius API types
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize)]
struct AudiusTrack {
    id: String,
    title: String,
    artist_id: String,
    artist_name: String,
    album_id: Option<String>,
    album_name: Option<String>,
    duration: u64,
    artwork: Option<String>,
    permalink_url: Option<String>,
    stream_url: Option<String>,
    play_count: Option<u64>,
    release_date: Option<String>,
    isrc: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct AudiusAlbum {
    id: String,
    album_name: String,
    artist_name: String,
    artwork: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct AudiusUser {
    id: String,
    name: String,
    profile_picture: Option<String>,
    is_verified: Option<bool>,
    follower_count: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
struct AudiusPlaylist {
    id: String,
    playlist_name: String,
    artwork: Option<String>,
    track_count: Option<u64>,
}

fn format_duration(secs: u64) -> String {
    let mins = secs / 60;
    let secs = secs % 60;
    format!("{}:{:02}", mins, secs)
}
